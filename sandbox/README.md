# opencode-sandbox

Run [OpenCode](https://opencode.ai) tasks in hardened, ephemeral Docker containers.
A host-side OpenCode agent (or a human) orchestrates tasks; each task runs in its
own throwaway container with no access to host files — input only via `--copy-in`,
output always to a fixed, human-set host prefix (`SANDBOX_OUT_ROOT`) — and all
internet traffic funneled through a logging proxy.

## Architecture

```
host
├── NInfer → 127.0.0.1:18089 (localhost-only) ──┐
├── llama.cpp → :8080 (published, 0.0.0.0)      │
└── docker daemon                                 │
    ├── model-relay-<net>  host netns, binds ONLY the bridge's own gateway
    │                       <gateway>:18090 → 127.0.0.1:18089,
    │                       addressed as `model-relay` (static hosts entry)
    └── network "opencode-sandbox-net"
        ├── proxy-<runid>    tinyproxy :8888 (non-root), LOGS + ENFORCES egress
        │                     (dual-homed: internal side + egress side)
        └── sandbox-<runid>  OpenCode (non-root, read-only rootfs, capped)
```

Per task:

1. `run.sh` builds images (first run), creates the network, starts a proxy and
   ensures the model relay is up (see below).
2. The sandbox container is created (read-only rootfs, tmpfs for `/workspace`,
   state and caches). Your OpenCode config is rewritten
   (`127.0.0.1:18089` → `model-relay:18090`) and seeded into the
   container over the exec channel; requested files are streamed into
   `/workspace` the same way (`docker cp` cannot see mount content on this
   daemon, so all transfer uses `docker exec` stdio).
3. Inside: `opencode run --standalone --auto --format json "<prompt>"`.
4. Deliverables (whatever the agent wrote to `/workspace/out`) are on the host
   prefix; `runs/<run-id>/` holds the rest, and the containers are removed.

## Model relay

NInfer listens on host localhost only, which bridge containers cannot reach.
`run.sh` therefore maintains one `model-relay-<net>` container per sandbox
network: a stdlib-only python forwarder (`relay/forward.py`) in the host
network namespace, bound **only** to that bridge's gateway IP, forwarding
`<gateway>:18090` → `127.0.0.1:18089`. It is read-only, capability-dropped,
has no shell access, and forwards a single fixed destination — the only thing
it can ever do is relay model API traffic from that bridge. It persists across
tasks (started on demand); `./run.sh clean` removes it.

## Security model

- **Host access is input-only plus a fixed output prefix.** Files enter via
  `--copy-in`; everything the sandbox writes to `/workspace/out` lands in
  `SANDBOX_OUT_ROOT/<run-id>/` on the host (default `~/.sandbox`). That mount is
  **rw**, so the untrusted agent can write/overwrite/delete anything under the
  prefix — but the path is fixed by the human, never chosen by the task caller
  (see *Host output* below).
- **Egress is enforced and audited.** The sandbox network is `--internal`, so
  containers have no route to the internet at all. The only way out is the
  dual-homed tinyproxy (internal side toward the sandbox, egress side to the
  internet) — traffic that ignores the proxy simply fails rather than leaking
  unlogged. The proxy runs as the image's **non-root `tinyproxy` user**
  (`--user`; `CAP_SETUID` is dropped, so it cannot drop privileges itself).
  Every request is logged to `runs/<run-id>/proxy.log`. Add `Filter`
  rules in `proxy/tinyproxy.conf.in` to block specific domains.
- **`--sealed`** drops the proxy entirely: internal network only, zero egress
  (the model relay still works, since it is on the bridge's own gateway).
- **Nothing in the container can become root.** The worker image ends in
  `USER sandbox` (uid 1000), carries no `sudo` package and **no setuid
  binaries**, and runs with `--read-only` rootfs, `--cap-drop=ALL`,
  `--security-opt no-new-privileges`, `--pids-limit=256`, `--shm-size=512m`,
  CPU/memory caps, no docker.sock, no devices, and a hard timeout. Verify from
  inside: `id` (uid 1000), `grep CapEff /proc/self/status` (all zeroes),
  `touch /x` (*read-only file system*).
- Writable tmpfs areas (`/tmp`, `/workspace`, `~/.cache`, …) are mounted
  **`exec`**: required because bun/OpenTUI `dlopen`s a native library from
  `/tmp` (the TUI fails with *"failed to map segment from shared object"* under
  the default `noexec`), and because build outputs in `/workspace` must be
  runnable. `noexec` inside the container buys nothing — the container is the
  boundary. They are **size-capped** (`SANDBOX_TMP_SIZE`, default 4g;
  `SANDBOX_WORKSPACE_SIZE`, 16g; `SANDBOX_HOME_TMPFS_SIZE`, 1g per state dir)
  because tmpfs pages are host RAM and Docker does **not** charge them to
  `--memory`: without a cap a single runaway download could exhaust the host.
- The sandbox user is non-root: no `dnf`, no system writes. Tooling is
  preinstalled (git, ripgrep, python3, nodejs, jq, …); user-level installs work
  (`pip install --user`, `npm install --prefix`).
- Caveat — **container-grade isolation, not VM-grade.** Containers share the
  host kernel, and this setup uses no user-namespace remapping and no
  SELinux/AppArmor confinement (Docker's seccomp `builtin` profile is the only
  sandboxing layer). A kernel or runtime exploit escapes to the real host as
  uid 1000. Treat the sandbox as untrusted code with a strong container
  boundary: keep the output prefix a scratch dir, never point `COPY_IN` at
  secrets, and consider `userns-remap`/rootless Docker for stronger separation.
- **Host services are fenced off.** Sandbox containers sit on an `--internal`
  bridge whose gateway *is* the host, so without a guard anything bound to
  `0.0.0.0` (or the bridge IP) is reachable from the sandbox, bypassing the
  proxy and the `proxy.log`. That traffic is local delivery, so it is filtered
  in the host **`INPUT`** path — `DOCKER-USER`/`FORWARD` never sees it. The
  guard installs a firewalld policy (`ingress=docker`, `egress=HOST`,
  `target=DROP`) that permits only the model-relay port (`18090`) and drops the
  rest; `egress=HOST` matches only traffic terminating on the host, so
  container→internet forwarding through the proxy is untouched. Install it once
  (root): `sudo sandbox/host-firewall.sh install-unit`; verify with
  `sandbox/host-firewall.sh status`. `run.sh` warns when it is missing, and
  `SANDBOX_REQUIRE_FW_CHECK=1` turns that warning into a hard error. The policy
  covers the whole `docker` zone: the sandbox is the untrusted party and the
  other containers are deterministic. Keep model servers on `127.0.0.1`
  regardless.
- Caveat: egress *is* enforced (an internal network plus a dual-homed proxy),
  so nothing leaves unlogged. But the proxy is still an allowed channel: a
  malicious task can deliberately exfiltrate data by POSTing it through the
  proxy to an allowed domain — that traffic is recorded in `proxy.log` (which
  is why you audit it) but not prevented. Use `--sealed` for untrusted input.

## Host output (`SANDBOX_OUT_ROOT`) — always on

`/workspace/out` is **always** a real host directory: every run bind-mounts
`SANDBOX_OUT_ROOT/<run-id>/` **rw** at `/workspace/out`. Whatever the sandbox
writes as its deliverable is thus on the host immediately, owned by you
(uid 1000) — there is no `runs/<run-id>/out` copy, and nothing is lost when the
container is removed.

- The prefix root is **fixed by the human only**, via `SANDBOX_OUT_ROOT`
  (default `~/.sandbox`). A task caller cannot choose it.
- The interactive session writes to `SANDBOX_OUT_ROOT/session/`.
- If the root cannot be created (e.g. `$HOME`'s own root is read-only in the
  OpenCode agent shell), `run.sh` warns and falls back to `runs/host/` — still a
  fixed prefix, just inside this repo. Set `SANDBOX_OUT_ROOT` to pin it.
- `run.sh` refuses dangerous roots (`/`, `/home`, `/etc`, `/usr`, `/var`,
  `/boot`, `/root`, `/proc`, `/sys`, `/dev`, `/run`, and `$HOME` itself).

Because it is a **real rw host mount**, the untrusted sandbox can
write/overwrite/delete anything under that prefix (no overwrite protection and
no disk quota). Symlinks cannot escape it (the container has its own mount
namespace), but keep the root a dedicated scratch location, not a precious tree.

```bash
# default prefix: ~/.sandbox/<run-id>/
opencode-sb task --prompt "fetch the data and write /workspace/out/report.csv"
ls ~/.sandbox/run-*/report.csv         # written by the sandbox, owned by you

# override the prefix (human-only, via the environment)
SANDBOX_OUT_ROOT=/tmp/sbx opencode-sb task --prompt "…"
```

## Following a run

`task` can stream the agent's work, and a run can be attached to after the fact:

- **Live transcript (human).** On a terminal, `task` relays a compact view —
  assistant messages and each tool call — as the agent works, while the raw JSON
  event stream is still written verbatim to `runs/<run-id>/result.json`. Toggle
  with `--follow` / `--no-follow` (default: on when stderr is a TTY).
- **Detach, then attach.** `task --detach` returns immediately with the run id;
  follow it later with `opencode-sb watch <run-id>` (full, live). Good for long
  runs and for a human who wants their terminal back.
- **Peek (bounded).** `opencode-sb peek [<run-id>] [-n N]` prints the run status
  and only the **last N messages** (default 12, each line truncated) — no live
  following, no unbounded output. This is what a **host agent** should use to
  check a run without flooding its own context.

```bash
runid=$(opencode-sb task --detach --prompt "…" 2>/dev/null | awk '/^run /{print $2}')

opencode-sb peek "$runid"      # snapshot: status + last 12 messages
opencode-sb peek -n 4          # newest running run, last 4 messages
opencode-sb watch "$runid"     # (human) full live transcript until it ends
```

`watch` and `peek` auto-pick the newest **running** run when no id is given
(e.g. `opencode-sb peek` while a detached run is in flight). When a run
finishes, `run.sh` writes its exit code to `runs/<run-id>/exit`; that marker is
how both followers know to stop.

## Following a session

The long-lived **session** (`opencode-sb`, the TUI) has no `result.json`; its
history lives in the container's SQLite store. Both views read that store
directly, so they work while the TUI is open in another terminal:

- **Live (human).** `opencode-sb watch --session` follows the active session.
  Attaching shows only what happens *next* (no history dump); if a newer session
  becomes active — e.g. an `opencode-sb run` starts one — it switches and prints
  that one from the start. Assistant text streams as it is generated.
  `--from-start` replays the whole current session instead.
- **Bounded (host agent).** `opencode-sb peek --session [-n N] [<session-id>]`
  prints the session title and only the last N parts (default 12, each
  truncated) — use this from the host agent.
- **Pick a session.** `opencode-sb sessions` lists recent sessions (id, message
  count, age, title); pass an id to narrow either view.

```bash
opencode-sb sessions            # id, msgs, age, title
opencode-sb peek --session      # newest session, last 12 parts
opencode-sb watch --session     # (human) live; ctrl-c to stop
```

## Global CLI

`opencode-sandboxed` is the single entry point and is installable globally
(symlinked into a PATH bin dir, same pattern as `nb` → `notebook`). The short
alias `opencode-sb` is installed alongside it.

```bash
cd /home/rafael.franca/Projetos/My/agent-toolbelt/sandbox
./install.sh                 # symlinks ~/.local/bin/{opencode-sandboxed,opencode-sb}
./install.sh --bin ~/bin     # or another bin dir
./install.sh --uninstall
```

It resolves symlinks, so it works from any directory:

| Command | Does |
|---|---|
| `opencode-sb` | OpenCode TUI inside a session container (auto-starts it) |
| `opencode-sb run "msg"` | one-shot message in the session, JSON reply |
| `opencode-sb task …` | one-shot sandboxed task (same flags as `run.sh task`) |
| `opencode-sb watch [RUN-ID]` | follow a run's full live transcript (human) |
| `opencode-sb peek [RUN-ID] [-n N]` | bounded snapshot: status + last N messages |
| `opencode-sb watch --session` | follow the active session live (human) |
| `opencode-sb peek --session [-n N]` | bounded snapshot of the active session |
| `opencode-sb sessions` | list recent sessions (id, messages, age, title) |
| `opencode-sb status` | session / proxy / relay state |
| `opencode-sb logs [RUN-ID]` | follow the session egress log, or print a run's log |
| `opencode-sb up` / `down` | start / stop the session container |
| `opencode-sb models [--check]` | list the sandbox model catalog (`--check` validates refs) |
| `opencode-sb clean` | remove orphaned sandbox/proxy/relay containers |

`task` and `clean` exec `run.sh` directly, so exit codes propagate.

## Session lifecycle

`opencode-sb` and `opencode-sb run` reuse one long-lived session container
(`opencode-sandbox-session`). `opencode-sb up` is idempotent:

- **running** — reused as-is; the proxy and relay are re-checked, and the
  seeded config and skills are re-written if they went missing.
- **stopped or absent** (e.g. after a reboot, which stops containers but does
  not remove them) — the container is **removed and recreated**, because a
  stopped container has already lost its tmpfs state (seeded config,
  workspace) and may carry stale gateway bindings from before the reboot.

So after a reboot, just run `opencode-sb` again — no manual cleanup needed.

## Quick start

```bash
cd /home/rafael.franca/Projetos/My/agent-toolbelt/sandbox

# One-time (root): stop sandbox containers from reaching host services through
# the bridge gateway. Without it they can reach anything bound to 0.0.0.0.
sudo ./host-firewall.sh install-unit
./host-firewall.sh status          # read-only, no root

# One-shot task, from anywhere once installed (builds images on first run)
opencode-sb task \
  --model llama.cpp/qwen3.8-gguf-max \
  --prompt "Write the word OK to /workspace/out/status.txt"

# Task with input files, sealed (no internet)
opencode-sb task --sealed --copy-in ./my-dir --prompt "refactor X, put result in /workspace/out"

# Interactive session
opencode-sb                  # OpenCode TUI inside the sandbox
opencode-sb run "explain this codebase"
opencode-sb status
opencode-sb logs             # follow the session egress log
opencode-sb down

# Inspect a finished run
cat runs/<run-id>/result.json
cat runs/<run-id>/hostout            # path of the host output dir
ls  "$(cat runs/<run-id>/hostout)"   # deliverables, written by the sandbox
opencode-sb logs <run-id>            # or: ./run.sh logs <run-id>

opencode-sb clean            # remove orphaned containers
```

## Tools in the image

The worker is not just OpenCode: it carries a small offline tool set so the
sandboxed agent can do what a plain HTTP fetch cannot.

| Command | What it is |
|---|---|
| `webpage text\|dom\|shot\|pdf URL …` | headless Chromium (JavaScript on, proxy-aware) |
| `ps4 check\|run PATH …` | shadPS4 on Xvfb + Mesa software Vulkan (lavapipe) |
| `7z`/`7za`, `Xvfb`, `xwd`, `pnmtopng` | the pieces the two wrappers build on |

**`webpage`** renders one URL per call and prints the DOM/text or writes a
PNG/PDF: `--wait MS` is the virtual time budget for scripts (default 3000).
Chromium ignores `HTTP(S)_PROXY`, so the wrapper passes `--proxy-server` from
`HTTPS_PROXY` itself; under `--sealed` only `data:`/`file:` URLs work.

**`ps4`** boots a game folder, `eboot.bin`, `.iso` (extracted with 7z) or
`.pkg` with no GPU and no display. It starts Xvfb, runs shadPS4 against
lavapipe, stops after `--timeout` (default 180s) and writes the emulator log
plus a screenshot to `/workspace/out`. PS4 firmware/system modules are **not**
bundled, so most commercial games stop early — report the log, not a verdict.

Both are documented to the sandbox agent by the skills in `skills/` here
(`webpage`, `ps4`). They are streamed into
`/home/sandbox/.config/opencode/skills/` for every task and session; the
generated config opens the `skill` permission because the host config denies
all skills except its own allowlist, and no host skill is copied in.

Web search also needs one line of state: OpenCode stores its provider choice
in SQLite (`websearch:provider`, e.g. `"random"`). A fresh sandbox DB has no
such row, so `websearch` fails with `Web search cancelled`. `run.sh` copies
the value from the host DB (override with `SANDBOX_WEBSEARCH_PROVIDER`,
default `random`) after OpenCode creates its database.

## Models

Model references come from your host OpenCode config
(`~/.config/opencode/opencode.jsonc`, override with `OPENCODE_HOST_CONFIG`),
plus the built-in `opencode/*` provider (free models — no auth).

**Prefer the free provider; fall back to local.** Pick per task:

| Task | Reference |
|---|---|
| Default / most tasks | `opencode/deepseek-v4.1-flash-free` (free; needs egress) |
| Large context (long inputs/diffs/files) | `llama.cpp/qwen3.8-gguf-single192` (Single 192K MTP) |
| Task fans out to parallel agents | `llama.cpp/qwen3.8-gguf-duo128` (2x128K) or `llama.cpp/qwen3.8-gguf-quad` (4x64K) |

Other local refs from the host config: `llama.cpp/qwen3.8-gguf-max` (Single
256K) and `ninfer/qwen3.8-27b-64k/128k/192k/256k`.

`--model` overrides the default. When it is omitted, `run.sh` resolves a
**mode-aware default** from `models.conf`: the free model for online runs, and
`llama.cpp/qwen3.8-gguf-single192` for `--sealed` (free models need internet, so
they cannot run sealed).

The catalog is bundled in the OpenCode version and **changes between releases**
(models are added, renamed and retired). Check what the sandbox actually sees:

```bash
opencode-sb models            # list the catalog as the sandbox sees it
opencode-sb models --check    # validate the preferred refs (exit != 0 if gone)
```

## Artifacts (`runs/<run-id>/`)

| File | Content |
|---|---|
| `result.json` | `opencode run --format json` output (answer, usage, status) |
| `stderr.log` | OpenCode stderr/log output |
| `proxy.conf` | the tinyproxy config used (subnet allow-list) |
| `proxy.log` | every request the task made through the proxy |
| `hostout` | path of the host output dir for this run (`SANDBOX_OUT_ROOT/<run-id>`) |
| `exit` | the run's exit code, written last when it finishes (watchers stop on it) |

Exit code: `0` success, `124` timeout, other = task failed.

## Limits and environment

| Variable / flag | Default | Meaning |
|---|---|---|
| `CPUS` / `--cpus` | `4` | CPU limit |
| `MEM` / `--mem` | `8g` | memory limit |
| `TIMEOUT` / `--timeout` | `1800` | hard timeout in seconds |
| `SANDBOX_TMP_SIZE` | `4g` | cap for `/tmp` (tmpfs, host RAM, not charged to `--memory`) |
| `SANDBOX_WORKSPACE_SIZE` | `16g` | cap for `/workspace` (same caveat) |
| `SANDBOX_HOME_TMPFS_SIZE` | `1g` | cap per state dir (`~/.cache`, `~/.local`, `~/.npm`, `~/.bun`, `~/.config`) |
| `SANDBOX_WEBSEARCH_PROVIDER` | host value / `random` | websearch provider seeded into the sandbox DB |
| `OPENCODE_HOST_CONFIG` | `~/.config/opencode/opencode.jsonc` | base config for the sandbox |
| `SANDBOX_OUT_ROOT` | `~/.sandbox` | fixed host output prefix (`<root>/<run-id>`; fallback `runs/host` if uncreatable) |

## Layout

```
Dockerfile            worker image (fedora:44 + OpenCode; latest, or pinned via
                      --build-arg OPENCODE_VERSION=…)
bin/webpage           headless-Chromium wrapper (JS-capable page read/shot/pdf)
bin/ps4               shadPS4 wrapper (Xvfb + lavapipe, ISO extraction, shot/log)
skills/<id>/SKILL.md  container-side skills (webpage, ps4) seeded per task/session
proxy/Dockerfile      tinyproxy logging proxy image
proxy/tinyproxy.conf.in  proxy config template ({{SUBNET}} allow-list)
relay/forward.py      localhost model relay (stdlib-only TCP forwarder)
models.conf           model preference lists (free / local-large / local-parallel)
run.sh                orchestrator engine (task / up / down / logs / models / clean)
host-firewall.sh      root helper: firewalld policy fencing containers off from
                      host services (apply / remove / status / install-unit)
opencode-sandboxed    global CLI (tui / run / task / up / down / status / logs / models / clean)
install.sh            installs the CLI symlinks (opencode-sandboxed, opencode-sb)
ORCHESTRATION.md      playbook for a host agent that delegates to this sandbox
runs/                 per-run artifacts (gitignored)
```

This directory is `sandbox/` inside the `agent-toolbelt` repo.

## Environment notes

- `DOCKER_HOST` must point at the machine daemon. From a normal host terminal
  this is already the case; from a sandboxed shell export first:
  `export DOCKER_HOST=unix:///var/run/docker.sock`
- The proxy conf bind-mount must live under `runs/`, because only repo paths
  are guaranteed visible to the daemon — never `/tmp`. All other file
  transfer uses `docker exec` stdio streaming.

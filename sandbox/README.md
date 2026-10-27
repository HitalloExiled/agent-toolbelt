# opencode-sandbox

Run [OpenCode](https://opencode.ai) tasks in hardened, ephemeral Docker containers.
A host-side OpenCode agent (or a human) orchestrates tasks; each task runs in its
own throwaway container with no access to host files — input only via `--copy-in`,
output always to a fixed, human-set host prefix (`SANDBOX_OUT_ROOT`) — and all
internet traffic funneled through a logging proxy.

The **agent-facing playbook** (when to delegate, how to write the brief, peek vs
watch, steering) lives in `../skills/sandbox/SKILL.md`. This file is the human /
operations reference.

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
   (`127.0.0.1:18089` → `model-relay:18090`) and seeded into the container over
   the exec channel; requested files are streamed into `/workspace` the same way
   (`docker cp` cannot see mount content on this daemon, so all transfer uses
   `docker exec` stdio).
3. Inside: `opencode run --auto --format json "<prompt>"` — on the container's
   background service, so a running turn is steerable (`steer --run <run-id>`).
4. The task's answer comes back as the final text in `result.json`;
   `/workspace/out` is the **user's** artifact drop (downloads, builds,
   screenshots), not a channel back to the host agent. `runs/<run-id>/` keeps
   the run metadata, and the containers are removed.

## Model relay

NInfer listens on host localhost only, which bridge containers cannot reach.
`run.sh` therefore maintains one `model-relay-<net>` container per sandbox
network: a stdlib-only python forwarder (`relay/forward.py`) in the host
network namespace, bound **only** to that bridge's gateway IP, forwarding
`<gateway>:18090` → `127.0.0.1:18089`. It is read-only, capability-dropped,
has no shell access, and forwards a single fixed destination. It persists across
tasks (started on demand); `./run.sh clean` removes it. The port is
`SANDBOX_RELAY_PORT` (default 18090) in both `run.sh` and `host-firewall.sh`.

## Security model

- **Host access is input-only plus a user artifact drop.** Files enter via
  `--copy-in`; files the *user* asked to collect are written to `/workspace/out`,
  which lands in `SANDBOX_OUT_ROOT/<run-id>/` on the host (default `~/.sandbox`).
  That mount is **rw**: the untrusted agent can write/overwrite/delete anything
  under the prefix — but the path is fixed by the human, never by the caller.
  It is **not** a communication channel; the answer is the final text.
- **Egress is enforced and audited.** The sandbox network is `--internal`, so
  containers have no route to the internet at all. The only way out is the
  dual-homed tinyproxy (internal side toward the sandbox, egress side to the
  internet) — traffic that ignores the proxy simply fails rather than leaking
  unlogged. The proxy runs as the image's **non-root `tinyproxy` user**. Every
  request is logged to `runs/<run-id>/proxy.log`. Add `Filter` rules in
  `proxy/tinyproxy.conf.in` to block specific domains.
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
  `/tmp`, and because build outputs in `/workspace` must be runnable. They are
  **size-capped** (`SANDBOX_TMP_SIZE` 4g, `SANDBOX_WORKSPACE_SIZE` 16g,
  `SANDBOX_HOME_TMPFS_SIZE` 1g per state dir) because tmpfs pages are host RAM
  and Docker does **not** charge them to `--memory`.
- The sandbox user is non-root: no `dnf`, no system writes. Tooling is
  preinstalled (git, ripgrep, python3, nodejs, jq, …); user-level installs work
  (`pip install --user`, `npm install --prefix`).
- Caveat — **container-grade isolation, not VM-grade.** Containers share the
  host kernel, and this setup uses no user-namespace remapping and no
  SELinux/AppArmor confinement. A kernel or runtime exploit escapes as uid 1000.
  Keep the output prefix a scratch dir, never point `COPY_IN` at secrets, and
  consider `userns-remap`/rootless Docker for stronger separation.
- **Host services are fenced off.** Sandbox containers sit on an `--internal`
  bridge whose gateway *is* the host, so anything bound to `0.0.0.0` (or the
  bridge IP) would be reachable, bypassing the proxy and `proxy.log`. That
  traffic is local delivery, so it is filtered in the host **`INPUT`** path —
  `DOCKER-USER`/`FORWARD` never sees it. `host-firewall.sh install-unit` (run by
  the repo's `setup.sh`) installs a firewalld policy (`ingress=docker`,
  `egress=HOST`, `target=DROP`) that permits only the relay port. Without
  firewalld it falls back to scoped iptables rules. Check it root-free with
  `./host-firewall.sh check` / `status`; `run.sh` warns when it is missing
  (`SANDBOX_REQUIRE_FW_CHECK=1` makes that fatal).
- Caveat: egress *is* enforced, but the proxy is still an allowed channel: a
  malicious task can deliberately exfiltrate by POSTing through the proxy to an
  allowed domain — recorded in `proxy.log` (which is why you audit it) but not
  prevented. Use `--sealed` for untrusted input.

## User artifact drop (`SANDBOX_OUT_ROOT`)

`/workspace/out` is **always** a real host directory: every run bind-mounts
`SANDBOX_OUT_ROOT/<run-id>/` **rw** at `/workspace/out` (the session uses
`SANDBOX_OUT_ROOT/session/`). Files the *user* asked to collect appear there
immediately, owned by them (uid 1000), and nothing is lost when the container is
removed.

The prefix root is **fixed by the human only**, via `SANDBOX_OUT_ROOT` (default
`~/.sandbox`); a task caller cannot choose it. If the root cannot be created,
`run.sh` warns and falls back to `runs/host/`. It refuses dangerous roots (`/`,
`/home`, `/etc`, `/usr`, `/var`, `/boot`, `/root`, `/proc`, `/sys`, `/dev`,
`/run`, and `$HOME` itself).

Because it is a **real rw host mount**, keep it a dedicated scratch location,
not a precious tree.

```bash
opencode-sb task --prompt "Download the ISO to /workspace/out/image.iso and reply with its sha256."
ls ~/.sandbox/run-*/image.iso   # human collects it
```

## CLI

`opencode-sandboxed` is the entry point; `opencode-sb` is the alias. Run
`../setup.sh` (or `./setup.sh` here) to link both into `~/.local/bin`.

| Command | Does |
|---|---|
| `opencode-sb` | OpenCode TUI inside a session container (auto-starts it) |
| `opencode-sb run "msg"` | one-shot message in the session; streams JSON events |
| `opencode-sb task …` | one-shot sandboxed task (same flags as `run.sh task`) |
| `opencode-sb steer "msg"` | steer a running turn: inject (default), `--queue`, `--interrupt`; `--run ID` for a task |
| `opencode-sb interrupt` | stop the active turn (`--session ID` / `--run ID` / `--resume`) |
| `opencode-sb watch [RUN-ID]` | follow a run's full live transcript (human) |
| `opencode-sb peek [RUN-ID] [-n N]` | bounded snapshot: status + last N messages |
| `opencode-sb watch --session` | follow the active session live (human) |
| `opencode-sb peek --session [-n N]` | bounded snapshot of the active session |
| `opencode-sb sessions` | list recent sessions (id, messages, age, title, `running`/`idle`) |
| `opencode-sb status` | session / proxy / relay + active turn (`running`/`idle`) |
| `opencode-sb logs [RUN-ID]` | follow the session egress log, or print a run's log |
| `opencode-sb up` / `down` | start / stop the session container |
| `opencode-sb models [--check]` | list the sandbox model catalog (`--check` validates refs) |
| `opencode-sb clean` | remove orphaned sandbox/proxy/relay containers |

`task` and `clean` exec `run.sh` directly, so exit codes propagate.

## Runs and sessions

- **Runs.** `task` blocks and returns the exit code (`0` success, `124` timeout,
  other = failure). `--detach` returns the run id immediately; follow it with
  `watch <run-id>` (human) or `peek` (bounded). `run.sh` writes
  `runs/<run-id>/exit` when the run ends.
- **Session.** `opencode-sb` and `opencode-sb run` reuse one long-lived
  container (`opencode-sandbox-session`). `up` is idempotent: a running session
  is reused (proxy/relay re-checked, config re-seeded if missing); a stopped one
  is removed and recreated, because a stopped container has already lost its
  tmpfs state. After a reboot, just run `opencode-sb` again.
- **Steering.** A running turn is a live process: use `steer` instead of
  launching a second task. Details and the agent-facing rules are in the skill.

## Quick start

```bash
cd /home/rafael.franca/Projetos/My/opencode-tools
./setup.sh                       # links, daemon, firewall guard, images, smoke

opencode-sb task \
  --model llama.cpp/qwen3.8-gguf-max \
  --prompt "Reply with exactly: OK"

opencode-sb task --sealed --copy-in ./my-dir \
  --prompt "Refactor X as described; reply with a unified diff."

opencode-sb                       # interactive session
opencode-sb status
opencode-sb down
opencode-sb clean                 # remove orphaned containers
```

## Tools in the image

| Command | What it is |
|---|---|
| `webpage text\|dom\|shot\|pdf URL …` | headless Chromium (JavaScript on, proxy-aware) |
| `ps4 check\|run PATH …` | shadPS4 on Xvfb + Mesa software Vulkan (lavapipe) |
| `7z`/`7za`, `Xvfb`, `xwd`, `pnmtopng` | the pieces the two wrappers build on |

Both are documented to the sandbox agent by the skills in `skills/` here
(`webpage`, `ps4`), streamed into the container for every task and session.

Web search needs one row of state: OpenCode stores its provider choice in SQLite
(`websearch:provider`, e.g. `"random"`). `run.sh` seeds it from the host DB
(override with `SANDBOX_WEBSEARCH_PROVIDER`).

## Models

`sandbox/models.conf` is the single source: ordered preference lists (free
first, local fallback) and the mode-aware default (free online,
`llama.cpp/qwen3.8-gguf-single192` for `--sealed`). The catalog is bundled in
OpenCode and changes between releases:

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
| `hostout` | path of the user's artifact drop for this run; never read it |
| `exit` | the run's exit code, written last when it finishes |

## Limits and environment

| Variable / flag | Default | Meaning |
|---|---|---|
| `CPUS` / `--cpus` | `4` | CPU limit |
| `MEM` / `--mem` | `8g` | memory limit |
| `TIMEOUT` / `--timeout` | `1800` | hard timeout in seconds |
| `SANDBOX_TMP_SIZE` | `4g` | cap for `/tmp` (tmpfs, host RAM) |
| `SANDBOX_WORKSPACE_SIZE` | `16g` | cap for `/workspace` (same caveat) |
| `SANDBOX_HOME_TMPFS_SIZE` | `1g` | cap per state dir (`~/.cache`, `~/.local`, …) |
| `SANDBOX_RELAY_PORT` | `18090` | model-relay port (run.sh + firewall guard) |
| `SANDBOX_WEBSEARCH_PROVIDER` | host value / `random` | websearch provider seeded into the sandbox DB |
| `OPENCODE_HOST_CONFIG` | `~/.config/opencode/opencode.jsonc` | base config for the sandbox |
| `SANDBOX_OUT_ROOT` | `~/.sandbox` | fixed user artifact prefix |

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
run.sh                orchestrator engine
host-firewall.sh      root helper: firewalld/iptables guard (apply/remove/check/
                      selftest/status/install-unit)
journal.py            transcript renderer for runs (host) and sessions (container)
opencode-sandboxed    global CLI (tui/run/steer/interrupt/task/up/down/status/logs/models/clean)
setup.sh              links the CLI symlinks (opencode-sandboxed, opencode-sb)
runs/                 per-run artifacts (gitignored)
```

## Environment notes

- `DOCKER_HOST` must point at the machine daemon. From a normal host terminal
  this is already the case; from a sandboxed shell export first:
  `export DOCKER_HOST=unix:///var/run/docker.sock`
- **SELinux `nnp_transition` alerts.** A shell running with `NoNewPrivs=1`
  (the OpenCode agent shell does) makes every `docker` call log an
  `avc: denied { nnp_transition }` against `container_runtime_t`: NoNewPrivs
  forbids the SELinux domain transition, but the command still runs (in
  `unconfined_t`). It is audit noise, not a failure, and no policy can override
  NNP. Run `./setup.sh` / `opencode-sb` from a normal terminal to avoid it.
- The proxy conf bind-mount must live under `runs/`, because only repo paths
  are guaranteed visible to the daemon — never `/tmp`. All other file
  transfer uses `docker exec` stdio streaming.

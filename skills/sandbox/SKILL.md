---
name: sandbox
description: Disposable Docker sandbox that runs a separate OpenCode agent for risky work. Use ALWAYS before anything that could damage or expose this machine, such as installing or upgrading packages, touching services, kernel, /etc, disks or permissions, running untrusted code or dependencies, destructive or uncertain commands, processing potentially malicious files, or consulting dubious internet sources. The sandbox cannot see host files (input only via copy_in), returns files only from /workspace/out under a fixed host prefix, and its internet is logged or cut with sealed. Drive it with sandbox_run/sandbox_steer/sandbox_peek/sandbox_logs/sandbox_status or the opencode-sb CLI. When a run is already in progress, steer it with sandbox_steer instead of starting another run. Skip for quick read-only questions you answer locally.
metadata:
  audience: any
  opencode/slash: "true"
---

# Sandbox: a disposable agent for risky work

This page assumes you have never used the sandbox. Read it once; after that use
the checklists.

## 1. What it is

The sandbox is **a second OpenCode agent, running inside a throwaway Docker
container on this machine**. You give it a task in plain language. It plans,
runs commands, edits files and browses the web **inside the container**, then
returns a final answer plus whatever it wrote to `/workspace/out`.

It is not a shell on your machine and it cannot see your files:

| It can | It cannot |
|---|---|
| read files you explicitly `copy_in` (they appear at `/workspace/<name>`) | read any other host file |
| write to `/workspace/out` (returned to the host) | write anywhere else on the host |
| reach the internet through a logging proxy, or not at all with `sealed` | reach host services, the Docker socket, or the LAN |
| run commands as uid 1000 inside the container | gain root, mount filesystems, load modules, use setuid binaries |

The container has a read-only root filesystem, no Linux capabilities,
`no-new-privileges`, a masked `/proc`, and CPU/memory/pids limits. Its only
writable host surface is `/workspace/out`, mapped to
`SANDBOX_OUT_ROOT/<run-id>/` (default `~/.sandbox/<run-id>/`). The human sets
that prefix; you cannot choose it.

**Isolation is container-grade, not VM-grade.** It shares the host kernel. Do
not paste secrets, tokens or private keys into a prompt or `copy_in`.

The image also carries two tools, documented by container-side skills seeded for
every run:
- **`webpage`** — headless Chromium: renders JS-gated pages, dumps DOM/text,
  screenshots/PDF. If a page only works with JS, ask for `webpage`; do not
  conclude it is unreachable from `curl`.
- **`ps4`** — shadPS4 under Xvfb + software Vulkan: boots a PS4 folder/ISO
  headlessly, logs, screenshots. Firmware is not bundled.

## 2. When to use it (and when not)

Use it when the work is **risky, dirty, or unknown**:

- installing/upgrading packages, or touching services, kernel, `/etc`, disks,
  permissions;
- running code, scripts, installers, binaries or dependencies you do not trust;
- destructive or uncertain commands you want to try before the real machine;
- opening potentially malicious files, archives, documents or URLs;
- needing a clean throwaway environment with no host state;
- long, noisy work whose transcript you do not want in your own context.

Do **not** use it for:

- quick read-only questions about docs or this repo — answer directly;
- work that must read/write host files outside the fixed output dir — tell the
  user; input is `copy_in`-only by design;
- anything needing a secret you would not hand to an untrusted process.

## 3. Two modes

| | **task** (one-shot) | **session** (long-lived) |
|---|---|---|
| lifetime | container created, used, destroyed | container stays until `down` |
| state | fresh `/workspace` every run | `/workspace`, history and DB persist |
| best for | isolated jobs: "run this, give me the result" | iterative work, follow-ups, steering |
| steerable | yes, while it runs (by run id) | yes, whenever it runs |
| how | `sandbox_run` (blocking) or `opencode-sb task` | `opencode-sb up` + `opencode-sb run` |

Rule of thumb: **one-shot job → `task`; a conversation or work you may need to
correct → `session`.** A blocking `sandbox_run` cannot be steered while you are
waiting on it, so for work that may need course correction start it detached
(`opencode-sb task --detach`) or use the session.

## 4. The tools (prefer these)

| Tool | What it does | Main inputs | What you get |
|---|---|---|---|
| `sandbox_run` | runs a **one-shot task** and waits | `prompt`, `copy_in[]`, `model`, `sealed`, `timeout`, `cpus`, `mem`, `title` | final answer, exit code, artifacts dir |
| `sandbox_steer` | sends a message into a **running** turn | `message`, `delivery`, `interrupt`, `session`, `run_id` | delivery report |
| `sandbox_peek` | bounded snapshot of a run/session | `run_id`, `session`, `lines` | status + last N parts |
| `sandbox_logs` | shows the egress audit of a run | `run_id` | `proxy.log` |
| `sandbox_status` | container state + active turn | — | session/proxy/relay, `running`/`idle` |

The CLI does the same thing and adds detach, sessions and cleanup:

```bash
opencode-sb task --prompt "..." [--copy-in PATH]... [--model REF] [--sealed] \
                 [--timeout 1800] [--detach]
opencode-sb up | down | status | sessions | run "msg" | steer "msg" | interrupt
opencode-sb peek [RUN-ID] [-n N] | peek --session [-n N] [SID]
opencode-sb logs [RUN-ID] | models [--check] | clean
```

`opencode-sb` is an alias of `opencode-sandboxed`. `opencode-sb help` lists
everything.

## 5. Your first run, step by step

1. **Pick a mode** (section 3). For a quick isolated job, use `sandbox_run`.
2. **Write a self-contained prompt** (section 6). The agent starts with an empty
   `/workspace` and knows nothing about this machine.
3. **Run it.** `sandbox_run` blocks until the task ends or times out.
4. **Read the result.** The tool renders the final answer, the exit code and the
   path of the artifacts.
5. **Audit the network** with `sandbox_logs` before trusting the result
   (section 10). `sealed` runs have nothing to audit.
6. **Collect deliverables** from the reported `SANDBOX_OUT_ROOT/<run-id>/`.

A minimal call:

```text
sandbox_run(
  prompt: "Create /workspace/out/hello.txt containing 'hello'. Then reply DONE.",
  model: "opencode/deepseek-v4.1-flash-free",
  timeout: 300
)
```

Expected: answer `DONE`, exit `0`, one file in the artifacts dir.

## 6. Writing the prompt

The sandbox agent is competent but blind. Give it everything it needs:

- **State the goal and the definition of done.** "Validate the file, write a
  report, do not execute it."
- **Say where to write.** Anything not written under `/workspace/out/` is lost
  when the container dies. Ask for exact filenames.
- **Mention inputs.** `copy_in` files arrive at `/workspace/<basename>`; refer to
  them by that path, never by a host path.
- **Bound the work.** Time, scope, "do not install anything", "use only the
  local model", "stop after N attempts".
- **Ask for evidence.** "Include the commands you ran and their output."
- **Name a container skill when relevant.** "Use the `webpage` skill to render
  it" or "use the `ps4` skill".
- **Long prompts:** `--prompt-file file` or `--prompt-file -` (stdin).

Do not include host paths, hostnames, credentials or secrets. The sandbox cannot
use them, and they would land in its logs.

## 7. Watching progress — `peek`, never `watch`

A blocking `sandbox_run` gives you nothing until it ends. For long work, start
detached and poll a **bounded** snapshot:

```bash
runid=$(opencode-sb task --detach --prompt "…" 2>/dev/null | awk '/^run /{print $2}')
opencode-sb peek "$runid"        # status + last 12 parts (each truncated)
opencode-sb peek "$runid" -n 4   # tighter window
opencode-sb peek                 # newest running run, if you lost the id
```

`peek` returns a small fixed block: state (`running` + last-activity, or
`finished` + exit code), the last N messages, and the output files.

Never pull a full transcript into your context. `opencode-sb watch <run-id>` and
`tail result.json` are unbounded and **for the human only**.

## 8. Steering a running run — required

A delegated run is a **live process**, not a script you re-invoke. If it is
already running, **steer it; never start another one.** Re-issuing the prompt as
a new task duplicates work, loses the context the agent built, and can corrupt
shared output.

| You want to… | Do this |
|---|---|
| correct direction, add a constraint, answer a doubt | `sandbox_steer` (default: injected mid-turn) |
| add work for **after** the current turn | `sandbox_steer` with `delivery="queue"` |
| stop a wrong/looping approach and redirect | `sandbox_steer` with `interrupt=true` |
| just stop it | `opencode-sb interrupt [--session ID \| --run RUN-ID]` |
| see what it is doing | `sandbox_peek` / `opencode-sb peek --session` |

```bash
opencode-sb sessions                    # id, msgs, age, title + (running)/(idle)
opencode-sb steer "use the local model"                  # inject now
opencode-sb steer --queue "after that, run the tests"    # next turn
opencode-sb steer --interrupt "stop; revert the last edit"  # stop + redirect
opencode-sb steer --run run-20261020T… "use the mirror"  # a detached task
opencode-sb interrupt --session ses_…   # stop only
```

How to choose `delivery`:

- **`steer`** (default) — the message is injected into the turn in flight. Use it
  for corrections, constraints, answers, "don't do X".
- **`queue`** — parked until the current turn finishes, then runs. Use it to add
  follow-up work without derailing the current step.
- **`interrupt=true`** — stops the current step (e.g. a wrong `rm`, a loop) and
  lets the agent see your message immediately. Use it to redirect, not to
  punish: the agent keeps its context.

Target resolution: `--session` → the only running session → the only session at
all. If several sessions exist and none can be chosen unambiguously, it
**refuses** and prints them with `(running)`/`(idle)`; pick one. A task is
targeted with `--run <run-id>` / `run_id=`; it works while the container exists.

Steering goes host→container over `docker exec`, so it adds no network exposure
and **works in `--sealed`**. An idle session is a valid target: the message
starts a turn. After steering, poll `peek` — never `watch`.

**Limitation:** a blocking `sandbox_run` occupies you until it ends, so you
cannot steer it. If you expect to need course correction, use
`opencode-sb task --detach` (or the session), then `sandbox_steer` with the run
id.

## 9. The long-lived session (iterative work)

Use a session when you will send several messages or may need to steer:

```bash
opencode-sb up              # start the container (idempotent)
opencode-sb run "msg"       # one message; streams JSON events to stdout
opencode-sb peek --session  # bounded view (yours)
opencode-sb sessions        # all sessions + (running)/(idle)
opencode-sb steer "msg"     # correct the running turn
opencode-sb status          # containers + active turn
opencode-sb down            # destroy it (state is lost)
```

The session's `/workspace`, history and DB live until `down`. Deliverables from a
session land in `SANDBOX_OUT_ROOT/session/` (tasks use `<run-id>/`). `sessions`
shows `(running)` when a turn is in flight and `(idle)` otherwise; `status`
shows the active session id. Session turns use the container's background
service, which is what makes `steer`/`interrupt` possible.

## 10. Finishing: audit, artifacts, exit codes

Every run writes these under `sandbox/runs/<run-id>/` (repo):

| File | What it is |
|---|---|
| `result.json` | execution events (JSON stream); the **final answer** is in the last event |
| `hostout` | path of the host output dir (`SANDBOX_OUT_ROOT/<run-id>`) |
| `exit` | exit code, written last when the run finishes |
| `proxy.log` | every internet request (domain/URL); **absent in `sealed`** |
| `stderr.log` | OpenCode logs from inside the sandbox |

Exit codes: `0` success, `124` **timeout (inconclusive — not a failure; raise
the timeout or narrow the task)**, anything else a failure.

**Audit before trusting.** Read the answer and review the network with
`sandbox_logs` (or `proxy.log`) — especially for untrusted input, to confirm
nothing was exfiltrated or fetched from an unexpected source. There is nothing
to audit in `sealed`; that is the point of `sealed`.

## 11. Model selection

Always pass a model when you can. Prefer **free** OpenCode models and fall back
to **local** when a free run fails — there is no automatic fallback, you choose
and retry.

| Workload | Model ref |
|---|---|
| Default / most tasks | `opencode/deepseek-v4.1-flash-free` |
| Large context (long inputs, big files, long diffs) | `llama.cpp/qwen3.8-gguf-single192` (192K MTP) |
| Task fans out to parallel agents | `llama.cpp/qwen3.8-gguf-duo128` (2x128K) or `...-quad` (4x64K) |

- Free models need internet egress, so **`--sealed` must use a local model**.
- Omit `--model` to let the sandbox pick a mode-aware default (free online,
  `single192` sealed).
- The free catalog ships with OpenCode and **changes between releases**. On
  `provider.no-route`, or after an update, run `opencode-sb models --check` and
  pick from what it lists (`opencode-sb models` prints the catalog).

## 12. Network isolation

- **Default (enforced egress):** internet **only** through a proxy that logs
  every request. Tools that ignore `HTTP(S)_PROXY` fail — that is the intended
  failure mode and what makes `proxy.log` trustworthy.
- **`--sealed`:** no internet at all. Use it for untrusted/malicious input or
  when you must guarantee no exfiltration.
- A host firewall guard blocks the sandbox from host services; only the model
  relay is reachable. Do not try to reach host ports (`localhost:…`) from inside.

## 13. Limits and gotchas

- **Container-grade.** Shared kernel; no VM boundary. Do not feed it secrets.
- **The output dir is real, read-write and untrusted.** The agent can write,
  overwrite or delete anything under `SANDBOX_OUT_ROOT/<run-id>/`, with no quota.
  The human sets the prefix; never point it at a project tree.
- **No host persistence.** Each `task` starts from an empty `/workspace`. The
  session persists until `down`.
- **No host devices.** No GPU, no host browser, no Docker socket. Use the
  container's `webpage`/`ps4` skills.
- **Time is capped** (`--timeout`, default 1800 s). Hitting it yields `124`.
- **`watch` is not for you.** Unbounded output floods a model context; use
  `peek`.
- **A finished task's container is gone.** You can only steer while it runs; the
  transcript stays in `sandbox/runs/<run-id>/`.

## 14. Troubleshooting

| Symptom | Cause | Do this |
|---|---|---|
| `no running session` | session container is down | `opencode-sb up` |
| `no running container 'sandbox-…'` | task already finished | start a new task with the correction |
| `no sessions yet` | nothing has run in the session | `opencode-sb run "…"` |
| `N sessions are running; choose one` | ambiguous steer target | `opencode-sb sessions`, then `--session ses_…` |
| exit `124` | timeout | raise `--timeout` or narrow the task; result is inconclusive |
| no `proxy.log` | `--sealed` run | expected; there is no network to audit |
| artifacts dir empty | agent never wrote `/workspace/out` | repeat, naming exact output paths |
| `provider.no-route` | free model retired/renamed | `opencode-sb models --check`, pick a listed ref |
| `cannot connect to Docker daemon` | wrong `DOCKER_HOST` (e.g. from a sandboxed shell) | `export DOCKER_HOST=unix:///var/run/docker.sock` |
| page renders blank | content needs JavaScript | ask the agent to use the `webpage` skill |
| PS4 boot fails on firmware | firmware is not bundled | user must supply it; do not retry blindly |

## 15. Worked examples

**Analyse a suspicious script without executing it (no network):**

```text
sandbox_run(
  prompt: "Read /workspace/inst.sh. Explain what it does, list every network
           endpoint and file it touches, and say whether it is safe. DO NOT
           execute it. Write the report to /workspace/out/report.md.",
  copy_in: ["./inst.sh"],
  model: "llama.cpp/qwen3.8-gguf-single192",
  sealed: true,
  timeout: 900
)
```

**Try a package upgrade / config change on a throwaway system:**

```bash
opencode-sb task --model llama.cpp/qwen3.8-gguf-single192 --timeout 1200 \
  --copy-in ./sshd_config \
  --prompt "Install openssh-server if needed, put this at /etc/ssh/sshd_config,
run 'sshd -t', list every error, then write /workspace/out/result.txt."
```

**Read a JS-gated page:**

```text
sandbox_run(
  prompt: "Use the webpage skill to open https://example.com/app, wait for the
           table to render, and write its rows as JSON to /workspace/out/rows.json.",
  model: "opencode/deepseek-v4.1-flash-free"
)
```

**Start long work, then steer it:**

```bash
id=$(opencode-sb task --detach --prompt "Build and test the project in /workspace/src; write logs to /workspace/out/." --copy-in ./src | awk '/^run /{print $2}')
opencode-sb peek "$id"              # running? on track?
opencode-sb steer --run "$id" "Use the offline mirror; do not hit the network."
opencode-sb peek "$id"              # confirm the correction landed
```

## 16. Never

- Never pass host secrets, tokens or private keys in a prompt or `copy_in`.
- Never mount host paths yourself; the only surfaces are `copy_in` and the fixed
  output prefix.
- Never assume `/workspace` or the session survives; `task` is fresh, `down`
  destroys.
- Never re-run the same work while a run is alive — **steer it**.
- Never stream `watch` / `tail result.json` into your context — `peek`.
- Never trust a result you have not audited (or deliberately sealed).

## 17. Quick reference

```bash
opencode-sb help            # all commands
opencode-sb status          # containers + active turn
opencode-sb sessions        # sessions with (running)/(idle)
opencode-sb models --check  # validate preferred model refs
opencode-sb clean           # remove orphaned containers
```

Install: `sandbox/install.sh` in this repo. Full reference:
`sandbox/README.md` and `sandbox/ORCHESTRATION.md`.

# Orchestration playbook (for a host agent)

You are the orchestrator. This project lets you delegate tasks to a sandboxed
OpenCode instance. Read this before delegating.

## When to delegate

- Tasks that are destructive, experimental, or run untrusted code.
- Tasks that need isolation from the host filesystem.
- Do NOT delegate simple read-only questions you can answer locally.

## The contract

Prerequisite: `DOCKER_HOST` must point at the machine daemon
(`export DOCKER_HOST=unix:///var/run/docker.sock` when orchestrating from a
sandboxed shell). Model access goes through the per-bridge relay
automatically — no extra flags needed.

```bash
cd /home/rafael.franca/Projetos/My/agent-toolbelt/sandbox

./run.sh task \
  --prompt "<task>" \
  [--model <ref>] \
  [--copy-in <host-path>]... \
  [--timeout 1800] [--sealed] [--detach]
```

`opencode-sandboxed task …` (alias `opencode-sb task …`) is equivalent when
the global CLI is installed (it execs `run.sh task`), and works from any
directory.

- **Blocking**: the command returns when the task finishes (or times out).
  With `--detach` it prints the run id and returns immediately — then poll it
  with `peek` (see *Monitoring a run*).
- **Exit code**: `0` = success, `124` = timeout, other = failure.
- **Artifacts** in `runs/<run-id>/`:
  - `result.json` — the task's final answer/JSON; read this first.
  - `hostout` — path of the host output dir for this run.
  - `exit` — the run's exit code, written last when it finishes.
  - `proxy.log` — audit of every internet request (domains, URLs).
  - `stderr.log` — OpenCode logs.
- **Host output** (always): whatever the sandbox wrote to `/workspace/out` is in
  the dir named by `hostout` — `SANDBOX_OUT_ROOT/<run-id>/` (default
  `~/.sandbox`). The prefix is set by the human via `SANDBOX_OUT_ROOT`; a task
  caller cannot choose it (falls back to `runs/host/` if uncreatable).

## Prompt rules

- The sandbox agent starts in an **empty** `/workspace`. It cannot see your
  host filesystem. Make the prompt self-contained.
- If the task needs input files, pass them explicitly:
  `--copy-in /path/to/file` (repeatable). They land in `/workspace/<name>`.
- Instruct the agent to write deliverables to `/workspace/out/` — that always
  lands on the host, in the fixed prefix (`SANDBOX_OUT_ROOT/<run-id>/`), and is
  the only channel results come back through.
- Long prompts: write them to a temp file and use `--prompt-file <file>`
  (`--prompt-file -` reads stdin).
- **Model selection.** Prefer the free provider, fall back to local: most tasks
  `opencode/deepseek-v4.1-flash-free`; large context
  `llama.cpp/qwen3.8-gguf-single192`; parallel agents
  `llama.cpp/qwen3.8-gguf-duo128` or `llama.cpp/qwen3.8-gguf-quad`. When
  `--model` is omitted the sandbox picks a mode-aware default (free online,
  `single192` for `--sealed`). The catalog changes between OpenCode releases —
  validate the preferred refs with `opencode-sb models --check`.
- **Tools inside the sandbox.** Besides a shell, the image carries `webpage`
  (headless Chromium with JavaScript) and `ps4` (shadPS4 on Xvfb + software
  Vulkan). The agent discovers them through the seeded `webpage` and `ps4`
  skills. Point at the skill, not just the binary: "load the `webpage` skill
  and read <URL>" / "load the `ps4` skill, boot /workspace/game.iso, report the
  log". There is no host browser or GPU to ask for.
- **Getting files back onto the host.** Always read the dir named by
  `runs/<run-id>/hostout` (`SANDBOX_OUT_ROOT/<run-id>/`, default `~/.sandbox`).
  It is a **real rw host mount**: the untrusted agent can write/overwrite/delete
  anything under that prefix and there is no disk quota. You cannot choose the
  path (only the human sets `SANDBOX_OUT_ROOT`); keep it a dedicated scratch
  location, never a project tree or system path.

## Monitoring a run

Do **not** stream a run's full transcript into your own context — it grows
without bound and will flood you. Poll the bounded **peek** instead:

```bash
runid=$(opencode-sb task --detach --prompt "…" 2>/dev/null | awk '/^run /{print $2}')

opencode-sb peek "$runid"        # status + only the last 12 messages
opencode-sb peek "$runid" -n 4   # tighter window
opencode-sb peek                 # newest running run, if you lost the id
```

`peek` returns a small, fixed block: the run status (running + last-activity, or
finished + exit code), the last N messages (tool calls and assistant text, each
truncated), and the output files. Poll as often as you like.

Reserve `opencode-sb watch <run-id>` for a **human** — it follows the full live
transcript until the run ends. Don't call it from the host agent.

The **session** (the long-lived TUI) has no `result.json`, but has the same two
views over its SQLite history:

```bash
opencode-sb peek --session          # bounded: session title + last 12 parts
opencode-sb peek --session -n 4     # tighter window
opencode-sb sessions                # ids/titles, to target a specific session
```

Same rule: poll `peek --session`; leave `watch --session` to the human.

## Choosing isolation

- **Default (enforced egress):** the agent has internet *only* through the
  logging proxy. Anything that does not honour `HTTP(S)_PROXY` fails — which is
  the intended failure mode, and what makes the log trustworthy.
- **`--sealed`:** no internet at all. Use when the task processes
  untrusted/malicious input or you must guarantee no exfiltration.

## Audit

After any task, check `runs/<run-id>/proxy.log` before trusting results,
especially for tasks that handled untrusted input.

## Multi-turn / interactive work

Per-task containers are stateless by design. For iterative work:

```bash
opencode-sb             # TUI in a long-lived session container
opencode-sb run "msg"   # one-shot message in the session
opencode-sb down        # destroy the session when done
```

Session state lives in the container's tmpfs until `opencode-sb down`.

## Never

- Pass host secrets (API tokens, `~/.config` contents beyond the generated
  provider config, credentials) into prompts or `--copy-in`.
- Assume `/workspace` contents persist across tasks — each `task` run is fresh.
- Mount host paths other than the fixed output prefix: the shared surfaces are
  `--copy-in` (in) and `SANDBOX_OUT_ROOT/<run-id>/` (out, set by the human).
- Point the output prefix at a precious tree — it is a rw mount the sandbox can
  clobber.
- Stream a run with `watch` (or `tail` its `result.json`) into your own context —
  use the bounded `peek`.

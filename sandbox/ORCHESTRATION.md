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
  [--out-dir <host-scratch-dir>] \
  [--timeout 1800] [--sealed]
```

`opencode-sandboxed task …` (alias `opencode-sb task …`) is equivalent when
the global CLI is installed (it execs `run.sh task`), and works from any
directory.

- **Blocking**: the command returns when the task finishes (or times out).
- **Exit code**: `0` = success, `124` = timeout, other = failure.
- **Artifacts** in `runs/<run-id>/`:
  - `result.json` — the task's final answer/JSON; read this first.
  - `out/` — files the sandbox agent wrote to `/workspace/out`.
  - `proxy.log` — audit of every internet request (domains, URLs).
  - `stderr.log` — OpenCode logs.

## Prompt rules

- The sandbox agent starts in an **empty** `/workspace`. It cannot see your
  host filesystem. Make the prompt self-contained.
- If the task needs input files, pass them explicitly:
  `--copy-in /path/to/file` (repeatable). They land in `/workspace/<name>`.
- Instruct the agent to write deliverables to `/workspace/out/` — that is the
  only channel results come back through.
- Long prompts: write them to a temp file and use `--prompt-file <file>`
  (`--prompt-file -` reads stdin).
- **Model selection.** Prefer the free provider, fall back to local: most tasks
  `opencode/deepseek-v4.1-flash-free`; large context
  `llama.cpp/qwen3.8-gguf-single192`; parallel agents
  `llama.cpp/qwen3.8-gguf-duo128` or `llama.cpp/qwen3.8-gguf-quad`. When
  `--model` is omitted the sandbox picks a mode-aware default (free online,
  `single192` for `--sealed`). The catalog changes between OpenCode releases —
  validate the preferred refs with `opencode-sb models --check`.
- **Getting files back onto the host.** By default read `runs/<run-id>/out/`.
  To have the sandbox write straight into a host dir, pass
  `--out-dir <host-dir>` (bind-mounted **rw** at `/workspace/out`). It is a
  **scratch/tmp** space: the untrusted agent can write/overwrite/delete anything
  in it and there is no disk quota — only ever point it at a disposable dir,
  never a project tree or a system path.

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
- Point `--out-dir` at anything but a disposable scratch dir — it is a rw mount
  of real host space, and the sandbox can clobber whatever is there.
- Otherwise mount host paths: the only shared surfaces are `--copy-in` (in),
  `out/` (out), and the opt-in `--out-dir` scratch.

---
name: sandbox
description: Disposable Docker sandbox to delegate risky work. Use ALWAYS when a task could affect system stability (touching packages, services, kernel, /etc, disks, permissions), executing untrusted code/scripts/dependencies, running destructive or uncertain commands, processing potentially malicious files, or consulting/downloading dubious internet sources. The sandbox does not see the host filesystem (input only via copy_in, output only via /workspace/out) and internet goes through a logging proxy, or is cut with sealed. You (host) act as orchestrator via tools `sandbox_run`/`sandbox_logs`/`sandbox_status` or the global CLI `opencode-sb`. Do not use for simple read-only questions you answer locally.
metadata:
  audience: any
  opencode/slash: "true"
---

## What it is

`opencode-sandbox` runs an ephemeral OpenCode instance inside a disposable Docker container. You delegate the task and it runs isolated from the host: **no access to your filesystem**, no docker.sock, no capabilities, egress network controlled. It's for doing the dirty work away from the real machine.

Global CLI: `opencode-sb` (alias of `opencode-sandboxed`).
Project: repo `opencode-sandbox` — `README.md` and `ORCHESTRATION.md` for full reference.

## How to orchestrate

**Inside OpenCode, prefer the tools:**

| Tool | For |
|---|---|
| `sandbox_run` | runs the task and returns final answer, exit code, and artifacts |
| `sandbox_logs` | audits the network (`proxy.log`) of a run or of the session |
| `sandbox_status` | state of session/proxy/relay containers |

Equivalent on the terminal:

```bash
opencode-sb task --model  --timeout 1800 \
  --prompt "<self-contained task>" [--copy-in <host-path>]... [--sealed]
```

- **Blocking**: returns when the task finishes or the `--timeout` is reached.
- **Exit code**: `0` success, `124` timeout (inconclusive), other = failure.
- **Always pass `--model`** explicitly, for determinism.
- From a sandboxed shell, export `DOCKER_HOST=unix:///var/run/docker.sock` (the tools do this automatically).

### Interactive session (iterative work)

```bash
opencode-sb             # TUI in a long-lived session
opencode-sb run "msg"   # one-shot message in the session; prints the reply
opencode-sb status      # session/proxy/relay state
opencode-sb down        # destroy the session when done
```

Session state lives in the container's tmpfs until `down`. Prefer `task` for isolated work.

## Network isolation

- **Default (enforced egress):** internet **only** through the proxy that logs everything.
  Anything that doesn't honor `HTTP(S)_PROXY` fails — the intended failure mode, and what makes the log trustworthy.
- **`--sealed`:** no internet at all. Use when processing untrusted/malicious input or when you must guarantee no exfiltration.

## Artifacts

In `runs/<run-id>/` inside repo `opencode-sandbox`:

| File | What it is |
|---|---|
| `result.json` | execution events as JSON (stream); the **final answer** is in the last event — `sandbox_run` extracts and returns it |
| `out/` | files written to `/workspace/out` (only output channel) |
| `proxy.log` | audit of **all** internet requests (domain/URL). **Does not exist in `--sealed`** |
| `stderr.log` | OpenCode logs in the sandbox |

## Prompt rules

- The agent starts with `/workspace` **empty** and cannot see the host. Make the prompt self-contained.
- To pass files, use `copy_in` / `--copy-in` (repeatable) — they land in `/workspace/<name>`.
- Tell the agent to **write the deliverable to `/workspace/out/`**.
- Long prompts: `--prompt-file file` (or `--prompt-file -` for stdin).

## Audit (mandatory before trusting)

After any task, read the final answer and **review the network with `sandbox_logs` / `proxy.log`** (when it exists, i.e. outside `--sealed`) before trusting the result — especially if the task handled untrusted input, to confirm nothing was exfiltrated or came from an unexpected source.

## When NOT to use

- Read-only questions you can answer locally (docs, existing code).
- Tasks that actually need to touch host files/state — in that case tell the user; the lack of shared surface is intentional.

## Never

- Never pass host secrets (tokens, credentials, `~/.config` beyond the generated provider config) into prompts or `copy_in`.
- Don't assume `/workspace` persists across tasks — each `task` is fresh.
- Never mount host paths: the only surface is `copy_in` (input) and `out/` (output).
- Don't trust untrusted code/files without first running `--sealed` and reviewing output and log.

## Examples

```bash
# 1) Test an unknown script downloaded from the internet
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --timeout 900 \
  --prompt "Download https://exemplo.duvidoso/inst.sh, inspect the content and say
what it does. DO NOT execute. Write the report to /workspace/out/analise.md."

# 2) Simulate a system config change without touching the host
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --timeout 900 \
  --copy-in ./meu-sshd_config \
  --prompt "Validate this sshd_config with 'sshd -t' and list what would break.
Write the result to /workspace/out/validacao.txt."

# 3) Process potentially malicious input, without network
opencode-sb task --model llama.cpp/qwen3.8-gguf-max --sealed \
  --copy-in ./anexo-suspeito.bin \
  --prompt "Analyze the file, identify format and IOCs. DO NOT execute anything.
Write to /workspace/out/iocs.json."
```

## Quick check

```bash
opencode-sb help          # lists commands
sandbox_status            # (tool) or: opencode-sb status
opencode-sb clean         # removes orphaned containers
```

If `opencode-sb` does not exist, install via `install.sh` in repo `opencode-sandbox`.

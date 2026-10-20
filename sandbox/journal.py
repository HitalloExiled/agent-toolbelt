#!/usr/bin/env python3
"""Turn the sandboxed agent's JSON event stream into a transcript.

OpenCode's `run --format json` emits one JSON object per line, each with a
"type" and a "part". This renders that into a compact human view.

Modes:
  render          read newline-delimited events on stdin (as they arrive) and
                  print the transcript. Used to relay a live foreground task.
  watch RUN_DIR   follow RUN_DIR/result.json from the start, printing events as
                  they are appended; stop once RUN_DIR/exit appears (the run
                  finished), then print the exit code and the output files.
                  Meant for a *human* watching a run live.
  peek RUN_DIR [N]
                  print a BOUNDED snapshot: run status plus only the last N
                  message/tool entries (default 12), each clipped. Meant for a
                  *host agent* checking progress without pulling the full
                  transcript into its context. It never lists /workspace/out:
                  that directory is the user's artifact drop, not a channel.

Event types handled: text (assistant message), tool_use (tool + input/error).
step_start / step_finish are bookkeeping and ignored.
"""
import json
import os
import sys
import time

PEEK_DEFAULT = 12
NOTE_WIDTH = 160   # tool-call summary width
TEXT_WIDTH = 320   # per-line width in peek (watch prints full text)


def _one_line(value, limit=NOTE_WIDTH):
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _clip(line, width=TEXT_WIDTH):
    line = line.rstrip()
    return line if len(line) <= width else line[: width - 1] + "…"


def _tool_note(part):
    """A one-line summary of a tool call's input (best-effort)."""
    state = part.get("state") or {}
    inp = state.get("input")
    if isinstance(inp, dict):
        if inp.get("code"):  # `execute`: show just the first line of the code
            first = str(inp["code"]).strip().splitlines()
            return _one_line(first[0] if first else "", 100)
        for key in ("command", "filePath", "path", "query", "url", "pattern",
                    "description", "prompt", "content"):
            if inp.get(key) not in (None, ""):
                return _one_line(inp[key])
        return _one_line(json.dumps(inp, ensure_ascii=False)) if inp else ""
    if inp not in (None, ""):
        return _one_line(inp)
    return ""


def format_event(ev):
    """Return a list of transcript lines for one event ([] if nothing to show)."""
    kind = ev.get("type")
    part = ev.get("part") or {}
    lines = []
    if kind == "text":
        text = (part.get("text") or "").rstrip()
        if text:
            parts = text.splitlines() or [""]
            lines.append("💬 " + parts[0])
            lines.extend("   " + p for p in parts[1:])
    elif kind == "tool_use":
        note = _tool_note(part)
        lines.append("🔧 " + str(part.get("tool") or "?")
                     + ("  " + note if note else ""))
        state = part.get("state") or {}
        if state.get("status") == "error" and state.get("error"):
            lines.append("   ⚠ " + _one_line(state["error"]))
    return lines


def render_stream(stream):
    for line in iter(stream.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            for out in format_event(json.loads(line)):
                sys.stdout.write(out + "\n")
            sys.stdout.flush()
        except Exception:
            continue  # partial/non-JSON line: skip


def _read_events(result):
    """Yield parsed events from a (possibly incomplete) JSONL file."""
    if not os.path.exists(result):
        return
    with open(result, "r", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def watch(run_dir):
    result = os.path.join(run_dir, "result.json")
    marker = os.path.join(run_dir, "exit")
    hostout_file = os.path.join(run_dir, "hostout")
    sys.stdout.write(f"▶ following {os.path.basename(run_dir)}  (ctrl-c to stop)\n")
    sys.stdout.flush()

    pos = 0
    buf = ""
    while True:
        progressed = False
        if os.path.exists(result):
            with open(result, "r", errors="replace") as fh:
                fh.seek(pos)
                chunk = fh.read()
                pos = fh.tell()
            if chunk:
                progressed = True
                buf += chunk
                complete, buf = buf.rsplit("\n", 1) if "\n" in buf else ("", buf)
                for line in complete.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        for out in format_event(json.loads(line)):
                            sys.stdout.write(out + "\n")
                    except Exception:
                        continue
                sys.stdout.flush()
        if os.path.exists(marker) and not progressed:
            line = buf.strip()
            if line:
                try:
                    for out in format_event(json.loads(line)):
                        sys.stdout.write(out + "\n")
                except Exception:
                    pass
            break
        if not progressed:
            time.sleep(0.3)

    rc = ""
    try:
        if os.path.exists(marker):
            rc = open(marker).read().strip()
    except Exception:
        pass
    sys.stdout.write(f"■ done (exit {rc or '?'})\n")

    hostout = ""
    try:
        if os.path.exists(hostout_file):
            hostout = open(hostout_file).read().strip()
    except Exception:
        pass
    if hostout and os.path.isdir(hostout):
        try:
            items = sorted(os.listdir(hostout))
        except Exception:
            items = []
        if items:
            sys.stdout.write(f"  output: {hostout}/\n")
            for item in items:
                sys.stdout.write(f"    {item}\n")
    sys.stdout.flush()


def _ago(ts_ms):
    if not isinstance(ts_ms, (int, float)):
        return ""
    secs = max(0, int(time.time() - ts_ms / 1000.0))
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    return f"{secs // 3600}h ago"


def peek(run_dir, limit=PEEK_DEFAULT, state=None):
    result = os.path.join(run_dir, "result.json")
    marker = os.path.join(run_dir, "exit")

    entries = []       # list[list[str]] — one per text/tool event
    events = 0
    last_ts = None
    for ev in _read_events(result):
        events += 1
        if isinstance(ev.get("timestamp"), (int, float)):
            last_ts = ev["timestamp"]
        formatted = format_event(ev)
        if formatted:
            entries.append([_clip(ln) for ln in formatted])

    if state in ("running", "done"):
        running = state == "running"
    else:
        running = not os.path.exists(marker)
    rc = ""
    if not running:
        try:
            rc = open(marker).read().strip()
        except Exception:
            rc = "?"

    status = "running" if running else f"finished (exit {rc or '?'})"
    if running and last_ts:
        status += f" · last activity {_ago(last_ts)}"
    sys.stdout.write(f"▶ {os.path.basename(run_dir)} — {status} · {events} events\n")

    if not entries:
        sys.stdout.write("  (no messages yet)\n")
    else:
        shown = entries[-limit:]
        sys.stdout.write(f"— last {len(shown)} of {len(entries)} messages —\n")
        for entry in shown:
            for ln in entry:
                sys.stdout.write(ln + "\n")

    if running:
        sys.stdout.write(f"follow live: opencode-sb watch {os.path.basename(run_dir)}\n")
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] == "render":
        render_stream(sys.stdin)
    elif argv[0] == "watch" and len(argv) >= 2:
        watch(argv[1])
    elif argv[0] == "peek" and len(argv) >= 2:
        limit = PEEK_DEFAULT
        state = None
        if len(argv) >= 3:
            try:
                limit = max(1, int(argv[2]))
            except ValueError:
                pass
        if len(argv) >= 4 and argv[3] in ("running", "done"):
            state = argv[3]
        peek(argv[1], limit, state)
    else:
        sys.stderr.write(
            "usage: journal.py render | watch RUN_DIR | peek RUN_DIR [N] [running|done]\n")
        sys.exit(2)


if __name__ == "__main__":
    main()

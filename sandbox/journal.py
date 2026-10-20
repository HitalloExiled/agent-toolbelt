#!/usr/bin/env python3
"""Render sandbox activity as a transcript.

Two sources, one file:

  run events     OpenCode's `run --format json` stream (host side): a
                 newline-delimited JSON object per event with "type"/"part".
  session store  the container's OpenCode SQLite database (inside the sandbox),
                 piped in over `docker exec -i`.

Modes:
  render                      read events on stdin (live foreground task)
  run-watch RUN_DIR           follow RUN_DIR/result.json until RUN_DIR/exit
  run-peek RUN_DIR [N] [state]
                              bounded: status + last N entries (default 12)
  session-peek [N] [SID] [state]
                              bounded: last N parts of the newest session
  session-watch [SID] [--from-start]
                              follow the active session live
  session-list [running-id...] one line per session, marked running/idle
  session-ids                 session ids only, newest first

peek* is for a host agent: bounded output, never a live stream. watch* is for a
human. The user's artifact drop (/workspace/out) is never listed.
"""
import json
import os
import sqlite3
import sys
import time

DB = os.environ.get(
    "OPENCODE_DB", os.path.expanduser("~/.local/share/opencode/opencode.db"))
PEEK_DEFAULT = 12
NOTE_WIDTH = 160   # tool-call summary width
TEXT_WIDTH = 320   # per-line width in peek (watch prints full text)


# --------------------------------------------------------------------------- #
# shared helpers
# --------------------------------------------------------------------------- #
def _collapse(text):
    return " ".join(str(text).split())


def _clip(text, width=TEXT_WIDTH):
    text = text.rstrip()
    return text if len(text) <= width else text[: width - 1] + "…"


def _note(inp, width=NOTE_WIDTH):
    """A one-line summary of a tool call's input (best-effort)."""
    if isinstance(inp, dict):
        if inp.get("code"):  # `execute`: show just the first line of the code
            first = str(inp["code"]).strip().splitlines()
            return _clip(_collapse(first[0] if first else ""), 100)
        for key in ("command", "filePath", "path", "query", "url", "pattern",
                    "description", "prompt", "content"):
            if inp.get(key) not in (None, ""):
                return _clip(_collapse(inp[key]), width)
        return _clip(_collapse(json.dumps(inp, ensure_ascii=False)), width) if inp else ""
    if inp not in (None, ""):
        return _clip(_collapse(inp), width)
    return ""


def _ago(ts_ms):
    if not isinstance(ts_ms, (int, float)):
        return ""
    secs = max(0, int(time.time() - ts_ms / 1000.0))
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    return f"{secs // 3600}h ago"


# --------------------------------------------------------------------------- #
# run events (host side)
# --------------------------------------------------------------------------- #
def _tool_note(part):
    return _note((part.get("state") or {}).get("input"))


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
            lines.append("   ⚠ " + _note(state["error"]))
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


def run_watch(run_dir):
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


def run_peek(run_dir, limit=PEEK_DEFAULT, state=None):
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


# --------------------------------------------------------------------------- #
# session store (inside the sandbox container)
# --------------------------------------------------------------------------- #
def connect():
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    except sqlite3.Error:
        return sqlite3.connect(DB)


def _part_tool_name(part):
    return part.get("name") or part.get("tool") or "?"


def pick_session(conn, sid=None):
    if sid:
        return sid
    row = conn.execute(
        "select id from session_v2 order by time_updated desc limit 1").fetchone()
    return row[0] if row else None


def _part_lines(part):
    """One-line-per-part rendering, for the bounded peek."""
    kind = part.get("type")
    if kind == "text":
        text = _collapse(part.get("text") or "")
        return ["💬 " + _clip(text)] if text else []
    if kind in ("tool", "tool_use"):
        state = part.get("state") or {}
        note = _note(state.get("input"))
        lines = ["🔧 " + str(_part_tool_name(part)) + ("  " + note if note else "")]
        if state.get("status") in ("error", "failed") and state.get("error"):
            lines.append("   ⚠ " + _clip(_collapse(state["error"])))
        return lines
    return []


def session_peek(limit, sid_arg, state=None):
    conn = connect()
    sid = pick_session(conn, sid_arg)
    if not sid:
        sys.stdout.write("(no sessions yet)\n")
        return
    row = conn.execute("select title,time_updated from session_v2 where id=?",
                       (sid,)).fetchone()
    title, updated = (row if row else (None, None))
    title = title or "(untitled)"
    rows = conn.execute(
        "select type,data,time_updated from session_message "
        "where session_id=? order by seq", (sid,)).fetchall()

    entries = []
    for mtype, data, tu in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        if mtype == "user":
            text = _collapse(d.get("text") or "")
            if text:
                entries.append(["👤 " + _clip(text)])
        elif mtype == "assistant":
            for part in d.get("content", []):
                lines = _part_lines(part)
                if lines:
                    entries.append(lines)

    short = sid[:14] + "…" if len(sid) > 15 else sid
    state_txt = f" · {state}" if state else ""
    sys.stdout.write(
        f"▶ session '{title}' ({short}) — {len(entries)} parts · updated {_ago(updated)}{state_txt}\n")
    if not entries:
        sys.stdout.write("  (no messages yet)\n")
    else:
        shown = entries[-limit:]
        sys.stdout.write(f"— last {len(shown)} of {len(entries)} parts —\n")
        for entry in shown:
            for line in entry:
                sys.stdout.write(line + "\n")
    sys.stdout.write("follow live: opencode-sb watch --session\n")
    sys.stdout.flush()


class Out:
    """stdout wrapper that tracks whether we are at the start of a line, so
    streamed assistant text (written without a trailing newline) does not glue
    onto the next message."""

    def __init__(self, stream):
        self.s = stream
        self.at_start = True

    def write(self, text):
        if not text:
            return
        self.s.write(text)
        self.at_start = text.endswith("\n")

    def start_line(self):
        if not self.at_start:
            self.s.write("\n")
            self.at_start = True

    def line(self, text=""):
        if not self.at_start:
            self.s.write("\n")
        self.s.write(text + "\n")
        self.at_start = True

    def flush(self):
        self.s.flush()


def _stream_part(part, out):
    """Print a new part; return its text length (0 for non-text parts)."""
    kind = part.get("type")
    if kind == "text":
        text = part.get("text") or ""
        out.start_line()
        out.write("💬 " + text)
        return len(text)
    if kind in ("tool", "tool_use"):
        st = part.get("state") or {}
        note = _note(st.get("input"))
        out.line("🔧 " + str(_part_tool_name(part)) + ("  " + note if note else ""))
        if st.get("status") in ("error", "failed") and st.get("error"):
            out.line("   ⚠ " + _clip(_collapse(st["error"])))
        return 0
    return 0


def session_watch(sid_arg, from_start=False):
    sid = None
    state = {}          # message id -> {"n": parts emitted, "last": text len}
    primed = False
    out = Out(sys.stdout)
    out.line("▶ following the active session  (ctrl-c to stop)")
    out.flush()
    while True:
        try:
            conn = connect()
            newest = pick_session(conn, sid_arg)
            switched = False
            if newest and newest != sid:
                switched = sid is not None
                sid = newest
                state.clear()
                primed = False
                row = conn.execute("select title from session_v2 where id=?",
                                   (sid,)).fetchone()
                title = (row[0] if row else None) or "(untitled)"
                out.write(f"\n▶ session '{title}' ({sid[:14]}…)\n")
                out.flush()
            if not sid:
                conn.close()
                time.sleep(0.6)
                continue
            rows = conn.execute(
                "select id,type,data from session_message where session_id=? "
                "order by seq", (sid,)).fetchall()
            if not primed:
                primed = True
                # Attaching to an existing session: live-only (skip its history)
                # unless --from-start. A freshly *switched-to* session prints all.
                if not switched and not from_start:
                    for mid, mtype, data in rows:
                        st = {"printed": True}
                        if mtype == "assistant":
                            try:
                                parts = json.loads(data).get("content", [])
                            except Exception:
                                parts = []
                            last = parts[-1] if parts else None
                            st = {"n": len(parts),
                                  "last": (len(last.get("text") or "")
                                           if last and last.get("type") == "text" else 0),
                                  "printed": True}
                        state[mid] = st
            for mid, mtype, data in rows:
                try:
                    d = json.loads(data)
                except Exception:
                    continue
                st = state.get(mid)
                if mtype == "user":
                    if st is None:
                        state[mid] = {"printed": True}
                        text = _collapse(d.get("text") or "")
                        if text:
                            out.line("👤 " + _clip(text))
                elif mtype == "assistant":
                    parts = d.get("content", [])
                    if st is None:
                        st = {"n": 0, "last": 0, "printed": False}
                        state[mid] = st
                    while st["n"] < len(parts):
                        part = parts[st["n"]]
                        # A tool part can appear before its arguments are streamed
                        # in; wait for the input (or a terminal status) so the line
                        # shows the command, not just the tool name.
                        if part.get("type") in ("tool", "tool_use"):
                            tstate = part.get("state") or {}
                            if (not tstate.get("input")
                                    and tstate.get("status") in (None, "pending", "running")):
                                break
                        st["last"] = _stream_part(part, out)
                        st["n"] += 1
                    if st["n"] and parts[st["n"] - 1].get("type") == "text":
                        text = parts[st["n"] - 1].get("text") or ""
                        if len(text) > st["last"]:
                            out.write(text[st["last"]:])
                            st["last"] = len(text)
                else:
                    if st is None:
                        state[mid] = {"printed": True}
            out.flush()
            conn.close()
        except sqlite3.Error:
            pass
        time.sleep(0.6)


def session_list(active_ids=()):
    """One line per session, with a (running)/(idle) marker.

    Running = the id is in `/api/session/active` for this container's service.
    The SQLite DB has no live status column, so run.sh supplies the set.
    """
    active = set(active_ids)
    conn = connect()
    rows = conn.execute(
        "select id,title,time_updated from session_v2 order by time_updated desc "
        "limit 20").fetchall()
    if not rows:
        sys.stdout.write("(no sessions yet)\n")
        return
    for sid, title, updated in rows:
        n = conn.execute("select count(*) from session_message where session_id=?",
                         (sid,)).fetchone()[0]
        state = "running" if sid in active else "idle"
        sys.stdout.write(f"{sid}  {n:>4} msgs  {_ago(updated):>8}  {title}  ({state})\n")


def session_ids():
    """Session ids only, newest first (used by run.sh to resolve a target)."""
    conn = connect()
    for (sid,) in conn.execute(
            "select id from session_v2 order by time_updated desc limit 50"):
        sys.stdout.write(sid + "\n")


# --------------------------------------------------------------------------- #
def main():
    argv = sys.argv[1:]
    if not argv or argv[0] == "render":
        render_stream(sys.stdin)
    elif argv[0] == "run-watch" and len(argv) >= 2:
        run_watch(argv[1])
    elif argv[0] == "run-peek" and len(argv) >= 2:
        limit = PEEK_DEFAULT
        state = None
        if len(argv) >= 3:
            try:
                limit = max(1, int(argv[2]))
            except ValueError:
                pass
        if len(argv) >= 4 and argv[3] in ("running", "done"):
            state = argv[3]
        run_peek(argv[1], limit, state)
    elif argv[0] == "session-peek":
        limit = PEEK_DEFAULT
        sid = None
        state = None
        for arg in argv[1:]:
            if arg.isdigit():
                limit = int(arg)
            elif arg in ("running", "idle"):
                state = arg
            elif arg:
                sid = arg
        session_peek(limit, sid, state)
    elif argv[0] == "session-watch":
        from_start = "--from-start" in argv[1:]
        sid = next((a for a in argv[1:] if not a.startswith("-") and a), None)
        session_watch(sid, from_start)
    elif argv[0] == "session-list":
        session_list(argv[1:])
    elif argv[0] == "session-ids":
        session_ids()
    else:
        sys.stderr.write(
            "usage: journal.py render | run-watch DIR | run-peek DIR [N] [state] | "
            "session-peek [N] [SID] [state] | session-watch [SID] | "
            "session-list [running-id...] | session-ids\n")
        sys.exit(2)


if __name__ == "__main__":
    main()

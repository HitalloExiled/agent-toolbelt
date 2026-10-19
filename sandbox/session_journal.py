#!/usr/bin/env python3
"""Render an OpenCode *session* (SQLite) as a transcript.

Runs INSIDE the sandbox container (which has python3 + the sqlite3 module even
though the sqlite3 CLI is absent), piped in over `docker exec -i`:

    run.sh peek  --session [-n N]
    run.sh watch --session

OpenCode v2 stores sessions in ~/.local/share/opencode/opencode.db:

  session_v2       one row per session (title, model, time_updated, ...)
  session_message  one row per message: type in {user, assistant, idle, ...},
                   `data` = JSON. A user message has {"text": ...}; an assistant
                   message has {"content": [ {type:text,...} | {type:tool,...} ]}.

Modes:
  peek [N] [SID]   bounded snapshot: last N parts (default 12) of the newest
                   session (or SID). For a host agent checking in.
  watch [SID]      follow live: print new messages and stream assistant text as
                   it grows, until interrupted. Follows the newest session and
                   switches if a newer one becomes active. For a human.
  list             list recent sessions (id, title, messages, age).
"""
import json
import os
import sqlite3
import sys
import time

DB = os.environ.get(
    "OPENCODE_DB", os.path.expanduser("~/.local/share/opencode/opencode.db"))
PEEK_DEFAULT = 12
NOTE_WIDTH = 160
TEXT_WIDTH = 320


def connect():
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    except sqlite3.Error:
        return sqlite3.connect(DB)


def _collapse(text):
    return " ".join(str(text).split())


def _clip(text, width=TEXT_WIDTH):
    text = text.rstrip()
    return text if len(text) <= width else text[: width - 1] + "…"


def _note(inp, width=NOTE_WIDTH):
    if isinstance(inp, dict):
        if inp.get("code"):
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


def _part_tool_name(part):
    return part.get("name") or part.get("tool") or "?"


def pick_session(conn, sid=None):
    if sid:
        return sid
    row = conn.execute(
        "select id from session_v2 order by time_updated desc limit 1").fetchone()
    return row[0] if row else None


def _ago(ts_ms):
    if not isinstance(ts_ms, (int, float)):
        return ""
    secs = max(0, int(time.time() - ts_ms / 1000.0))
    return f"{secs}s ago" if secs < 60 else (
        f"{secs // 60}m ago" if secs < 3600 else f"{secs // 3600}h ago")


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


def cmd_peek(limit, sid_arg):
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
    sys.stdout.write(
        f"▶ session '{title}' ({short}) — {len(entries)} parts · updated {_ago(updated)}\n")
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


def cmd_watch(sid_arg, from_start=False):
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


def cmd_list():
    conn = connect()
    rows = conn.execute(
        "select id,title,time_updated from session_v2 order by time_updated desc "
        "limit 20").fetchall()
    for sid, title, updated in rows:
        n = conn.execute("select count(*) from session_message where session_id=?",
                         (sid,)).fetchone()[0]
        sys.stdout.write(f"{sid}  {n:>4} msgs  {_ago(updated):>8}  {title}\n")


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: session_journal.py peek [N] [SID] | watch [SID] | list\n")
        sys.exit(2)
    if argv[0] == "peek":
        limit = PEEK_DEFAULT
        sid = None
        for arg in argv[1:]:
            if arg.isdigit():
                limit = int(arg)
            elif arg:
                sid = arg
        cmd_peek(limit, sid)
    elif argv[0] == "watch":
        from_start = "--from-start" in argv[1:]
        sid = next((a for a in argv[1:] if not a.startswith("-") and a), None)
        cmd_watch(sid, from_start)
    elif argv[0] == "list":
        cmd_list()
    else:
        sys.stderr.write("unknown mode\n")
        sys.exit(2)


if __name__ == "__main__":
    main()

---
name: notes
description: Long-term memory in SQLite (FTS5) via global CLI `notes` and tools `notes_add`/`notes_search`/`notes_doctor`. Use to remember or recover decisions, configuration, snippets, and project context from previous sessions, and to record new notes — including the mandatory registration of resolved problems with symptom, cause, and solution. Refer to it whenever the user asks what was decided/done before, asks for previous context, or before working on a project with history.
metadata:
  audience: any
  opencode/slash: "true"
---

## What it is

Long-term memory system based on SQLite (+ FTS5 index when available), exposed via the global CLI `notes`. The database lives at `~/.local/share/opencode/memory/notes.db` (or at the path in `$NOTES_DB`) and — together with the schema — is created on demand: a fresh machine needs no manual steps at all.

Implementation and installation: repo **`agent-toolbelt`** (section `memory/`).

## How to use

**Inside OpenCode, prefer the tools** (typed, shell-free, with validation):

| Tool | For |
|---|---|
| `notes_search` | search / list recent notes (without `query` = list) |
| `notes_add` | record a note (validates the `#problem` format) |
| `notes_doctor` | diagnose memory/schema/FTS5 when something fails |

Via terminal (or when tools are unavailable), the equivalent CLI:

```bash
notes search "<term>" [limit]   # multiple words = OR (matches any)
notes list [limit]              # default: 10
notes add "<category>" "<title>" "<tags>" "<content>"
notes doctor                      # diagnosis
```

## When to use

- **Starting work** on a project with relevant history: search before acting.
- **Resolving a non-trivial problem**: register symptom → cause → solution (section below). This is the most important rule of the skill.
- **Making important decisions** (architecture, trade-offs, non-obvious configuration): record with category `#decision`.
- **Generating reusable snippets/configurations**: `#snippet` / `#config`.
- **Never delete or overwrite the memory database.** If the user asks to clear the history, direct them to run maintenance manually in their own terminal — do not do it yourself, and these are not CLI commands exposed here.

## Registering solved problems (mandatory)

Whenever you solve a **non-trivial** problem — bug, configuration error, unexpected behavior, dependency failure, regression — record a `#problem` note **before closing the task**. The next session must not re-live the same problem: your note is the shortcut.

**Required content: Symptom, Cause, Solution.** The `notes_add` tool **refuses** to record a `#problem` note that lacks the three sections.

```
Symptom: <what was observed / error message>
Cause: <root cause, not the symptom>
Solution: <what fixed it, reproducible>
Files: <paths touched, optional>
```

Rules:

- **Root cause, not symptom.** "Missing `exec` on `/tmp` mount" is a cause; "the command failed" is a symptom.
- **Reproducible solution:** the exact command or steps that fix it, not "I tweaked the config".
- **Do not register trivial matters** (your typo, a syntax doubt, a command you mistyped). The criterion: if another agent could fall into the same problem, record it.
- **Before recording, search.** `notes search "<symptom>"`. If the same problem is already documented with the same solution, do not duplicate.
- Multiple problems solved in one session = several notes, one per problem.

## Conventions

- **Categories**: `#problem`, `#decision`, `#config`, `#snippet`, `#architecture`, `#general`.
- **Tags**: keywords separated by space, without `#` (e.g.: `selinux module`).
- **Title**: short and specific — for problems, describe the symptom (e.g. "sandbox TUI fails without exec on /tmp").
- **Content**: the fact/decision + the why + relevant commands or paths. Write for someone who hasn't seen the conversation.

## Backup and transport

The database is local state, not versioned. To carry memory between machines (or keep a copy):

```bash
notes export ~/notes-backup.json    # or 'notes export -' for stdout
notes import ~/notes-backup.json    # append, ignoring duplicates
```

`notes reindex` rebuilds the FTS5 index if it goes out of sync (`notes doctor` warns when this happens).

## Quick check

```bash
notes doctor        # python/sqlite, FTS5, schema, count, index sync
which notes         # should point to ~/.local/bin/notes
```

If `notes` doesn't exist, the wrapper and schema live in `agent-toolbelt/memory/`; reinstall with `./install.sh` in the repo root. If the machine's `python3` lacks FTS5, `doctor` warns and search falls back to `LIKE` — memory keeps working.

## Writing notes in English

**Notes must be written in English** to keep the memory usable across agents and sessions. Existing Portuguese notes remain in the database as legacy; new notes go in English following the Symptom / Cause / Solution format above.

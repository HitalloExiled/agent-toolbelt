---
name: notes
description: Curated, portable knowledge base in SQLite (FTS5) via global CLI `notes` and tools `notes.add`/`notes.update`/`notes.confirm`/`notes.dispute`/`notes.retract`/`notes.history`/`notes.restore`/`notes.view`/`notes.search`/`notes.doctor` (effective names `notes_add`, `notes_search`, ... in regular sessions). Stores distilled facts at any scope (global, project, machine) — decisions, resolved problems with symptom/cause/solution, configuration, snippets — with a trust lifecycle (`notes.confirm`/`notes.dispute` set the trust signal on a note; `notes.retract` hides noise without deleting) and full revision history; notes survive machines via export/import. `notes.update` is a last resort, only to fix a note now known to be wrong or conflicting, and keeps the previous version readable via `notes.history`/`notes.restore`. Use when a fact must stay true across sessions and machines, or before acting on a project with documented history. Not a conversation log: it holds distilled knowledge, not what was said in a session.
metadata:
  audience: any
  opencode/slash: "true"
---

## What it is

Long-term memory system based on SQLite (+ FTS5 index when available), exposed via the global CLI `notes`. The database lives at `~/.local/share/opencode/memory/notes.db` (or at the path in `$NOTES_DB`) and — together with the schema — is created on demand: a fresh machine needs no manual steps at all.

Implementation and installation: repo **`opencode-tools`** (section `memory/`).

## Scope

**Curated, distilled knowledge at any scope — not a conversation log.**

- **What notes is for:** distilled facts that must stay true *after* the conversation ends — decisions (and their why), resolved problems with root cause, configuration, reusable snippets. At any scope: **global** (machine-independent), **project**-specific, or **machine**-specific. Every note carries a trust signal and a revision history, and the whole database exports/imports between machines; local-scope facts travel too — what's local is their *applicability*, not their registration.
- **What notes is not for:** journaling what was said or done in a session. Do not copy conversation content or "what happened" narratives into notes — register the distilled fact instead.
- **The test (distillation, not portability):** is this a claim with a cause/evidence, or a report of what happened? If it is a distilled fact, register it — its scope is then *classified* (the `Scope:` field below), never used as a reason to skip the registration.

## How to use

**Inside OpenCode, prefer the tools** (typed, shell-free, with validation):

| Tool | For |
|---|---|
| `notes.search` | search / list recent notes (without `query` = list). Disputed notes show ⚠ and sort last; retracted ones are hidden unless `includeRetracted` |
| `notes.add` | record a new note (validates the `#problem` format) |
| `notes.update` | **last resort**: fix a note that is wrong or conflicts (moves its timestamp, re-verifies it, snapshots the old version) |
| `notes.confirm` | ✔ re-verified a note read as-is: it still holds (clears dispute/retraction) |
| `notes.dispute` | ⚠ flag a note as suspect **without** rewriting it (needs `why`) |
| `notes.retract` | 🚫 hide junk/obsolete noise from search/list (reversible, nothing is deleted) |
| `notes.history` | read a note's current state + every earlier version (rev #N) |
| `notes.restore` | bring back the content of an earlier rev #N (keeps the current one too) |
| `notes.view` | show one note by id in full, whatever its state (retracted included, with 🚫) |
| `notes.doctor` | diagnose memory/schema/FTS5 when something fails |

Via terminal (or when tools are unavailable), the equivalent CLI:

```bash
notes search "<term>" [limit] [--all]   # all words first (AND), then any (OR)
notes list [limit] [--all]              # default: 10; --all includes retracted
notes add "<category>" "<title>" "<tags>" "<content>" [--author <name>]
notes update <id> [--title T] [--tags T] [--content C | --content-file F]
                  [--category C]  # last resort: fix conflicting information
notes confirm <id>                # re-verified: still valid (clears dispute/retraction)
notes dispute <id> --why "<reason>"   # suspicious, but not corrected: shown last
notes retract <id> [--why "<reason>"] # junk/obsolete: gone from search/list
notes history <id> [limit]             # current state + earlier versions (rev #N)
notes restore <id> <rev>               # bring back a rev's content (current kept)
notes view <id>                        # the whole note by id (alias: show)
notes doctor                      # diagnosis
```

## When to use

- **Starting work** on a project with relevant history: run `notes search` before acting (documented facts, not conversation recall).
- **Resolving a non-trivial problem**: register symptom → cause → solution (section below). This is the most important rule of the skill.
- **Making important decisions** (architecture, trade-offs, non-obvious configuration): record with category `#decision`.
- **Generating reusable snippets/configurations**: `#snippet` / `#config`.
- **Never delete or overwrite the memory database.** If the user asks to clear the history, direct them to run maintenance manually in their own terminal — do not do it yourself, and these are not CLI commands exposed here. `notes.update` edits one note in place and snapshots the previous version (recoverable via `notes.history`/`notes.restore`); it is not a wipe.

## Registering solved problems (mandatory)

Whenever you solve a **non-trivial** problem — bug, configuration error, unexpected behavior, dependency failure, regression — record a `#problem` note **before closing the task**. The next session must not re-live the same problem: your note is the shortcut.

**Required content: Symptom, Cause, Solution.** The `notes.add` tool **refuses** to record a `#problem` note that lacks the three sections.

```
Symptom: <what was observed / error message>
Cause: <root cause, not the symptom>
Solution: <what fixed it, reproducible>
Files: <paths touched, optional>
Scope: <global | project:<name> | machine:<name>, optional>
```

Rules:

- **Root cause, not symptom.** "Missing `exec` on `/tmp` mount" is a cause; "the command failed" is a symptom.
- **Reproducible solution:** the exact command or steps that fix it, not "I tweaked the config".
- **Do not register trivial matters** (your typo, a syntax doubt, a command you mistyped). The criterion: if another agent could fall into the same problem, record it.
- **Before recording, search.** `notes search "<symptom>"`. If the same problem is already documented with the same solution, do not duplicate.
- Multiple problems solved in one session = several notes, one per problem.

## Correcting a note (`notes.update`) — last resort

A wrong note is worse than a missing one: the next agent trusts it. Use
`notes.update` **only** when a saved note is now known to be factually wrong,
or when two notes contradict each other and one must be corrected.

- **Only for conflicts/wrong facts.** New information, a changed decision,
  extra detail, style — those are new notes, not edits. If the old note is
  merely incomplete or outdated but not wrong, add a new note and let both
  stand with their dates.
- **Correct, do not rewrite history.** Change only the fields that are wrong;
  leave the rest. The previous version is snapshotted automatically (read it
  with `notes.history`, bring it back with `notes.restore`), but the point of
  `update` is to record a *correction*, not to "clean up" notes you disagree
  with — for suspicion without a fix, `dispute` is the right move.
- **The timestamp moves to now.** After an update the note is stamped with the
  edit time (with seconds) and jumps to the top of `notes list`/search. That
  is intentional: it shows the correction is newer than the notes it
  contradicts.
- **#problem stays complete.** If the resulting note is `#problem`, it still
  needs Symptom, Cause and Solution; the tool refuses otherwise.
- **Say what changed.** When the correction is not obvious, start the new
  content with `Correction: <old claim> → <verified fact>` so a later reader
  understands why the note changed.

```bash
notes update 51 --content "Correction: the missing kv row was the cause; ..."
notes update 51 --title "..." --tags "..."     # title/tags only
printf '%s\n' "<new content>" | notes update 51 --content-file -
```

### History: nothing is overwritten away

Every `update` (and therefore `restore`) stores the note's previous state in
`note_revisions` *before* rewriting it. Correction is therefore deletion-free:

```bash
notes history <id>        # current state + earlier versions, newest first (rev #N)
notes restore <id> <rev>  # put an earlier version's content back
```

- `history` shows the live note and each prior version labelled `rev #N`, with
  the moment it was superseded and the flags it carried then.
- `restore` is just another update: it snapshots the current version first, so
  restoring can never lose anything — you can always restore again.
- Only content, title, tags and category come back; the note is re-verified
  (dispute/retraction cleared), like any `update`.
- `update` is still **not** for rewording or for appending facts — history is a
  safety net, not a licence to churn. If nothing is wrong, add a note or
  `confirm`.

## Trust: confirm, dispute, retract

A note carries a trust signal. Three operations set it, none of them deletes:

| You want to… | Do | Effect |
|---|---|---|
| say "this still holds" after using it | `notes.confirm <id>` | ✔ verified now; clears dispute/retraction |
| warn others it looks wrong, **no fix yet** | `notes.dispute <id> --why "…"` | ⚠ shown, sorted **last**, reason mandatory |
| silence junk/obsolete/a test leftover | `notes.retract <id> [--why "…"]` | 🚫 hidden from search/list (reversible) |
| fix what is actually wrong | `notes.update <id> --content "…"` | rewrites the note, re-verifies, clears flags |

Choosing the right one:

- **Wrong and you have the fix** → `update`. **Wrong but no fix yet** → `dispute`
  (never leave a suspected-wrong note unflagged).
- **Right, and you just relied on it** → `confirm`. This is the cheap, positive
  signal; confirming costs one call and tells the next agent the note survived
  real use. Prefer it over writing a duplicate "still works" note.
- **Noise** (a probe/test note, a superseded duplicate, a scratch entry) →
  `retract`, not silence and never deletion. `--all` still shows it, and
  `confirm`/`update` revive it.
- `dispute` and `retract` are mutually exclusive: disputing a retracted note
  makes it visible again (warning), retracting a disputed one hides it.

Display and ordering: search/list print `✔ verified <ts>`, `⚠ disputed <ts>` or
`🚫 retracted <ts>` under each note. Disputed notes always sort **after** clean
ones, so a conflict never outranks a trustworthy note. `--all` (CLI) or
`includeRetracted: true` (tool) reveals retracted notes for auditing.

Closing ritual: before you finish, the notes you *relied on* get a `confirm`
(if verified) or a `dispute` (if suspect), and any notes you created as scratch
get `retract`. `update` stays reserved for genuine corrections.

## Conventions

- **Categories**: `#problem`, `#decision`, `#config`, `#snippet`, `#architecture`, `#general`.
- **Scope**: how far the fact applies — `global` (machine-independent; the default, may be omitted), `project:<name>`, or `machine:<name>`. Scope is orthogonal to category and tags: it tells a reader on another machine *where* the fact applies, not whether it should have been registered at all.
- **Tags**: keywords separated by space, without `#` (e.g.: `selinux module`).
- **Title**: short and specific — for problems, describe the symptom (e.g. "sandbox TUI fails without exec on /tmp").
- **Author**: who registered the note (`--author <name>` / `author` on `notes.add`). Agents pass their own name; humans registering from a terminal pass theirs. Set at creation, never changed by `update`; shown as `(by <author>)` in search/list/view.
- **Content**: the fact/decision + the why + relevant commands or paths. Write for someone who hasn't seen the conversation.

## Backup and transport

The database is local state, not versioned. To carry memory between machines (or keep a copy):

```bash
notes export ~/notes-backup.json    # or 'notes export -' for stdout
notes import ~/notes-backup.json    # append, ignoring duplicates
```

Each exported note carries its version history, and `import` restores it too, so a backup round-trips the whole correction trail (not just the current text).

`notes reindex` rebuilds the FTS5 index if it goes out of sync (`notes doctor` warns when this happens).

## Quick check

```bash
notes doctor        # python/sqlite, FTS5, schema, count, index sync
which notes         # should point to ~/.local/bin/notes
```

If `notes` doesn't exist, the CLI and schema live in `opencode-tools/memory/`; rerun `./setup.sh` in the repo root. If the machine's `python3` lacks FTS5, `doctor` warns and search falls back to `LIKE` — memory keeps working.

## Writing notes in English

**Notes must be written in English** to keep the memory usable across agents and sessions. Existing Portuguese notes remain in the database as legacy; new notes go in English following the Symptom / Cause / Solution format above.

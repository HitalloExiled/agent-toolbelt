-- 003_note_revisions.sql — schema v3: content history behind `update`.
--
-- Every `notes update` snapshots the note's PRIOR state here before rewriting
-- it, so a correction is deletion-free: the old wording is always recoverable
-- (`notes history <id>` to read, `notes restore <id> <rev>` to bring back).
--
-- A row is the state BEFORE an edit:
--   revised_at    - when the edit happened (the moment this version was superseded)
--   timestamp     - the note's timestamp while it still had this content
--   category/tags/title/content - the prior content, verbatim
--   verified_at/disputed_at/retracted_at/status_reason - trust flags at that time
--                 (kept for display; `restore` does not re-apply them)
--
-- note_id is a plain column, not a FOREIGN KEY: this repo does not enable
-- foreign_keys, and keeping it explicit means history survives regardless of
-- statement ordering. `notes wipe` clears this table too.

CREATE TABLE IF NOT EXISTS note_revisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id       INTEGER NOT NULL,
    revised_at    TEXT NOT NULL,
    timestamp     TEXT NOT NULL,
    category      TEXT NOT NULL,
    tags          TEXT,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    verified_at   TEXT,
    disputed_at   TEXT,
    retracted_at  TEXT,
    status_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_revisions_note ON note_revisions(note_id, id DESC);

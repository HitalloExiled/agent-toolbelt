-- 002_note_trust.sql — schema v2: trust flags on notes.
--
-- Pure addition, existing rows stay valid (all columns NULL = "no signal"):
--   verified_at   - last time someone confirmed the note still holds
--   disputed_at   - someone flagged it as suspect; still shown, sorted last
--   retracted_at  - junk/obsolete; hidden from search/list unless --all.
--                   Reversible (confirm/update clear it): this is soft-delete,
--                   agents never hard-delete a note.
--   status_reason - why it was disputed or retracted
--
-- One ALTER per column: SQLite has no "ADD COLUMN IF NOT EXISTS", and this
-- file runs exactly once per database (guarded by PRAGMA user_version).

ALTER TABLE notes ADD COLUMN verified_at   TEXT;
ALTER TABLE notes ADD COLUMN disputed_at   TEXT;
ALTER TABLE notes ADD COLUMN retracted_at  TEXT;
ALTER TABLE notes ADD COLUMN status_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_disputed  ON notes(disputed_at);
CREATE INDEX IF NOT EXISTS idx_notes_retracted ON notes(retracted_at);

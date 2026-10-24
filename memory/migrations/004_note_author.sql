-- 004_note_author.sql — schema version 4
--
-- Attribution: who registered the note. Optional (NULL for legacy notes);
-- set at creation, never changed by update. Not indexed/FTS — it is
-- metadata shown in search/list/view output, not a search dimension.
ALTER TABLE notes ADD COLUMN author TEXT;

-- schema.sql — schema base do "notes" (schema version 1).
--
-- Aplicado em TODA inicializacao (init_db) e escrito para ser idempotente:
-- toda DDL usa IF NOT EXISTS. Bancos novos e existentes convergem para o
-- mesmo schema sem passo manual nenhum.

CREATE TABLE IF NOT EXISTS notes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    category  TEXT NOT NULL,
    tags      TEXT,
    title     TEXT NOT NULL,
    content   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_timestamp ON notes(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_notes_category  ON notes(category);

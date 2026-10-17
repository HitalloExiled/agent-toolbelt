-- schema_fts.sql — camada de busca full-text (FTS5), OPCIONAL.
--
-- Aplicada apenas quando o SQLite tem FTS5 (ENABLE_FTS5). Se o interpretador
-- python3 da maquina nao tiver FTS5, o CLI degrada para busca LIKE e emite um
-- aviso — a memoria continua funcionando, so sem indice invertido.
--
-- O indice usa "external content" (content='notes'): os dados vivem na tabela
-- notes e o FTS guarda so o indice. Os triggers abaixo mantem os dois lados
-- sincronizados em INSERT / UPDATE / DELETE.

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, tags, category,
    content='notes', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
    INSERT INTO notes_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
END;

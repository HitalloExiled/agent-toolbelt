# migrations/

Migrations de schema **acima da versao 1**.

- O schema base (versao 1) vive em `../schema.sql` e `../schema_fts.sql` e é
  aplicado de forma idempotente em todo `init_db()`.
- Da versao 2 em diante, cada mudanca ganha um arquivo
  `NNN_descricao.sql`, onde `NNN` é a versão de schema que o arquivo
  estabelece (ex.: `002_add_source_column.sql` estabelece a v2).
- `notes.py` aplica os arquivos em ordem enquanto
  `PRAGMA user_version < NNN` e, no fim, grava a versão corrente
  (`SCHEMA_VERSION`, hoje `1`).
- Ao adicionar uma migration, incremente `SCHEMA_VERSION` em
  `notes.py` e teste com um banco novo **e** com um banco existente.

Convenção de versão: `user_version` do SQLite guarda o número do schema
aplicado. Nunca reaproveite um número já publicado.

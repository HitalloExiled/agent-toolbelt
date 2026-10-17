#!/usr/bin/env python3
"""notes — memoria de longa duracao em SQLite, exposta pelo CLI `notes`.

Banco:   $NOTES_DB ou ${XDG_DATA_HOME:-~/.local/share}/opencode/memory/notes.db
Schema:  schema.sql (base) + schema_fts.sql (FTS5, opcional) + migrations/*.sql

O banco e o schema sao criados/atualizados *on demand*: toda operacao chama
init_db() antes de tocar nos dados, entao uma maquina zerada nao precisa de
nenhum passo manual — `notes list` ja cria tudo.

Se o python3 da maquina nao tiver FTS5, o CLI degrada para busca LIKE e avisa;
a memoria continua funcionando, apenas sem indice invertido.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import datetime

SCHEMA_VERSION = 1

HERE = os.path.dirname(os.path.realpath(__file__))
SCHEMA_SQL = os.path.join(HERE, "schema.sql")
SCHEMA_FTS_SQL = os.path.join(HERE, "schema_fts.sql")
MIGRATIONS_DIR = os.path.join(HERE, "migrations")

CATEGORIES = ("problem", "decision", "config", "snippet", "architecture", "general")

DEFAULT_LIST_LIMIT = 10


# --------------------------------------------------------------------------- #
# Infra
# --------------------------------------------------------------------------- #

def warn(msg: str) -> None:
    print(f"⚠️  {msg}", file=sys.stderr)


def db_path() -> str:
    """Caminho do banco. $NOTES_DB tem prioridade; o padrao segue o XDG."""
    override = os.environ.get("NOTES_DB")
    if override:
        return os.path.expanduser(override)
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share"
    )
    return os.path.join(data_home, "opencode", "memory", "notes.db")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


_fts_probe: bool | None = None
_warned_no_fts = False


def fts_supported() -> bool:
    """O interpretador python3 consegue criar tabelas virtuais FTS5?"""
    global _fts_probe
    if _fts_probe is None:
        try:
            probe = sqlite3.connect(":memory:")
            try:
                probe.execute("CREATE VIRTUAL TABLE __probe USING fts5(x)")
            finally:
                probe.close()
            _fts_probe = True
        except sqlite3.Error:
            _fts_probe = False
    return _fts_probe


def has_fts(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'notes_fts'"
    ).fetchone()
    return row is not None


# --------------------------------------------------------------------------- #
# Init / schema / migrations
# --------------------------------------------------------------------------- #

def _ensure_fts(conn: sqlite3.Connection) -> None:
    """Aplica a camada FTS5 (idempotente) ou avisa e degrada para LIKE.

    Roda sempre — nao so quando a tabela falta — porque bancos antigos podem
    ter a tabela sem os triggers de UPDATE/DELETE introduzidos depois.
    """
    global _warned_no_fts
    if not fts_supported():
        if not _warned_no_fts:
            _warned_no_fts = True
            warn(
                "FTS5 indisponivel neste python3/sqlite — busca full-text desativada, "
                "usando LIKE (mais lenta, sem prefixo)."
            )
        return
    try:
        conn.executescript(_read(SCHEMA_FTS_SQL))
    except sqlite3.Error as exc:  # pragma: no cover - depende do build do sqlite
        warn(f"nao foi possivel criar/atualizar o indice FTS5 ({exc}); seguindo com LIKE.")


def _migration_files() -> list[tuple[int, str]]:
    """[(versao_alvo, caminho)] ordenado, a partir de migrations/NNN_*.sql."""
    if not os.path.isdir(MIGRATIONS_DIR):
        return []
    found: list[tuple[int, str]] = []
    for name in sorted(os.listdir(MIGRATIONS_DIR)):
        m = re.match(r"^(\d+)_.+\.sql$", name)
        if m:
            found.append((int(m.group(1)), os.path.join(MIGRATIONS_DIR, name)))
    return sorted(found)


def _apply_migrations(conn: sqlite3.Connection) -> None:
    current = max(conn.execute("PRAGMA user_version").fetchone()[0], 1)
    for target, path in _migration_files():
        if target <= current:
            continue
        conn.executescript(_read(path))
        current = target


def init_db() -> None:
    """Cria/atualiza banco, schema e indice. Idempotente. Roda antes de tudo."""
    path = db_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = _connect()
    try:
        conn.executescript(_read(SCHEMA_SQL))
        _ensure_fts(conn)
        _apply_migrations(conn)
        conn.execute(f"PRAGMA user_version = {int(SCHEMA_VERSION)}")
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Operacoes
# --------------------------------------------------------------------------- #

def normalize_category(category: str) -> str:
    token = category.strip().lstrip("#")
    return f"#{token}" if token else "#general"


def add_note(category: str, title: str, tags: str, content: str) -> None:
    init_db()
    conn = _connect()
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        cur = conn.execute(
            "INSERT INTO notes (timestamp, category, tags, title, content)"
            " VALUES (?, ?, ?, ?, ?)",
            (timestamp, normalize_category(category), tags, title, content),
        )
        conn.commit()
        print(f"✅ Nota {cur.lastrowid} salva em {timestamp} [{normalize_category(category)}]")
    finally:
        conn.close()


def _fts_or_query(query: str) -> str:
    """Texto livre -> query FTS5 com OR entre as palavras.

    Ex.: 'python sqlite' -> '"python" OR "sqlite"'
    """
    words = query.split()
    if not words:
        raise ValueError("query vazia")
    parts = ['"%s"' % w.replace('"', '""') for w in words]
    return " OR ".join(parts)


def _fetch(conn: sqlite3.Connection, sql: str, params: list) -> list:
    return conn.execute(sql, params).fetchall()


def search_notes(query: str, limit: int | None = None) -> list:
    init_db()
    conn = _connect()
    try:
        rows: list | None = None
        if has_fts(conn):
            sql = (
                "SELECT n.timestamp, n.category, n.tags, n.title, n.content"
                " FROM notes n JOIN notes_fts f ON n.id = f.rowid"
                " WHERE notes_fts MATCH ? ORDER BY n.timestamp DESC"
            )
            params: list = [_fts_or_query(query)]
            try:
                if limit:
                    sql += " LIMIT ?"
                    params.append(limit)
                rows = _fetch(conn, sql, params)
            except sqlite3.Error:
                rows = None

        if not rows:  # sem FTS, erro no MATCH, ou zero resultados -> LIKE
            like = f"%{query}%"
            sql = (
                "SELECT timestamp, category, tags, title, content FROM notes"
                " WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?"
                " ORDER BY timestamp DESC"
            )
            params = [like, like, like, like]
            if limit:
                sql += " LIMIT ?"
                params.append(limit)
            rows = _fetch(conn, sql, params)
        return rows or []
    finally:
        conn.close()


def list_notes(limit: int = DEFAULT_LIST_LIMIT) -> list:
    init_db()
    conn = _connect()
    try:
        return _fetch(
            conn,
            "SELECT timestamp, category, tags, title, content FROM notes"
            " ORDER BY timestamp DESC LIMIT ?",
            [limit],
        )
    finally:
        conn.close()


def _print_rows(header: str, rows: list) -> None:
    print(header + "\n" + "=" * 50)
    for r in rows:
        print(f"[{r[0]}] ({r[1]}) **{r[3]}**")
        if r[2]:
            print(f"Tags: {r[2]}")
        print(f"Conteúdo:\n{r[4]}\n" + "-" * 50)


def print_search(query: str, limit: int | None = None) -> None:
    rows = search_notes(query, limit)
    if not rows:
        print(f"❌ Nenhuma nota encontrada para '{query}'.")
        return
    _print_rows(f"🔍 Encontradas {len(rows)} nota(s) para '{query}':", rows)


def print_list(limit: int = DEFAULT_LIST_LIMIT) -> None:
    rows = list_notes(limit)
    if not rows:
        print("📭 Nenhuma nota registrada ainda.")
        return
    _print_rows(f"📋 Últimas {len(rows)} nota(s):", rows)


def reindex() -> int:
    """Reconstroi o indice FTS a partir da tabela notes."""
    init_db()
    conn = _connect()
    try:
        if not has_fts(conn):
            print("⚠️  Sem indice FTS5 (busca LIKE) — nada a reconstruir.")
            return 0
        conn.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')")
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        print(f"🔁 Indice FTS5 reconstruido a partir de {total} nota(s).")
        return 0
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Export / import (backup e transporte entre maquinas)
# --------------------------------------------------------------------------- #

def export_notes(dest: str | None = None) -> int:
    init_db()
    conn = _connect()
    try:
        rows = _fetch(
            conn,
            "SELECT id, timestamp, category, tags, title, content FROM notes ORDER BY id",
            [],
        )
        payload = {
            "tool": "notes",
            "schema_version": SCHEMA_VERSION,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "count": len(rows),
            "notes": [
                {
                    "id": r[0],
                    "timestamp": r[1],
                    "category": r[2],
                    "tags": r[3],
                    "title": r[4],
                    "content": r[5],
                }
                for r in rows
            ],
        }
    finally:
        conn.close()

    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if dest and dest != "-":
        path = os.path.expanduser(dest)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        print(f"📤 {payload['count']} nota(s) exportada(s) para {path}")
    else:
        print(text)
    return 0


def _load_import_notes(path: str) -> list[dict]:
    if path == "-":
        raw = sys.stdin.read()
    else:
        with open(os.path.expanduser(path), encoding="utf-8") as fh:
            raw = fh.read()
    data = json.loads(raw)
    if isinstance(data, dict):
        data = data.get("notes", [])
    if not isinstance(data, list):
        raise ValueError("formato invalido: esperado um array de notas ou {\"notes\": [...]}")
    return [n for n in data if isinstance(n, dict)]


def import_notes(path: str) -> int:
    notes = _load_import_notes(path)
    init_db()
    conn = _connect()
    added = skipped = 0
    try:
        for n in notes:
            title = (n.get("title") or "").strip()
            content = n.get("content") or ""
            if not title:
                skipped += 1
                continue
            timestamp = n.get("timestamp") or datetime.now().strftime("%Y-%m-%d %H:%M")
            category = normalize_category(n.get("category") or "#general")
            tags = n.get("tags") or ""
            dup = conn.execute(
                "SELECT 1 FROM notes WHERE timestamp = ? AND category = ? AND title = ?"
                " AND IFNULL(tags,'') = ? AND content = ? LIMIT 1",
                (timestamp, category, title, tags, content),
            ).fetchone()
            if dup:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO notes (timestamp, category, tags, title, content)"
                " VALUES (?, ?, ?, ?, ?)",
                (timestamp, category, tags, title, content),
            )
            added += 1
        conn.commit()
    finally:
        conn.close()
    print(f"📥 Import: {added} nota(s) adicionada(s), {skipped} ignorada(s) (vazia/duplicada).")
    return 0


# --------------------------------------------------------------------------- #
# Doctor
# --------------------------------------------------------------------------- #

def doctor() -> int:
    """Diagnostico da maquina + banco. Exit 0 = pronto (avisos sao ok)."""
    ok = True  # falhas duras (banco inutilizavel)
    warned = False  # degradacoes aceitaveis (ex.: sem FTS5)
    path = db_path()
    print("🩺 notes — diagnostico\n" + "=" * 50)
    print(f"python      : {sys.version.split()[0]}")
    print(f"sqlite (lib) : {sqlite3.sqlite_version}")
    print(f"db          : {path}")

    if sys.version_info < (3, 8):
        print("❌ python3 >= 3.8 e obrigatorio")
        ok = False

    if fts_supported():
        print("fts5        : ✅ disponivel")
    else:
        print("fts5        : ⚠️  indisponivel — buscando via LIKE")
        warned = True

    try:
        init_db()
    except Exception as exc:  # noqa: BLE001 - queremos reportar qualquer falha
        print(f"❌ init_db falhou: {exc}")
        return 1

    if not os.path.exists(path):
        print("❌ banco nao foi criado")
        return 1

    print(f"tamanho     : {os.path.getsize(path)} bytes")
    if not os.access(path, os.W_OK):
        print("❌ banco nao e gravavel")
        ok = False

    conn = _connect()
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        triggers = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
            )
        ]
        notes = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        print(f"user_version: {version} (esperado {SCHEMA_VERSION})")
        if version != SCHEMA_VERSION:
            print("❌ versao de schema divergente")
            ok = False
        print(f"tabelas     : {', '.join(tables)}")
        print(f"triggers    : {', '.join(triggers) or '(nenhum)'}")
        print(f"notas       : {notes}")
        if has_fts(conn):
            indexed = conn.execute("SELECT COUNT(*) FROM notes_fts").fetchone()[0]
            print(f"indice fts  : {indexed} linha(s)")
            if indexed != notes:
                print("⚠️  indice fora de sincronia — rode: notes reindex")
                warned = True
        else:
            print("indice fts  : (ausente — busca LIKE)")
        cats = conn.execute(
            "SELECT category, COUNT(*) FROM notes GROUP BY category ORDER BY 2 DESC"
        ).fetchall()
        if cats:
            print("categorias  : " + ", ".join(f"{c}={n}" for c, n in cats))
    finally:
        conn.close()

    print("=" * 50)
    if not ok:
        print("❌ nao esta pronto (ver erros acima)")
        return 1
    print("⚠️  pronto, com avisos (ver acima)" if warned else "✅ pronto")
    return 0


# --------------------------------------------------------------------------- #
# Manutencao destrutiva (manual, fora do alcance de agentes)
# --------------------------------------------------------------------------- #

def wipe_notes() -> None:
    """Manutencao destrutiva exclusivamente MANUAL: apaga todas as notas.

    Guardas de seguranca contra acionamento acidental por agentes:
      1. exige terminal interativo (recusa entrada por pipe/script/redirecionamento);
      2. confirmacao digitada;
      3. nao ha flag de execucao nao-interativa.
    """
    if not sys.stdin.isatty():
        print("🚫 'wipe' é uma manutenção manual: só roda em terminal interativo.")
        sys.exit(1)
    init_db()
    conn = _connect()
    try:
        total = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        if total == 0:
            print("📭 O banco já está vazio, nada para apagar.")
            return

        print(f"⚠️  Esta ação apagará PERMANENTEMENTE {total} nota(s).")
        if input("Digite 'sim' para confirmar o wipe: ").strip().lower() not in (
            "sim",
            "yes",
            "y",
        ):
            print("❌ Wipe cancelado.")
            return

        conn.execute("DELETE FROM notes")  # os triggers limpam o indice FTS
        conn.execute("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'notes'")
        conn.commit()
        print(f"🧹 Banco limpo: {total} nota(s) apagada(s).")
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def print_help() -> None:
    # A linha de manutencao destrutiva so aparece em terminal interativo:
    # agentes executam sem TTY e, portanto, nunca a descobrem pelo help.
    wipe_line = (
        "  notes wipe                  # manutenção destrutiva (somente manual)\n"
        if sys.stdin.isatty()
        else ""
    )
    print(f"""
📚 Notes CLI (notes)

Uso:
  notes add "<categoria>" "<título>" "<tags>" "<conteúdo>"
  notes search "<termo>" [limite]   # múltiplas palavras = OR
  notes list [limite]               # padrão: {DEFAULT_LIST_LIMIT}
  notes doctor                      # diagnóstico da máquina/banco
  notes init                        # cria/atualiza banco e schema (idempotente)
  notes export [arquivo|-]          # backup/transporte em JSON (padrão: stdout)
  notes import <arquivo|->          # importa JSON (ignora duplicadas)
  notes reindex                     # reconstrói o índice FTS5
{wipe_line}
Categorias sugeridas:
  {", ".join("#" + c for c in CATEGORIES)}

Banco: {db_path()}  (ou $NOTES_DB)
""".rstrip())


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print_help()
        return 1

    cmd = argv[1]
    if cmd == "add":
        if len(argv) < 6:
            print('Erro: "add" requer categoria, título, tags e conteúdo.')
            return 1
        add_note(argv[2], argv[3], argv[4], argv[5])
    elif cmd == "search":
        if len(argv) < 3:
            print('Erro: "search" requer um termo de busca.')
            return 1
        limit = int(argv[3]) if len(argv) > 3 and argv[3].isdigit() else None
        print_search(argv[2], limit)
    elif cmd == "list":
        limit = int(argv[2]) if len(argv) > 2 and argv[2].isdigit() else DEFAULT_LIST_LIMIT
        print_list(limit)
    elif cmd == "init":
        init_db()
        status = "com FTS5" if fts_supported() else "sem FTS5 (busca LIKE)"
        print(f"✅ banco pronto: {db_path()} [schema v{SCHEMA_VERSION}, {status}]")
    elif cmd == "doctor":
        return doctor()
    elif cmd == "reindex":
        return reindex()
    elif cmd == "export":
        return export_notes(argv[2] if len(argv) > 2 else None)
    elif cmd == "import":
        if len(argv) < 3:
            print('Erro: "import" requer um arquivo (ou "-" para stdin).')
            return 1
        return import_notes(argv[2])
    elif cmd == "wipe":
        wipe_notes()
    elif cmd in ("help", "-h", "--help"):
        print_help()
    elif cmd in ("version", "--version"):
        print(f"notes (schema v{SCHEMA_VERSION})")
    else:
        print(f"comando desconhecido: {cmd}", file=sys.stderr)
        print_help()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

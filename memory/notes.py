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
import unicodedata
from datetime import datetime

SCHEMA_VERSION = 2

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


def now_timestamp() -> str:
    """Timestamp de criacao/atualizacao, com segundos.

    Segundos importam para `update`: uma correcao no mesmo minuto da criacao
    precisa mudar o timestamp (e a ordenacao) de forma observavel.
    """
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def missing_problem_sections(content: str) -> list[str]:
    """Secoes obrigatorias ausentes numa nota #problem (sem acento/caixa)."""
    text = unicodedata.normalize("NFD", content or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return [label for label in ("Symptom", "Cause", "Solution") if label.lower() not in text]


# Colunas de uma nota, na ordem em que as linhas sao selecionadas e impressas.
NOTE_FIELDS = (
    "id", "timestamp", "category", "tags", "title", "content",
    "verified_at", "disputed_at", "retracted_at", "status_reason",
)


def note_columns(prefix: str = "") -> str:
    pre = f"{prefix}." if prefix else ""
    return ", ".join(f"{pre}{field}" for field in NOTE_FIELDS)


def add_note(category: str, title: str, tags: str, content: str) -> None:
    init_db()
    conn = _connect()
    try:
        timestamp = now_timestamp()
        cur = conn.execute(
            "INSERT INTO notes (timestamp, category, tags, title, content)"
            " VALUES (?, ?, ?, ?, ?)",
            (timestamp, normalize_category(category), tags, title, content),
        )
        conn.commit()
        print(f"✅ Nota {cur.lastrowid} salva em {timestamp} [{normalize_category(category)}]")
    finally:
        conn.close()


def update_note(
    note_id: int,
    title: str | None = None,
    tags: str | None = None,
    content: str | None = None,
    category: str | None = None,
) -> int:
    """Corrige uma nota existente, movendo o timestamp para agora.

    ULTIMO RECURSO: existe para consertar informacao errada/conflitante, nao
    para reescrever historico. Campos omitidos ficam como estao. Se a nota
    resultante for #problem, as secoes Symptom/Cause/Solution continuam
    obrigatorias.
    """
    if title is None and tags is None and content is None and category is None:
        print("Erro: 'update' requer ao menos um campo (--title/--tags/--content/--category).")
        return 1

    init_db()
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT timestamp, category, tags, title, content FROM notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        if row is None:
            print(f"❌ Nota {note_id} não encontrada.")
            return 1

        old_timestamp, old_category, old_tags, old_title, old_content = row
        new_category = normalize_category(category) if category is not None else old_category
        new_tags = old_tags if tags is None else tags
        new_title = old_title if title is None else title
        new_content = old_content if content is None else content

        if not new_title.strip():
            print("❌ título vazio: a nota ficaria sem identificação.")
            return 1
        if new_category == "#problem":
            missing = missing_problem_sections(new_content)
            if missing:
                print(
                    "❌ Nota NÃO atualizada: conteúdo #problem sem "
                    + ", ".join(missing)
                    + "."
                )
                return 1

        timestamp = now_timestamp()
        # Reescrever a nota a partir de evidencia e tambem um ato de verificacao:
        # marca verified_at e limpa disputa/retracao (a informacao mudou, entao
        # os avisos antigos nao valem mais).
        conn.execute(
            "UPDATE notes SET timestamp = ?, category = ?, tags = ?, title = ?, content = ?,"
            " verified_at = ?, disputed_at = NULL, retracted_at = NULL, status_reason = NULL"
            " WHERE id = ?",
            (timestamp, new_category, new_tags, new_title, new_content, timestamp, note_id),
        )
        conn.commit()
        print(f"✏️  Nota {note_id} atualizada em {timestamp} [{new_category}]")
        print(f"   timestamp: {old_timestamp} → {timestamp}")
        print("   ✔ marcada como verificada; disputa/retração limpas (se havia)")
        return 0
    finally:
        conn.close()


def _load_note(conn: sqlite3.Connection, note_id: int):
    return conn.execute(
        f"SELECT {note_columns()} FROM notes WHERE id = ?", (note_id,)
    ).fetchone()


def confirm_note(note_id: int) -> int:
    """Marca a nota como verificada agora; limpa disputa e retração."""
    init_db()
    conn = _connect()
    try:
        if _load_note(conn, note_id) is None:
            print(f"❌ Nota {note_id} não encontrada.")
            return 1
        timestamp = now_timestamp()
        conn.execute(
            "UPDATE notes SET verified_at = ?, disputed_at = NULL, retracted_at = NULL,"
            " status_reason = NULL WHERE id = ?",
            (timestamp, note_id),
        )
        conn.commit()
        print(f"✔ Nota {note_id} verificada em {timestamp}")
        print("   disputa/retração limpas (se havia): a nota volta a aparecer normalmente")
        return 0
    finally:
        conn.close()


def dispute_note(note_id: int, reason: str) -> int:
    """Flagra a nota como suspeita (sem reescrever o conteúdo).

    Para quando voce desconfia que esta errada mas nao tem a correcao — a
    proxima leitura ve o aviso e a nota vai para o fim da lista. Com a
    correcao em maos, o certo e `update`.
    """
    reason = (reason or "").strip()
    if not reason:
        print('Erro: "dispute" requer --why "<motivo>" (sem motivo nao ha aviso util).')
        return 1
    init_db()
    conn = _connect()
    try:
        if _load_note(conn, note_id) is None:
            print(f"❌ Nota {note_id} não encontrada.")
            return 1
        timestamp = now_timestamp()
        conn.execute(
            "UPDATE notes SET disputed_at = ?, status_reason = ?, retracted_at = NULL WHERE id = ?",
            (timestamp, reason, note_id),
        )
        conn.commit()
        print(f"⚠ Nota {note_id} disputada em {timestamp}: {reason}")
        return 0
    finally:
        conn.close()


def retract_note(note_id: int, reason: str = "") -> int:
    """Esconde a nota do search/list (lixo, teste, obsoleta) — reversível.

    Nao apaga nada: `confirm` ou `update` trazem a nota de volta, e `--all`
    continua listando. E o substituto do delete, que fica so com o humano.
    """
    reason = (reason or "").strip() or "retracted"
    init_db()
    conn = _connect()
    try:
        if _load_note(conn, note_id) is None:
            print(f"❌ Nota {note_id} não encontrada.")
            return 1
        timestamp = now_timestamp()
        conn.execute(
            "UPDATE notes SET retracted_at = ?, status_reason = ?, disputed_at = NULL WHERE id = ?",
            (timestamp, reason, note_id),
        )
        conn.commit()
        print(f"🚫 Nota {note_id} retratada em {timestamp}: {reason}")
        print("   fora do search/list por padrão; `confirm`/`update` a trazem de volta, `--all` mostra")
        return 0
    finally:
        conn.close()


def _fts_query(words: list[str], joiner: str) -> str:
    """Palavras -> query FTS5, combinadas com AND (preciso) ou OR (amplo)."""
    parts = ['"%s"' % w.replace('"', '""') for w in words]
    return f" {joiner} ".join(parts)


def _fetch(conn: sqlite3.Connection, sql: str, params: list) -> list:
    return conn.execute(sql, params).fetchall()


# Ordem: notas disputadas por ultimo (boolean 0/1), depois relevancia, depois
# recencia. Um `#id` conflitante nunca aparece acima de uma nota confiavel.
_ORDER_FTS = " ORDER BY (n.disputed_at IS NOT NULL), bm25(notes_fts), n.timestamp DESC"
_ORDER_LIKE = " ORDER BY (disputed_at IS NOT NULL), timestamp DESC"


def _fts_pass(
    conn: sqlite3.Connection, words: list[str], joiner: str, limit: int | None, all: bool
) -> list | None:
    """Uma tentativa no FTS5. None = indice indisponivel/erro no MATCH."""
    sql = (
        f"SELECT {note_columns('n')} FROM notes n JOIN notes_fts f ON n.id = f.rowid"
        " WHERE notes_fts MATCH ?"
    )
    if not all:
        sql += " AND n.retracted_at IS NULL"
    sql += _ORDER_FTS
    params: list = [_fts_query(words, joiner)]
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    try:
        return _fetch(conn, sql, params)
    except sqlite3.Error:
        return None


def _like_pass(
    conn: sqlite3.Connection, words: list[str], joiner: str, limit: int | None, all: bool
) -> list:
    """Busca LIKE: cada palavra casa em qualquer campo; palavras unidas por joiner."""
    groups: list[str] = []
    params: list = []
    for w in words:
        like = f"%{w}%"
        groups.append("(title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)")
        params += [like, like, like, like]
    sql = f"SELECT {note_columns()} FROM notes WHERE " + f" {joiner} ".join(groups)
    if not all:
        sql += " AND retracted_at IS NULL"
    sql += _ORDER_LIKE
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    return _fetch(conn, sql, params)


def search_notes(query: str, limit: int | None = None, all: bool = False) -> list:
    """Busca full-text. Tenta AND (todas as palavras) e so depois OR.

    Isso evita o diluvio de resultados irrelevantes de uma query generica:
    "skill permission" so cai no OR se nao houver nota com as duas palavras.
    Notas retratadas ficam fora, a menos que all=True.
    """
    init_db()
    conn = _connect()
    try:
        words = query.split()
        if not words:
            return []
        if has_fts(conn):
            for joiner in ("AND", "OR"):
                rows = _fts_pass(conn, words, joiner, limit, all)
                if rows:
                    return rows
                if rows is None:  # FTS quebrado -> LIKE
                    break
        for joiner in ("AND", "OR"):
            rows = _like_pass(conn, words, joiner, limit, all)
            if rows:
                return rows
        return []
    finally:
        conn.close()


def list_notes(limit: int = DEFAULT_LIST_LIMIT, all: bool = False) -> list:
    init_db()
    conn = _connect()
    try:
        sql = f"SELECT {note_columns()} FROM notes"
        if not all:
            sql += " WHERE retracted_at IS NULL"
        sql += _ORDER_LIKE + " LIMIT ?"
        return _fetch(conn, sql, [limit])
    finally:
        conn.close()


def _print_rows(header: str, rows: list) -> None:
    print(header + "\n" + "=" * 50)
    for r in rows:
        (note_id, timestamp, category, tags, title, content,
         verified_at, disputed_at, retracted_at, status_reason) = r
        print(f"#{note_id} [{timestamp}] ({category}) **{title}**")
        flags = []
        if retracted_at:
            flags.append(f"🚫 retracted {retracted_at}" + (f": {status_reason}" if status_reason else ""))
        elif disputed_at:
            flags.append(f"⚠ disputed {disputed_at}" + (f": {status_reason}" if status_reason else ""))
        if verified_at:
            flags.append(f"✔ verified {verified_at}")
        if flags:
            print("   " + " · ".join(flags))
        if tags:
            print(f"Tags: {tags}")
        print(f"Conteúdo:\n{content}\n" + "-" * 50)


def print_search(query: str, limit: int | None = None, all: bool = False) -> None:
    rows = search_notes(query, limit, all)
    if not rows:
        extra = "" if all else " (notas retratadas ficam fora; use --all para vê-las)"
        print(f"❌ Nenhuma nota encontrada para '{query}'.{extra}")
        return
    _print_rows(f"🔍 Encontradas {len(rows)} nota(s) para '{query}':", rows)


def print_list(limit: int = DEFAULT_LIST_LIMIT, all: bool = False) -> None:
    rows = list_notes(limit, all)
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
            f"SELECT {note_columns()} FROM notes ORDER BY id",
            [],
        )
        payload = {
            "tool": "notes",
            "schema_version": SCHEMA_VERSION,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "count": len(rows),
            "notes": [
                dict(zip(NOTE_FIELDS, r))
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
            timestamp = n.get("timestamp") or now_timestamp()
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
                "INSERT INTO notes (timestamp, category, tags, title, content,"
                " verified_at, disputed_at, retracted_at, status_reason)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    timestamp, category, tags, title, content,
                    n.get("verified_at") or None,
                    n.get("disputed_at") or None,
                    n.get("retracted_at") or None,
                    n.get("status_reason") or None,
                ),
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
        flags = conn.execute(
            "SELECT"
            " SUM(verified_at IS NOT NULL),"
            " SUM(disputed_at IS NOT NULL),"
            " SUM(retracted_at IS NOT NULL) FROM notes"
        ).fetchone()
        verified, disputed, retracted = (v or 0 for v in flags)
        print(f"confianca   : {verified} verificada(s), {disputed} disputada(s), {retracted} retratada(s)")
        if disputed:
            warn("há nota(s) disputada(s) — veja o aviso ⚠ na busca e corrija com `notes update`")
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
  notes update <id> [--title T] [--tags T] [--content C | --content-file F]
                    [--category C]  # ÚLTIMO RECURSO: corrige informação conflitante
  notes confirm <id>                # ✔ reverifiquei: vale hoje (limpa disputa/retração)
  notes dispute <id> --why "<motivo>"   # ⚠ suspeita: mostrada, mas por último
  notes retract <id> [--why "<motivo>"] # 🚫 lixo/obsoleta: some do search/list (reversível)
  notes search "<termo>" [limite] [--all]  # todas as palavras (AND); depois OR
  notes list [limite] [--all]       # padrão: {DEFAULT_LIST_LIMIT}; --all inclui retratadas
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
    elif cmd == "update":
        if len(argv) < 3:
            print('Erro: "update" requer o id da nota.')
            return 1
        try:
            note_id = int(argv[2])
        except ValueError:
            print(f'Erro: id inválido: {argv[2]!r}')
            return 1
        fields: dict[str, str] = {}
        rest = argv[3:]
        while rest:
            flag = rest.pop(0)
            if flag == "--content-file":
                if not rest:
                    print('Erro: "--content-file" requer um arquivo (ou "-").')
                    return 1
                src = rest.pop(0)
                try:
                    fields["content"] = (
                        sys.stdin.read()
                        if src == "-"
                        else _read(os.path.expanduser(src))
                    )
                except OSError as exc:
                    print(f"Erro: não foi possível ler {src}: {exc}")
                    return 1
                continue
            key = {
                "--title": "title",
                "--tags": "tags",
                "--content": "content",
                "--category": "category",
            }.get(flag)
            if key is None:
                print(f'Erro: opção desconhecida em "update": {flag}')
                return 1
            if not rest:
                print(f'Erro: "{flag}" requer um valor.')
                return 1
            fields[key] = rest.pop(0)
        return update_note(note_id, **fields)
    elif cmd in ("confirm", "dispute", "retract"):
        if len(argv) < 3:
            print(f'Erro: "{cmd}" requer o id da nota.')
            return 1
        try:
            note_id = int(argv[2])
        except ValueError:
            print(f'Erro: id inválido: {argv[2]!r}')
            return 1
        reason = ""
        rest = argv[3:]
        while rest:
            flag = rest.pop(0)
            if flag != "--why":
                print(f'Erro: opção desconhecida em "{cmd}": {flag}')
                return 1
            if not rest:
                print('Erro: "--why" requer um motivo.')
                return 1
            reason = rest.pop(0)
        if cmd == "confirm":
            return confirm_note(note_id)
        if cmd == "dispute":
            return dispute_note(note_id, reason)
        return retract_note(note_id, reason)
    elif cmd == "search":
        args = argv[2:]
        all_flag = "--all" in args
        args = [a for a in args if a != "--all"]
        if not args:
            print('Erro: "search" requer um termo de busca.')
            return 1
        limit = int(args[1]) if len(args) > 1 and args[1].isdigit() else None
        print_search(args[0], limit, all_flag)
    elif cmd == "list":
        all_flag = "--all" in argv[2:]
        args = [a for a in argv[2:] if a != "--all"]
        limit = int(args[0]) if args and args[0].isdigit() else DEFAULT_LIST_LIMIT
        print_list(limit, all_flag)
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

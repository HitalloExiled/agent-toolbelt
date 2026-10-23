/**
 * Derived full-text index. It contains only user text, assistant text and
 * compaction summaries — never reasoning or tool payloads. The SQLite database
 * is disposable: summaries on disk are the durable memory.
 */

import { chmod, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { indexTextMax, indexPath, jsonIndexPath } from "./paths.js";
import type { IndexDoc, IndexState, MessageKind, SearchHit, VectorRow, VectorState } from "./types.js";
import { ensureDataDirs, atomicWrite } from "./storage.js";
import { clip, snippet, tokenize } from "./util.js";

export interface SearchOptions {
  projectID?: string;
  scope: "project" | "all";
  kind?: MessageKind | "any";
  limit: number;
}

export interface MemoryIndex {
  readonly backend: "sqlite-fts5" | "sqlite-like" | "json";
  readonly error?: string;
  upsert(docs: IndexDoc[]): Promise<void>;
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
  /** Doc ids (kind="summary") currently in the index, for read-only reconciliation. */
  summaryIDs(projectID?: string): Promise<string[]>;
  getSession(sessionID: string): IndexState | undefined;
  setSession(sessionID: string, projectID: string, updatedAt: number): void;
  count(projectID?: string): Promise<number>;
  remove(ids: string[]): Promise<void>;
  clearProject(projectID: string): Promise<void>;
  clearAll(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Replace the vectors stored for each doc (one transaction per doc). */
  upsertVectors(rows: VectorRow[]): Promise<void>;
  /** Vector state for a doc (any model), or undefined when it has none. */
  vectorState(docID: string): Promise<VectorState | undefined>;
  /**
   * Move a doc's existing vectors to a new project (session moved
   * directories). The vectors themselves stay valid — same text, same model.
   */
  rehomeVectors(docID: string, projectID: string, kind: MessageKind): Promise<void>;
  /** All vectors of a model, grouped by doc (in chunk order). */
  loadVectors(model: string, projectID?: string): Promise<Map<string, { kind: MessageKind; vecs: Float32Array[] }>>;
  /** Distinct docs carrying vectors of a model. */
  vectorCount(model: string, projectID?: string): Promise<number>;
  deleteVectors(docIDs: string[]): Promise<void>;
  /** Drop vectors stored by other models; returns how many rows were removed. */
  pruneOldVectors(model: string): Promise<number>;
  /** Every indexed doc (optionally of one project). */
  docs(projectID?: string): Promise<IndexDoc[]>;
  docsByIds(ids: string[]): Promise<IndexDoc[]>;
}

function dedupe(docs: IndexDoc[]): IndexDoc[] {
  const byID = new Map<string, IndexDoc>();
  for (const doc of docs) {
    if (!doc.id || !doc.text.trim()) continue;
    byID.set(doc.id, doc);
  }
  return [...byID.values()];
}

function hitFrom(doc: IndexDoc, rank: number, terms: string[]): SearchHit {
  return { ...doc, rank, snippet: snippet(doc.text, terms) };
}

class SqliteIndex implements MemoryIndex {
  readonly backend: "sqlite-fts5" | "sqlite-like";
  readonly error?: string;
  private readonly db: any;
  private fts: boolean;

  constructor(Database: any, path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT,
        kind TEXT NOT NULL,
        created INTEGER NOT NULL,
        title TEXT,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id, created DESC);
      CREATE INDEX IF NOT EXISTS documents_session ON documents(session_id);
      CREATE TABLE IF NOT EXISTS sessions_indexed (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (
        doc_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (doc_id, chunk)
      );
      CREATE INDEX IF NOT EXISTS embeddings_model ON embeddings(model, project_id);
    `);
    this.fts = true;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2')");
    } catch (error) {
      this.fts = false;
      this.error = `FTS5 unavailable; using LIKE (${error instanceof Error ? error.message : String(error)})`;
      console.error(`[memory] ${this.error}`);
    }
    this.backend = this.fts ? "sqlite-fts5" : "sqlite-like";
  }

  async upsert(input: IndexDoc[]): Promise<void> {
    const docs = dedupe(input);
    if (docs.length === 0) return;
    const max = indexTextMax();
    const get = this.db.query("SELECT rowid FROM documents WHERE id = ?");
    const insert = this.db.query(
      "INSERT INTO documents (id, project_id, session_id, message_id, kind, created, title, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const update = this.db.query(
      "UPDATE documents SET project_id = ?, session_id = ?, message_id = ?, kind = ?, created = ?, title = ?, text = ? WHERE rowid = ?",
    );
    const lastRow = this.db.query("SELECT last_insert_rowid() AS id");
    const ftsInsert = this.db.query("INSERT INTO documents_fts(rowid, text) VALUES (?, ?)");
    const ftsDelete = this.db.query("DELETE FROM documents_fts WHERE rowid = ?");

    const work = () => {
      for (const doc of docs) {
        const text = clip(doc.text, max, "");
        if (!text) continue;
        const title = doc.title ? clip(doc.title, 300, "") : null;
        const existing = get.get(doc.id) as { rowid: number } | null;
        let rowid: number;
        if (existing) {
          rowid = Number(existing.rowid);
          update.run(doc.projectID, doc.sessionID, doc.messageID ?? null, doc.kind, doc.created, title, text, rowid);
          if (this.fts) {
            ftsDelete.run(rowid);
            ftsInsert.run(rowid, text);
          }
        } else {
          insert.run(doc.id, doc.projectID, doc.sessionID, doc.messageID ?? null, doc.kind, doc.created, title, text);
          rowid = Number((lastRow.get() as { id: number }).id);
          if (this.fts) ftsInsert.run(rowid, text);
        }
      }
    };

    this.db.transaction(work)();
  }

  private likeSearch(terms: string[], options: SearchOptions): SearchHit[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const term of terms) {
      clauses.push("(text LIKE ? OR title LIKE ?)");
      params.push(`%${term}%`, `%${term}%`);
    }
    if (options.scope === "project") {
      if (!options.projectID) return [];
      clauses.push("project_id = ?");
      params.push(options.projectID);
    }
    if (options.kind && options.kind !== "any") {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    const sql =
      "SELECT id, project_id, session_id, message_id, kind, created, title, text FROM documents" +
      (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "") +
      " ORDER BY created DESC LIMIT ?";
    params.push(Math.max(1, options.limit));
    const rows = this.db.query(sql).all(...params) as any[];
    return rows.map((row) => hitFrom(fromRow(row), 0, terms));
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    if (!this.fts) return this.likeSearch(terms, options);
    const ftsQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
    const clauses = ["documents_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];
    if (options.scope === "project") {
      if (!options.projectID) return [];
      clauses.push("d.project_id = ?");
      params.push(options.projectID);
    }
    if (options.kind && options.kind !== "any") {
      clauses.push("d.kind = ?");
      params.push(options.kind);
    }
    params.push(Math.max(1, options.limit));
    try {
      const rows = this.db
        .query(
          `SELECT d.id, d.project_id, d.session_id, d.message_id, d.kind, d.created, d.title, d.text,
                  bm25(documents_fts) AS rank
           FROM documents_fts f JOIN documents d ON d.rowid = f.rowid
           WHERE ${clauses.join(" AND ")}
           ORDER BY rank ASC, d.created DESC
           LIMIT ?`,
        )
        .all(...params) as any[];
      return rows.map((row) => hitFrom(fromRow(row), Number(row.rank ?? 0), terms));
    } catch (error) {
      console.error(`[memory] FTS query failed, falling back to LIKE: ${error instanceof Error ? error.message : String(error)}`);
      return this.likeSearch(terms, options);
    }
  }

  async summaryIDs(projectID?: string): Promise<string[]> {
    const rows = projectID
      ? (this.db
          .query("SELECT id FROM documents WHERE kind = 'summary' AND project_id = ?")
          .all(projectID) as Array<{ id: string }>)
      : (this.db.query("SELECT id FROM documents WHERE kind = 'summary'").all() as Array<{ id: string }>);
    return rows.map((row) => row.id);
  }

  getSession(sessionID: string): IndexState | undefined {
    const row = this.db.query("SELECT project_id, updated_at FROM sessions_indexed WHERE session_id = ?").get(sessionID) as
      | { project_id: string; updated_at: number }
      | null;
    return row ? { projectID: row.project_id, updatedAt: Number(row.updated_at) } : undefined;
  }

  setSession(sessionID: string, projectID: string, updatedAt: number): void {
    this.db
      .query(
        `INSERT INTO sessions_indexed (session_id, project_id, updated_at, indexed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at, indexed_at = excluded.indexed_at`,
      )
      .run(sessionID, projectID, updatedAt, Date.now());
  }

  async count(projectID?: string): Promise<number> {
    const row = projectID
      ? (this.db.query("SELECT COUNT(*) AS n FROM documents WHERE project_id = ?").get(projectID) as { n: number })
      : (this.db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number });
    return Number(row?.n ?? 0);
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const select = this.db.query("SELECT rowid FROM documents WHERE id = ?");
    const delDoc = this.db.query("DELETE FROM documents WHERE id = ?");
    const delFts = this.db.query("DELETE FROM documents_fts WHERE rowid = ?");
    const delVec = this.db.query("DELETE FROM embeddings WHERE doc_id = ?");
    const work = () => {
      for (const id of ids) {
        const row = select.get(id) as { rowid: number } | null;
        if (row) {
          if (this.fts) delFts.run(Number(row.rowid));
          delDoc.run(id);
        }
        // Vectors are dropped unconditionally: an orphan vector set is
        // never useful, even if the document row is already gone.
        delVec.run(id);
      }
    };
    this.db.transaction(work)();
  }

  async clearProject(projectID: string): Promise<void> {
    const rows = this.db.query("SELECT rowid FROM documents WHERE project_id = ?").all(projectID) as Array<{ rowid: number }>;
    if (this.fts) {
      const del = this.db.query("DELETE FROM documents_fts WHERE rowid = ?");
      for (const row of rows) del.run(Number(row.rowid));
    }
    this.db.query("DELETE FROM documents WHERE project_id = ?").run(projectID);
    this.db.query("DELETE FROM sessions_indexed WHERE project_id = ?").run(projectID);
    this.db.query("DELETE FROM embeddings WHERE project_id = ?").run(projectID);
  }

  async clearAll(): Promise<void> {
    if (this.fts) this.db.exec("DELETE FROM documents_fts");
    this.db.exec("DELETE FROM documents");
    this.db.exec("DELETE FROM sessions_indexed");
    this.db.exec("DELETE FROM embeddings");
  }

  async upsertVectors(rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const byDoc = new Map<string, VectorRow[]>();
    for (const row of rows) {
      const list = byDoc.get(row.docID);
      if (list) list.push(row);
      else byDoc.set(row.docID, [row]);
    }
    const del = this.db.query("DELETE FROM embeddings WHERE doc_id = ?");
    const insert = this.db.query(
      "INSERT INTO embeddings (doc_id, project_id, kind, model, content_hash, chunk, vec) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const work = () => {
      for (const [docID, docRows] of byDoc) {
        // Full replacement: a shorter document must not keep stale chunks.
        del.run(docID);
        for (const row of docRows) {
          insert.run(row.docID, row.projectID, row.kind, row.model, row.contentHash, row.chunk, toBlob(row.vec));
        }
      }
    };
    this.db.transaction(work)();
  }

  async vectorState(docID: string): Promise<VectorState | undefined> {
    const row = this.db
      .query(
        "SELECT model, project_id, content_hash, COUNT(*) AS chunks FROM embeddings WHERE doc_id = ? GROUP BY model, content_hash LIMIT 1",
      )
      .get(docID) as { model: string; project_id: string; content_hash: string; chunks: number } | null;
    if (!row) return undefined;
    return {
      model: String(row.model),
      projectID: String(row.project_id),
      contentHash: String(row.content_hash),
      chunks: Number(row.chunks),
    };
  }

  async rehomeVectors(docID: string, projectID: string, kind: MessageKind): Promise<void> {
    this.db
      .query("UPDATE embeddings SET project_id = ?, kind = ? WHERE doc_id = ?")
      .run(projectID, kind, docID);
  }

  async loadVectors(
    model: string,
    projectID?: string,
  ): Promise<Map<string, { kind: MessageKind; vecs: Float32Array[] }>> {
    const rows = projectID
      ? (this.db
          .query("SELECT doc_id, kind, chunk, vec FROM embeddings WHERE model = ? AND project_id = ? ORDER BY doc_id, chunk")
          .all(model, projectID) as any[])
      : (this.db
          .query("SELECT doc_id, kind, chunk, vec FROM embeddings WHERE model = ? ORDER BY doc_id, chunk")
          .all(model) as any[]);
    const out = new Map<string, { kind: MessageKind; vecs: Float32Array[] }>();
    for (const row of rows) {
      let entry = out.get(String(row.doc_id));
      if (!entry) {
        entry = { kind: String(row.kind) as MessageKind, vecs: [] };
        out.set(String(row.doc_id), entry);
      }
      entry.vecs.push(fromBlob(row.vec));
    }
    return out;
  }

  async vectorCount(model: string, projectID?: string): Promise<number> {
    const row = projectID
      ? (this.db
          .query("SELECT COUNT(DISTINCT doc_id) AS n FROM embeddings WHERE model = ? AND project_id = ?")
          .get(model, projectID) as { n: number })
      : (this.db.query("SELECT COUNT(DISTINCT doc_id) AS n FROM embeddings WHERE model = ?").get(model) as { n: number });
    return Number(row?.n ?? 0);
  }

  async deleteVectors(docIDs: string[]): Promise<void> {
    if (docIDs.length === 0) return;
    const del = this.db.query("DELETE FROM embeddings WHERE doc_id = ?");
    this.db.transaction(() => {
      for (const id of docIDs) del.run(id);
    })();
  }

  async pruneOldVectors(model: string): Promise<number> {
    const row = this.db.query("SELECT COUNT(*) AS n FROM embeddings WHERE model != ?").get(model) as { n: number };
    const count = Number(row?.n ?? 0);
    if (count > 0) this.db.query("DELETE FROM embeddings WHERE model != ?").run(model);
    return count;
  }

  async docs(projectID?: string): Promise<IndexDoc[]> {
    const rows = projectID
      ? (this.db
          .query("SELECT id, project_id, session_id, message_id, kind, created, title, text FROM documents WHERE project_id = ?")
          .all(projectID) as any[])
      : (this.db
          .query("SELECT id, project_id, session_id, message_id, kind, created, title, text FROM documents")
          .all() as any[]);
    return rows.map(fromRow);
  }

  async docsByIds(ids: string[]): Promise<IndexDoc[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT id, project_id, session_id, message_id, kind, created, title, text FROM documents WHERE id IN (${placeholders})`,
      )
      .all(...ids) as any[];
    return rows.map(fromRow);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

interface JsonState {
  version: 1;
  documents: IndexDoc[];
  sessions: Record<string, IndexState>;
}

export class JsonIndex implements MemoryIndex {
  readonly backend = "json" as const;
  error: string;
  private readonly path: string;
  private readonly documents = new Map<string, IndexDoc>();
  private readonly sessions = new Map<string, IndexState>();
  private dirty = false;

  private constructor(path: string, error: string) {
    this.path = path;
    this.error = error;
  }

  static async open(path: string, error: string): Promise<JsonIndex> {
    const index = new JsonIndex(path, error);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<JsonState>;
        for (const doc of parsed.documents ?? []) {
          if (doc && typeof doc.id === "string" && typeof doc.text === "string") index.documents.set(doc.id, doc);
        }
        for (const [sessionID, state] of Object.entries(parsed.sessions ?? {})) {
          if (state && typeof state.updatedAt === "number") index.sessions.set(sessionID, state);
        }
      } catch (err) {
        index.error = `${error}; corrupt JSON index ignored (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    return index;
  }

  async upsert(input: IndexDoc[]): Promise<void> {
    for (const doc of dedupe(input)) {
      this.documents.set(doc.id, { ...doc, text: clip(doc.text, indexTextMax(), "") });
    }
    // Keep the fallback bounded; the durable files are unaffected.
    if (this.documents.size > 20_000) {
      const oldest = [...this.documents.values()].sort((a, b) => a.created - b.created);
      for (const doc of oldest.slice(0, this.documents.size - 20_000)) this.documents.delete(doc.id);
    }
    this.dirty = true;
    await this.flush();
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const doc of this.documents.values()) {
      if (options.scope === "project" && doc.projectID !== options.projectID) continue;
      if (options.kind && options.kind !== "any" && doc.kind !== options.kind) continue;
      const haystack = `${doc.title ?? ""}\n${doc.text}`.toLocaleLowerCase();
      let score = 0;
      for (const term of terms) {
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(term, from);
          if (at < 0) break;
          score++;
          from = at + term.length;
        }
      }
      if (score > 0) hits.push(hitFrom(doc, -score, terms));
    }
    hits.sort((a, b) => b.rank - a.rank || b.created - a.created);
    return hits.slice(0, Math.max(1, options.limit));
  }

  async summaryIDs(projectID?: string): Promise<string[]> {
    const out: string[] = [];
    for (const [id, doc] of this.documents) {
      if (doc.kind !== "summary") continue;
      if (projectID && doc.projectID !== projectID) continue;
      out.push(id);
    }
    return out;
  }

  getSession(sessionID: string): IndexState | undefined {
    return this.sessions.get(sessionID);
  }

  setSession(sessionID: string, projectID: string, updatedAt: number): void {
    this.sessions.set(sessionID, { projectID, updatedAt });
    this.dirty = true;
  }

  async count(projectID?: string): Promise<number> {
    if (!projectID) return this.documents.size;
    let n = 0;
    for (const doc of this.documents.values()) if (doc.projectID === projectID) n++;
    return n;
  }

  // The JSON fallback keeps no vector layer: everything is a no-op, and
  // search degrades to keyword-only.
  async upsertVectors(_rows: VectorRow[]): Promise<void> {}

  async vectorState(_docID: string): Promise<VectorState | undefined> {
    return undefined;
  }

  async rehomeVectors(_docID: string, _projectID: string, _kind: MessageKind): Promise<void> {}

  async loadVectors(_model: string, _projectID?: string): Promise<Map<string, { kind: MessageKind; vecs: Float32Array[] }>> {
    return new Map();
  }

  async vectorCount(_model: string, _projectID?: string): Promise<number> {
    return 0;
  }

  async deleteVectors(_docIDs: string[]): Promise<void> {}

  async pruneOldVectors(_model: string): Promise<number> {
    return 0;
  }

  async docs(projectID?: string): Promise<IndexDoc[]> {
    const out: IndexDoc[] = [];
    for (const doc of this.documents.values()) if (!projectID || doc.projectID === projectID) out.push(doc);
    return out;
  }

  async docsByIds(ids: string[]): Promise<IndexDoc[]> {
    const wanted = new Set(ids);
    const out: IndexDoc[] = [];
    for (const doc of this.documents.values()) if (wanted.has(doc.id)) out.push(doc);
    return out;
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.documents.delete(id);
    if (ids.length > 0) {
      this.dirty = true;
      await this.flush();
    }
  }

  async clearProject(projectID: string): Promise<void> {
    for (const [id, doc] of this.documents) if (doc.projectID === projectID) this.documents.delete(id);
    for (const [sessionID, state] of this.sessions) if (state.projectID === projectID) this.sessions.delete(sessionID);
    this.dirty = true;
    await this.flush();
  }

  async clearAll(): Promise<void> {
    this.documents.clear();
    this.sessions.clear();
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const state: JsonState = {
      version: 1,
      documents: [...this.documents.values()],
      sessions: Object.fromEntries(this.sessions),
    };
    await atomicWrite(this.path, JSON.stringify(state), 0o600);
    this.dirty = false;
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(bytes: unknown): Float32Array {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  return new Float32Array(src.buffer, src.byteOffset, Math.floor(src.byteLength / 4));
}

function fromRow(row: any): IndexDoc {
  return {
    id: String(row.id),
    projectID: String(row.project_id),
    sessionID: String(row.session_id),
    messageID: row.message_id ? String(row.message_id) : undefined,
    kind: String(row.kind) as MessageKind,
    created: Number(row.created),
    title: row.title ? String(row.title) : undefined,
    text: String(row.text),
  };
}

export async function openIndex(): Promise<MemoryIndex> {
  await ensureDataDirs();
  let sqliteError = "";
  try {
    const mod: any = await import("bun:sqlite");
    const Database = mod?.Database;
    if (typeof Database === "function") {
      const index = await openSqlite(Database);
      await chmod(indexPath(), 0o600).catch(() => undefined);
      return index;
    }
    sqliteError = "bun:sqlite did not expose Database";
  } catch (error) {
    sqliteError = error instanceof Error ? error.message : String(error);
  }
  const error = `SQLite unavailable; using JSON fallback (${sqliteError || "unknown error"})`;
  console.error(`[memory] ${error}`);
  return JsonIndex.open(jsonIndexPath(), error);
}

async function openSqlite(Database: any): Promise<MemoryIndex> {
  const path = indexPath();
  let index: MemoryIndex | undefined;
  try {
    index = new SqliteIndex(Database, path);
    await index.count(); // probe: an image can open yet fail to read
    return index;
  } catch (error) {
    // The database is disposable: an unreadable image (interrupted copy,
    // crash mid-write) is quarantined and rebuilt lazily from the summaries.
    const reason = error instanceof Error ? error.message : String(error);
    if (index) await index.close().catch(() => undefined);
    const quarantine = `${path}.corrupt-${Date.now()}`;
    await rename(path, quarantine).catch(() => undefined);
    console.error(`[memory] index unreadable (${reason}); quarantined to ${quarantine}`);
    return new SqliteIndex(Database, path);
  }
}

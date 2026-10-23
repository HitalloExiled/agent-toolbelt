/** Shared, deliberately small structural types for the memory plugin. */

export type MessageKind = "user" | "assistant" | "summary";

export interface SessionInfoLike {
  id: string;
  projectID: string;
  title?: string;
  parentID?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

export interface ContentPart {
  type: string;
  text?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    title?: string;
    metadata?: unknown;
  };
  [key: string]: unknown;
}

export interface MessageLike {
  id: string;
  type: string;
  time?: { created?: number; completed?: number };
  text?: string;
  summary?: string;
  status?: string;
  reason?: string;
  model?: { providerID?: string; id?: string; variant?: string };
  content?: ContentPart[];
  files?: Array<{ name?: string; description?: string }>;
  [key: string]: unknown;
}

export interface SummaryRecord {
  /** Stable id: the compaction message id. */
  id: string;
  messageID: string;
  sessionID: string;
  projectID: string;
  created: number;
  title: string;
  model?: string;
  reason?: string;
  body: string;
  path: string;
  bytes: number;
}

export interface IndexDoc {
  id: string;
  projectID: string;
  sessionID: string;
  messageID?: string;
  kind: MessageKind;
  created: number;
  title?: string;
  text: string;
}

export interface SearchHit extends IndexDoc {
  snippet: string;
  rank: number;
  /** Which layer(s) surfaced the hit in hybrid search. */
  via?: "fts" | "vec" | "fts+vec";
}

/** One chunk vector for a document (stored as a BLOB of float32 bytes). */
export interface VectorRow {
  docID: string;
  projectID: string;
  kind: MessageKind;
  model: string;
  contentHash: string;
  chunk: number;
  vec: Float32Array;
}

/** Current vector state of a document, across all its chunks. */
export interface VectorState {
  model: string;
  projectID: string;
  contentHash: string;
  chunks: number;
}

export interface IndexState {
  updatedAt: number;
  projectID: string;
}

/**
 * Local CPU embedding layer. Models run on-device through onnxruntime (the
 * native addon, with an onnxruntime-web fallback if it is installed); no
 * remote service is involved. The vector layer augments — and never
 * replaces — the FTS5 index: when the engine is unavailable, search simply
 * degrades to keyword-only.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Runtime } from "./runtime.js";
import { embedDisabled, embedModelName, embedModelsDir } from "./paths.js";
import type { IndexDoc, VectorRow } from "./types.js";
import { clip } from "./util.js";

/** Cap on the text that is embedded per document (chars, before chunking). */
export const VECTOR_TEXT_MAX = 4096;

export interface ModelSpec {
  id: string;
  dim: number;
  /** Maximum sequence length the model accepts (tokens). */
  maxLen: number;
  queryPrefix: string;
  docPrefix: string;
  pooling: "cls" | "mean";
  /** file -> minimum expected size (bytes), used as the download integrity check. */
  minSizes: Record<string, number>;
  urls: Record<string, string>;
}

const MINILM_BASE = "https://huggingface.co/Qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q/resolve/main";
const E5_BASE = "https://huggingface.co/Xenova/multilingual-e5-large/resolve/main";

/**
 * Phase 0 verdict (real corpus, PT intent queries): minilm-qint8 is the
 * default — decisive recall margin and ~3x faster. e5-large-qint8 works but
 * its ONNX export has a compressed score space (low margin); keep it as an
 * opt-in.
 */
export const EMBED_MODELS: Record<string, ModelSpec> = {
  "minilm-qint8": {
    id: "minilm-qint8",
    dim: 384,
    maxLen: 128,
    queryPrefix: "",
    docPrefix: "",
    pooling: "mean",
    minSizes: { "model.onnx": 200_000_000, "tokenizer.json": 1_000_000, "tokenizer_config.json": 100 },
    urls: {
      "model.onnx": `${MINILM_BASE}/model_optimized.onnx`,
      "tokenizer.json": `${MINILM_BASE}/tokenizer.json`,
      "tokenizer_config.json": `${MINILM_BASE}/tokenizer_config.json`,
    },
  },
  "e5-large-qint8": {
    id: "e5-large-qint8",
    dim: 1024,
    maxLen: 512,
    queryPrefix: "query: ",
    docPrefix: "",
    pooling: "mean",
    minSizes: { "model.onnx": 500_000_000, "tokenizer.json": 1_000_000, "tokenizer_config.json": 100 },
    urls: {
      "model.onnx": `${E5_BASE}/onnx/model_quantized.onnx`,
      "tokenizer.json": `${E5_BASE}/tokenizer.json`,
      "tokenizer_config.json": `${E5_BASE}/tokenizer_config.json`,
    },
  },
};

export interface EmbedderEngine {
  readonly model: string;
  readonly spec: ModelSpec;
  /** One text -> L2-normalized vector. */
  embedText(text: string): Promise<Float32Array>;
  /** Several texts -> L2-normalized vectors (same order). */
  embedMany(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Split text into character chunks of about `maxChars`, preferring to break
 * at whitespace/newline boundaries when that is close to the limit.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (maxChars < 8) throw new Error("chunkText: maxChars too small");
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const best = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (best > start + Math.floor(maxChars / 2)) end = best + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

/** Characters per chunk for a model: conservative chars/token estimate. */
export function charsPerChunk(spec: ModelSpec): number {
  return Math.max(32, Math.round(spec.maxLen * 1.6));
}

/** L2-normalize a vector (a zero vector is returned as-is). */
export function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const value = vec[i] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] ?? 0) / norm;
  return out;
}

/** Cosine similarity; 0 for zero vectors or mismatched dimensions. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable identity of the embedded text (sha256 hex). */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reciprocal-rank fusion constant. */
export const RRF_K = 60;

export interface FusedHit {
  id: string;
  via: "fts" | "vec" | "fts+vec";
  score: number;
}

/**
 * Fuse two ranked id lists with RRF (k = 60). Ties break toward the FTS
 * ranking (the keyword index stays primary), then the vector ranking.
 */
export function rrfFuse(ftsIds: string[], vecIds: string[], limit: number): FusedHit[] {
  interface Entry {
    score: number;
    ftsRank: number;
    vecRank: number;
    inFts: boolean;
    inVec: boolean;
  }
  const map = new Map<string, Entry>();
  const add = (id: string, rank: number, which: "fts" | "vec") => {
    const entry = map.get(id) ?? { score: 0, ftsRank: Infinity, vecRank: Infinity, inFts: false, inVec: false };
    if (which === "fts") {
      if (entry.inFts) return; // duplicate id: keep the first rank
      entry.inFts = true;
      entry.ftsRank = rank;
    } else {
      if (entry.inVec) return;
      entry.inVec = true;
      entry.vecRank = rank;
    }
    entry.score += 1 / (RRF_K + rank + 1);
    map.set(id, entry);
  };
  ftsIds.forEach((id, i) => add(id, i, "fts"));
  vecIds.forEach((id, i) => add(id, i, "vec"));
  const out: FusedHit[] = [...map.entries()].map(([id, e]) => ({
    id,
    score: e.score,
    via: e.inFts && e.inVec ? "fts+vec" : e.inFts ? "fts" : "vec",
  }));
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = map.get(a.id)!.ftsRank;
    const rb = map.get(b.id)!.ftsRank;
    if (ra !== rb) return ra - rb;
    return map.get(a.id)!.vecRank - map.get(b.id)!.vecRank;
  });
  return out.slice(0, Math.max(1, limit));
}

class CpuEmbedder implements EmbedderEngine {
  readonly spec: ModelSpec;
  private ort!: any;
  private session!: any;
  private tokenizer!: any;

  constructor(spec: ModelSpec) {
    this.spec = spec;
  }

  get model(): string {
    return this.spec.id;
  }

  async init(): Promise<void> {
    const dir = join(embedModelsDir(), this.spec.id);
    for (const [file, url] of Object.entries(this.spec.urls)) {
      await ensureFile(join(dir, file), url, this.spec.minSizes[file] ?? 0);
    }
    this.ort = await loadOrt();
    this.session = await this.ort.InferenceSession.create(join(dir, "model.onnx"), {
      executionProviders: ["cpu"],
    });
    const { AutoTokenizer } = await import("@huggingface/transformers");
    this.tokenizer = await AutoTokenizer.from_pretrained(dir);
  }

  async embedText(text: string): Promise<Float32Array> {
    return this.encode(text);
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) out.push(await this.encode(text));
    return out;
  }

  private async encode(text: string): Promise<Float32Array> {
    const enc = this.tokenizer(text, {
      max_length: this.spec.maxLen,
      truncation: true,
      padding: false,
      return_tensor: false,
    });
    const n = enc.input_ids.length;
    const feed: Record<string, unknown> = {};
    for (const name of this.session.inputNames as string[]) {
      let values: number[];
      if (name === "input_ids") values = enc.input_ids;
      else if (name === "attention_mask") values = enc.attention_mask;
      else if (name === "token_type_ids") values = enc.token_type_ids ?? enc.input_ids.map(() => 0);
      else values = enc.input_ids.map(() => 0); // unknown int input: zeros
      feed[name] = new this.ort.Tensor("int64", new BigInt64Array(values.map(BigInt)), [1, values.length]);
    }
    const results = await this.session.run(feed);
    const out = results[this.session.outputNames[0]];
    const dim = out.dims[out.dims.length - 1] as number;
    const hidden = new Float32Array(out.data);
    const vec = new Float32Array(dim);
    if (this.spec.pooling === "cls") {
      for (let d = 0; d < dim; d++) vec[d] = hidden[d] ?? 0;
    } else {
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (!enc.attention_mask[i]) continue;
        count++;
        const off = i * dim;
        for (let d = 0; d < dim; d++) vec[d] = (vec[d] ?? 0) + (hidden[off + d] ?? 0);
      }
      if (count > 0) for (let d = 0; d < dim; d++) vec[d] = (vec[d] ?? 0) / count;
    }
    return normalize(vec);
  }
}

/** Download a model file (missing or too small) atomically into the data dir. */
async function ensureFile(path: string, url: string, minBytes: number): Promise<void> {
  let stale = false;
  try {
    const info = await stat(path);
    if (info.size < minBytes) stale = true;
  } catch {
    stale = true;
  }
  if (!stale) return;
  const tmp = `${path}.part-${Date.now()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (minBytes > 0 && bytes.byteLength < minBytes) {
      throw new Error(`download too small (${bytes.byteLength} < ${minBytes} bytes)`);
    }
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// The import is indirect so a missing optional fallback does not break typecheck.
const WEB_RUNTIME_NAME = "onnxruntime-web";

/** Load the ORT engine: native addon first, WASM build as a fallback. */
async function loadOrt(): Promise<any> {
  try {
    const mod: any = await import("onnxruntime-node");
    const ort = mod?.default ?? mod;
    if (ort?.InferenceSession?.create) return ort;
  } catch {
    // Native addon failed to load; try the WASM build if present.
  }
  try {
    const mod: any = await import(WEB_RUNTIME_NAME);
    const ort = mod?.default ?? mod;
    if (ort?.InferenceSession?.create) return ort;
  } catch {
    // Neither runtime is available.
  }
  throw new Error("onnxruntime is unavailable (native addon and web build both failed to load)");
}

let enginePromise: Promise<EmbedderEngine | undefined> | undefined;

/**
 * Singleton engine for the active model (MEMORY_EMBED_MODEL). Resolves to
 * undefined when embedding is disabled or the engine cannot start; callers
 * then fall back to keyword-only search.
 */
export function getEngine(): Promise<EmbedderEngine | undefined> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (embedDisabled()) return undefined;
    const spec = EMBED_MODELS[embedModelName()];
    if (!spec) {
      console.error(
        `[memory] unknown embedding model "${embedModelName()}"; available: ${Object.keys(EMBED_MODELS).join(", ")}`,
      );
      return undefined;
    }
    try {
      const engine = new CpuEmbedder(spec);
      await engine.init();
      return engine;
    } catch (error) {
      console.error(`[memory] embed engine unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  })();
  return enginePromise;
}

/** Test hook: forget the cached engine promise. */
export function resetEngine(): void {
  enginePromise = undefined;
}

export interface EmbedStats {
  embedded: number;
  skipped: number;
  /** Vectors kept as-is but moved to the document's current project. */
  rehomed: number;
}

/**
 * Embed the given documents, replacing any previous vectors for a document.
 * Documents whose stored vector already matches the current text and model
 * are skipped (a project move only re-buckets the vectors). Never throws:
 * per-document failures are logged and the keyword-only behavior stands.
 * MEMORY_EMBED_DISABLED gates the auto-acquired engine only; an explicitly
 * passed engine always runs (tests inject a fake one).
 */
export async function embedDocs(runtime: Runtime, docs: IndexDoc[], engine?: EmbedderEngine): Promise<EmbedStats> {
  const stats: EmbedStats = { embedded: 0, skipped: 0, rehomed: 0 };
  if (docs.length === 0) return stats;
  const eng = engine ?? (embedDisabled() ? undefined : await getEngine());
  if (!eng) return stats;
  for (const doc of docs) {
    const text = clip(doc.text, VECTOR_TEXT_MAX, "");
    if (!text.trim()) continue;
    const hash = hashText(text);
    try {
      const state = await runtime.index.vectorState(doc.id);
      if (state && state.model === eng.model && state.contentHash === hash) {
        if (state.projectID === doc.projectID) {
          stats.skipped++;
          continue;
        }
        // The document changed project (session moved directories). Same
        // text and model, so the vectors are still valid: re-bucket them
        // instead of re-embedding.
        await runtime.index.rehomeVectors(doc.id, doc.projectID, doc.kind);
        stats.rehomed++;
        continue;
      }
      const chunks = chunkText(text, charsPerChunk(eng.spec));
      if (chunks.length === 0) continue;
      const vecs = await eng.embedMany(chunks.map((chunk) => eng.spec.docPrefix + chunk));
      const rows: VectorRow[] = vecs.map((vec, chunk) => ({
        docID: doc.id,
        projectID: doc.projectID,
        kind: doc.kind,
        model: eng.model,
        contentHash: hash,
        chunk,
        vec,
      }));
      await runtime.index.upsertVectors(rows);
      stats.embedded++;
    } catch (error) {
      console.error(`[memory] embedding failed for ${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return stats;
}

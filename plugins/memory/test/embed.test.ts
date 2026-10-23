import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { PluginContext } from "../context.js";
import {
  EMBED_MODELS,
  VECTOR_TEXT_MAX,
  charsPerChunk,
  chunkText,
  cosine,
  embedDocs,
  hashText,
  normalize,
  resetEngine,
  rrfFuse,
} from "../embed.js";
import type { EmbedderEngine } from "../embed.js";
import { JsonIndex, openIndex } from "../index-db.js";
import { jsonIndexPath } from "../paths.js";
import { createRuntime } from "../runtime.js";
import type { IndexDoc } from "../types.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

let dataDir = "";

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-embed-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  delete process.env.MEMORY_EMBED_DISABLED;
  resetEngine();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

function doc(
  id: string,
  text: string,
  projectID = "pT",
  kind: "user" | "assistant" | "summary" = "user",
): IndexDoc {
  return { id, projectID, sessionID: "ses_t", kind, created: 1700000000000, title: "T", text };
}

/** Deterministic stand-in for the ORT engine: same text, same vector. */
function fakeEngine() {
  const spec = EMBED_MODELS["minilm-qint8"]!;
  const calls: string[] = [];
  const embedText = async (text: string): Promise<Float32Array> => {
    calls.push(text);
    const vec = new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      vec[i] = ((text.charCodeAt((i * 7) % Math.max(1, text.length)) ?? 0) + i * 13) % 17;
    }
    return normalize(vec);
  };
  const engine: EmbedderEngine = {
    model: spec.id,
    spec,
    embedText,
    embedMany: (texts) => Promise.all(texts.map(embedText)),
  };
  return { engine, calls };
}

async function freshRuntime() {
  const index = await openIndex();
  const runtime = createRuntime({} as unknown as PluginContext, index);
  return { index, runtime };
}

describe("pure helpers", () => {
  test("chunkText breaks at word boundaries when close to the limit", () => {
    const word = "x".repeat(74); // 74 chars, no inner spaces
    const text = [word, word, word].join(" "); // 224 chars; separators at 74 and 149
    expect(chunkText(text, 80)).toEqual([word, word, word]);
  });

  test("chunkText covers the text without dropping content", () => {
    const text = "x".repeat(500) + " y".repeat(30);
    const chunks = chunkText(text, 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  test("charsPerChunk derives a conservative char budget per model", () => {
    expect(charsPerChunk(EMBED_MODELS["minilm-qint8"]!)).toBe(Math.round(128 * 1.6));
    expect(charsPerChunk(EMBED_MODELS["e5-large-qint8"]!)).toBe(Math.round(512 * 1.6));
  });

  test("normalize and cosine behave", () => {
    const v = new Float32Array([3, 4, 0]);
    const n = normalize(v);
    expect(Math.sqrt((n[0] ?? 0) ** 2 + (n[1] ?? 0) ** 2)).toBeCloseTo(1);
    expect(cosine(v, n)).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0); // dim mismatch
    expect(cosine(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0); // zero vector
  });

  test("hashText is deterministic and content-sensitive", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("abc").length).toBe(64);
  });

  test("rrfFuse ranks shared ids first and tags the via origin", () => {
    const fused = rrfFuse(["a", "b", "c"], ["c", "d"], 10);
    expect(fused.map((hit) => hit.id)).toEqual(["c", "a", "b", "d"]);
    expect(fused[0]!.via).toBe("fts+vec");
    expect(fused[3]!.via).toBe("vec");
  });

  test("rrfFuse applies the limit and degrades to a single list", () => {
    expect(rrfFuse(["a", "b"], [], 1)).toEqual([{ id: "a", via: "fts", score: 1 / 61 }]);
    expect(rrfFuse([], ["x", "y"], 5).map((hit) => hit.via)).toEqual(["vec", "vec"]);
  });
});

describe("SqliteIndex vector store", () => {
  test("roundtrip, replacement, prune and cleanup", async () => {
    const index = await openIndex();
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    const c = new Float32Array([0, 0, 1, 0]);

    await index.upsertVectors([
      { docID: "d1", projectID: "pA", kind: "user", model: "m1", contentHash: "h1", chunk: 0, vec: a },
      { docID: "d1", projectID: "pA", kind: "user", model: "m1", contentHash: "h1", chunk: 1, vec: b },
      { docID: "d2", projectID: "pB", kind: "summary", model: "m1", contentHash: "h2", chunk: 0, vec: c },
    ]);

    expect(await index.vectorState("d1")).toEqual({ model: "m1", projectID: "pA", contentHash: "h1", chunks: 2 });

    const loaded = await index.loadVectors("m1");
    expect(loaded.get("d1")!.vecs).toHaveLength(2);
    expect(cosine(loaded.get("d1")!.vecs[0]!, a)).toBeCloseTo(1);
    expect(await index.vectorCount("m1")).toBe(2);
    expect(await index.vectorCount("m1", "pA")).toBe(1);

    // Replacement drops stale chunks of a shorter document.
    await index.upsertVectors([
      { docID: "d1", projectID: "pA", kind: "user", model: "m1", contentHash: "h1b", chunk: 0, vec: b },
    ]);
    expect((await index.vectorState("d1"))!.chunks).toBe(1);
    expect((await index.loadVectors("m1")).get("d1")!.vecs).toHaveLength(1);

    // Vectors from other models are pruned; the current model is untouched.
    // (upsertVectors replaces a document's whole vector set, so d2 now
    // carries only the m2 vector.)
    await index.upsertVectors([
      { docID: "d2", projectID: "pB", kind: "summary", model: "m2", contentHash: "h2x", chunk: 0, vec: a },
    ]);
    expect(await index.pruneOldVectors("m1")).toBe(1);
    expect(await index.vectorCount("m2")).toBe(0);
    expect(await index.vectorCount("m1")).toBe(1);

    // Removing a document clears its vectors too.
    await index.remove(["d1"]);
    expect(await index.vectorState("d1")).toBeUndefined();
    expect(await index.vectorCount("m1")).toBe(0);

    // clearProject and clearAll cascade into the vector table.
    await index.clearProject("pB");
    expect(await index.vectorState("d2")).toBeUndefined();
    await index.upsertVectors([
      { docID: "d3", projectID: "pC", kind: "assistant", model: "m1", contentHash: "h3", chunk: 0, vec: a },
    ]);
    await index.clearAll();
    expect(await index.vectorCount("m1")).toBe(0);
    expect((await index.docs()).length).toBe(0);

    await index.close();
  });

  test("docs and docsByIds return indexed documents", async () => {
    const index = await openIndex();
    await index.upsert([doc("dX", "alpha text"), doc("dY", "beta text", "pZ", "summary")]);
    expect((await index.docs()).map((d) => d.id).sort()).toEqual(["dX", "dY"]);
    expect((await index.docs("pZ")).map((d) => d.id)).toEqual(["dY"]);
    expect((await index.docsByIds(["dX", "missing"])).map((d) => d.id)).toEqual(["dX"]);
    await index.close();
  });
});

describe("JsonIndex vector stubs", () => {
  test("vector methods are no-ops and docs helpers work", async () => {
    const index = await JsonIndex.open(jsonIndexPath(), "test");
    await index.upsert([doc("j1", "hello json"), doc("j2", "world json", "pJ", "summary")]);
    await index.upsertVectors([
      { docID: "j1", projectID: "pJ", kind: "user", model: "m", contentHash: "h", chunk: 0, vec: new Float32Array([1]) },
    ]);
    expect(await index.vectorState("j1")).toBeUndefined();
    expect((await index.loadVectors("m")).size).toBe(0);
    expect(await index.vectorCount("m")).toBe(0);
    expect(await index.pruneOldVectors("m")).toBe(0);
    expect((await index.docs()).map((d) => d.id).sort()).toEqual(["j1", "j2"]);
    expect((await index.docs("pJ")).map((d) => d.id)).toEqual(["j2"]);
    expect((await index.docsByIds(["j1", "nope"])).map((d) => d.id)).toEqual(["j1"]);
    await index.close();
  });
});

describe("embedDocs", () => {
  test("embeds, skips unchanged text, re-embeds changed text", async () => {
    const { index, runtime } = await freshRuntime();
    const { engine } = fakeEngine();
    const d1 = doc("e1", "primeiro texto do documento");

    await index.upsert([d1]);
    expect(await embedDocs(runtime, [d1], engine)).toEqual({ embedded: 1, skipped: 0, rehomed: 0 });
    expect(await index.vectorState("e1")).toMatchObject({ model: "minilm-qint8" });

    expect(await embedDocs(runtime, [d1], engine)).toEqual({ embedded: 0, skipped: 1, rehomed: 0 });

    const changed = { ...d1, text: "texto diferente agora" };
    expect(await embedDocs(runtime, [changed], engine)).toEqual({ embedded: 1, skipped: 0, rehomed: 0 });
    expect((await index.vectorState("e1"))!.contentHash).toBe(hashText(changed.text));

    // Text longer than the cap is embedded (and hashed) at the capped length.
    const long = doc("e2", "x".repeat(VECTOR_TEXT_MAX + 100));
    await index.upsert([long]);
    await embedDocs(runtime, [long], engine);
    expect((await index.vectorState("e2"))!.contentHash).toBe(hashText(long.text.slice(0, VECTOR_TEXT_MAX)));

    // A long document produces more than one chunk vector.
    const many = doc("e3", "lorem ipsum ".repeat(60));
    await index.upsert([many]);
    await embedDocs(runtime, [many], engine);
    expect((await index.vectorState("e3"))!.chunks).toBeGreaterThan(1);

    await index.close();
  });

  test("re-homes vectors when a document changes project (session move)", async () => {
    const { index, runtime } = await freshRuntime();
    const { engine, calls } = fakeEngine();
    const d = doc("e10", "texto que muda de projeto", "pA");

    await index.upsert([d]);
    await embedDocs(runtime, [d], engine);
    expect(await index.vectorState("e10")).toMatchObject({ projectID: "pA" });

    // The session moves to pB: the index re-upserts the doc under pB, the
    // text is unchanged, so no re-embedding must happen — only a re-bucket.
    const moved = { ...d, projectID: "pB" };
    await index.upsert([moved]);
    const before = calls.length;
    const stats = await embedDocs(runtime, [moved], engine);

    expect(stats).toEqual({ embedded: 0, skipped: 0, rehomed: 1 });
    expect(calls.length).toBe(before);
    expect(await index.vectorState("e10")).toMatchObject({ projectID: "pB" });
    expect((await index.loadVectors("minilm-qint8", "pB")).has("e10")).toBe(true);
    expect((await index.loadVectors("minilm-qint8", "pA")).has("e10")).toBe(false);

    // A second pass with the doc already in pB is a plain skip.
    expect(await embedDocs(runtime, [moved], engine)).toEqual({ embedded: 0, skipped: 1, rehomed: 0 });

    await index.close();
  });

  test("is a no-op when embedding is disabled (no explicit engine)", async () => {
    const { index, runtime } = await freshRuntime();
    process.env.MEMORY_EMBED_DISABLED = "1";
    try {
      expect(await embedDocs(runtime, [doc("e9", "any text")])).toEqual({ embedded: 0, skipped: 0, rehomed: 0 });
      expect(await index.vectorState("e9")).toBeUndefined();
    } finally {
      delete process.env.MEMORY_EMBED_DISABLED;
    }
    await index.close();
  });
});

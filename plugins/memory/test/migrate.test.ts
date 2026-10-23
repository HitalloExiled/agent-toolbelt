import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginContext } from "../context.js";
import { embedDocs, EMBED_MODELS } from "../embed.js";
import type { EmbedderEngine } from "../embed.js";
import { normalize } from "../embed.js";
import { openIndex } from "../index-db.js";
import { indexSummaryFiles } from "../indexer.js";
import { createRuntime } from "../runtime.js";
import { formatFrontmatter } from "../storage.js";
import { listSummaries, migrateSessionSummaries, summaryPath } from "../summaries.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

let dataDir = "";

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-migrate-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  // indexSummaryFiles fires background embedding: keep the engine off so the
  // suite never downloads model weights (the fake engine below stands in).
  process.env.MEMORY_EMBED_DISABLED = "1";
});

afterAll(async () => {
  delete process.env.MEMORY_EMBED_DISABLED;
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

async function writeSummary(
  projectID: string,
  messageID: string,
  created: number,
  body: string,
  sessionID = "ses_fake",
  title = "Fake summary",
): Promise<void> {
  const path = summaryPath(projectID, created, messageID);
  await mkdir(dirname(path), { recursive: true });
  const frontmatter = formatFrontmatter({
    id: messageID,
    messageID,
    sessionID,
    projectID,
    created,
    createdISO: new Date(created).toISOString(),
    title,
  });
  await writeFile(path, `${frontmatter}\n\n${body}\n`);
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

describe("migrateSessionSummaries", () => {
  test("moves a session's summaries to the new bucket and rewrites the frontmatter", async () => {
    await writeSummary("pA", "msg_s1", 1760000001000, "body one", "ses_move");
    await writeSummary("pA", "msg_s2", 1760000002000, "body two", "ses_move");
    await writeSummary("pA", "msg_other", 1760000003000, "other session body", "ses_stay");

    const moved = await migrateSessionSummaries("pA", "pB", "ses_move");
    expect(moved).toBe(2);

    expect((await listSummaries("pA", 10)).map((r) => r.messageID)).toEqual(["msg_other"]);
    const inB = await listSummaries("pB", 10);
    expect(inB.map((r) => r.messageID).sort()).toEqual(["msg_s1", "msg_s2"]);
    expect(inB.every((r) => r.projectID === "pB" && r.sessionID === "ses_move")).toBe(true);
    expect(inB.find((r) => r.messageID === "msg_s1")!.body).toBe("body one"); // body untouched
  });

  test("is idempotent and a no-op for unknown sessions or the same project", async () => {
    expect(await migrateSessionSummaries("pA", "pB", "ses_move")).toBe(0); // already moved
    expect(await migrateSessionSummaries("pA", "pB", "ses_nobody")).toBe(0);
    expect(await migrateSessionSummaries("pC", "pC", "ses_move")).toBe(0);
  });

  test("skips a conflicting copy already in the target bucket", async () => {
    await writeSummary("pD", "msg_conf", 1760000004000, "body from D", "ses_move");
    await writeSummary("pE", "msg_conf", 1760000004000, "body from E", "ses_move");

    expect(await migrateSessionSummaries("pD", "pE", "ses_move")).toBe(0);
    // Both copies survive; the E copy is authoritative (written there first).
    expect((await listSummaries("pD", 10)).map((r) => r.messageID)).toEqual(["msg_conf"]);
    expect((await listSummaries("pE", 10)).map((r) => r.body)).toEqual(["body from E"]);
  });
});

describe("migration and the derived index", () => {
  test("the index follows the moved summaries", async () => {
    const index = await openIndex();
    const runtime = createRuntime({} as unknown as PluginContext, index);
    await writeSummary("pI", "msg_i1", 1760000010000, "objective alpha", "ses_move");
    await writeSummary("pI", "msg_i2", 1760000011000, "objective beta", "ses_move");

    await indexSummaryFiles(runtime, "pI");
    expect(await index.summaryIDs("pI")).toHaveLength(2);

    await migrateSessionSummaries("pI", "pJ", "ses_move");
    await indexSummaryFiles(runtime, "pJ");
    expect(await index.summaryIDs("pJ")).toHaveLength(2);
    expect((await index.docs("pJ")).every((doc) => doc.projectID === "pJ")).toBe(true);

    // Reconciling the old project must not resurrect the moved docs.
    await indexSummaryFiles(runtime, "pI");
    expect(await index.summaryIDs("pI")).toHaveLength(0);
    expect(await index.summaryIDs("pJ")).toHaveLength(2);

    await index.close();
  });

  test("vectors follow the migration without re-embedding", async () => {
    const index = await openIndex();
    const runtime = createRuntime({} as unknown as PluginContext, index);
    const { engine, calls } = fakeEngine();
    await writeSummary("pV", "msg_v1", 1760000020000, "objective vector", "ses_move");

    await indexSummaryFiles(runtime, "pV");
    await embedDocs(runtime, await index.docs("pV"), engine);
    expect((await index.vectorState("summary:msg_v1"))!.projectID).toBe("pV");
    const before = calls.length;

    await migrateSessionSummaries("pV", "pW", "ses_move");
    await indexSummaryFiles(runtime, "pW");
    const stats = await embedDocs(runtime, await index.docs("pW"), engine);

    expect(stats.rehomed).toBe(1);
    expect(stats.embedded).toBe(0);
    expect(calls.length).toBe(before); // no re-embedding
    expect((await index.vectorState("summary:msg_v1"))!.projectID).toBe("pW");
    expect((await index.loadVectors(engine.model, "pW")).has("summary:msg_v1")).toBe(true);

    await index.close();
  });
});

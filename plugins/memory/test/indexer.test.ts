import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginContext } from "../context.js";
import { openIndex } from "../index-db.js";
import { indexAllProjects, indexSummaryFiles } from "../indexer.js";
import { createRuntime } from "../runtime.js";
import { formatFrontmatter } from "../storage.js";
import { summaryPath } from "../summaries.js";
import type { MessageLike, SessionInfoLike } from "../types.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

let dataDir = "";

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-indexer-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  // No live service in unit tests: the project list degrades to empty and
  // nothing talks to the real OpenCode server.
  process.env.OPENCODE_SERVICE_FILE = join(dataDir, "no-service.json");
  // indexSummaryFiles fires background embedding: keep the engine off so the
  // suite never downloads model weights (embed logic is tested separately
  // with a fake engine in embed.test.ts).
  process.env.MEMORY_EMBED_DISABLED = "1";
});

afterAll(async () => {
  delete process.env.MEMORY_EMBED_DISABLED;
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

/** A minimal in-process session domain, mirroring the shapes the plugin expects. */
function fakeCtx(sessions: SessionInfoLike[], messagesBySession: Record<string, MessageLike[]>): PluginContext {
  return {
    session: {
      list: async (input: { project?: string }) => ({
        data: input.project ? sessions.filter((s) => s.projectID === input.project) : sessions,
      }),
      get: async (input: { sessionID: string }) => sessions.find((s) => s.id === input.sessionID),
      context: async (input: { sessionID: string }) => messagesBySession[input.sessionID] ?? [],
      message: {
        list: async (input: { sessionID: string; limit?: number }) => ({
          data: (messagesBySession[input.sessionID] ?? []).slice(-Math.max(1, input.limit ?? 100)),
          cursor: null,
        }),
        get: async (input: { sessionID: string; messageID: string }) => {
          const message = (messagesBySession[input.sessionID] ?? []).find((m) => m.id === input.messageID);
          if (!message) throw new Error(`message ${input.messageID} not found`);
          return message;
        },
      },
    },
  } as unknown as PluginContext;
}

async function writeSummary(projectID: string, messageID: string, created: number, body: string): Promise<void> {
  const path = summaryPath(projectID, created, messageID);
  await mkdir(dirname(path), { recursive: true });
  const frontmatter = formatFrontmatter({
    id: messageID,
    messageID,
    sessionID: "ses_fake",
    projectID,
    created,
    createdISO: new Date(created).toISOString(),
    title: "Fake summary",
  });
  await writeFile(path, `${frontmatter}\n\n${body}\n`);
}

// dataDir only exists after beforeAll, so this must be a function.
const qAFiles = () => join(dataDir, "compactions", "qA");

describe("indexSummaryFiles", () => {
  test("never deletes summary files: the read path is read-only (bug B proof)", async () => {
    const index = await openIndex();
    const runtime = createRuntime(fakeCtx([], {}), index);

    // 25 files while the default keep is 20: a pruning read path would delete 5.
    for (let i = 0; i < 25; i++) {
      await writeSummary("qA", `msg_fake_${String(i).padStart(2, "0")}`, 1760000000000 + i * 1000, `summary body ${i}`);
    }
    expect((await readdir(qAFiles()))).toHaveLength(25);

    await indexSummaryFiles(runtime, "qA");

    expect((await readdir(qAFiles()))).toHaveLength(25);
    expect(await index.summaryIDs("qA")).toHaveLength(25);
    await index.close();
  });

  test("reconciles the index when a file disappears", async () => {
    const index = await openIndex();
    const runtime = createRuntime(fakeCtx([], {}), index);

    const before = (await index.summaryIDs("qA")).length;
    await rm(join(qAFiles(), (await readdir(qAFiles()))[0]!), { force: true });

    await indexSummaryFiles(runtime, "qA");
    expect((await index.summaryIDs("qA")).length).toBe(before - 1);
    expect((await readdir(qAFiles()))).toHaveLength(before - 1);
    await index.close();
  });
});

describe("indexAllProjects", () => {
  test("indexes every project and is incremental on the second run", async () => {
    const index = await openIndex();

    const sessions: SessionInfoLike[] = [
      { id: "ses_p1", projectID: "pX", title: "In X", location: { directory: "/x" }, time: { created: 1000, updated: 5000 } },
      { id: "ses_p2", projectID: "pY", title: "In Y", location: { directory: "/y" }, time: { created: 1000, updated: 5000 } },
    ];
    const messages: Record<string, MessageLike[]> = {
      ses_p1: [{ type: "user", id: "msg_x1", text: "hello from x", time: { created: 1000 } }],
      ses_p2: [{ type: "user", id: "msg_y1", text: "hello from y", time: { created: 2000 } }],
    };
    // A summary file makes project pY a known bucket even without the service.
    await writeSummary("pY", "msg_y_sum", 1760000010000, "objective body alpha");

    const runtime = createRuntime(fakeCtx(sessions, messages), index);
    const first = await indexAllProjects(runtime, { currentProjectID: "pX" });

    expect(first.totals.projects).toBe(3); // pX (current), pY and qA (on disk)
    const hits = await index.search("hello from", { scope: "all", kind: "any", limit: 10 });
    expect(hits.map((hit) => hit.sessionID).sort()).toEqual(["ses_p1", "ses_p2"]);
    const countAfterFirst = await index.count();

    const second = await indexAllProjects(runtime, { currentProjectID: "pX" });
    // Already-indexed sessions are skipped on the second pass.
    expect(second.projects.every((project) => project.sessions === 0)).toBe(true);
    expect(await index.count()).toBe(countAfterFirst);
    await index.close();
  });

  test("rebuild clears the index before reindexing", async () => {
    const index = await openIndex();
    const sessions: SessionInfoLike[] = [
      { id: "ses_r1", projectID: "pR", title: "In R", location: { directory: "/r" }, time: { created: 1000, updated: 5000 } },
    ];
    const messages: Record<string, MessageLike[]> = {
      ses_r1: [{ type: "user", id: "msg_r1", text: "rebuild marker word", time: { created: 1000 } }],
    };
    const runtime = createRuntime(fakeCtx(sessions, messages), index);

    await indexAllProjects(runtime, { currentProjectID: "pR" });
    expect((await index.search("marker word", { scope: "all", kind: "any", limit: 10 })).length).toBeGreaterThan(0);

    const rebuilt = await indexAllProjects(runtime, { currentProjectID: "pR", rebuild: true });
    expect(rebuilt.projects.some((project) => project.projectID === "pR")).toBe(true);
    expect((await index.search("marker word", { scope: "all", kind: "any", limit: 10 })).length).toBeGreaterThan(0);
    await index.close();
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { compactionsRoot } from "../paths.js";
import { parseFrontmatter } from "../storage.js";
import {
  captureCompaction,
  extractSections,
  findSection,
  findSummary,
  listSummaries,
  objectiveLine,
  pruneSummaries,
  searchSummaries,
  summaryPath,
} from "../summaries.js";
import type { MessageLike, SessionInfoLike } from "../types.js";

let dataDir = "";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-summaries-"));
  process.env.MEMORY_DATA_DIR = dataDir;
  process.env.MEMORY_SUMMARY_KEEP = "20";
});

afterAll(async () => {
  delete process.env.MEMORY_SUMMARY_KEEP;
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

const session: SessionInfoLike = { id: "ses_test", projectID: "pA", title: "Test session" };

function compaction(id: string, created: number, body: string): MessageLike {
  return {
    id,
    type: "compaction",
    status: "completed",
    summary: body,
    time: { created },
    model: { providerID: "opencode", id: "test-model" },
  };
}

const BODY = "## Objective\n- do the thing\n\n## Next Move\n- keep going";

describe("captureCompaction", () => {
  test("writes one markdown file per compaction and is idempotent", async () => {
    const created = 1760000000000;
    const first = await captureCompaction("pA", session, compaction("msg_cap1", created, BODY));
    expect(first?.fresh).toBe(true);
    expect(first?.record.projectID).toBe("pA");
    expect(first?.record.sessionID).toBe("ses_test");
    expect(first?.record.path).toBe(summaryPath("pA", created, "msg_cap1"));

    const second = await captureCompaction("pA", session, compaction("msg_cap1", created, "different body"));
    expect(second?.fresh).toBe(false);

    const onDisk = await listSummaries("pA", 10);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.id).toBe("msg_cap1");
    expect(onDisk[0]!.body).toBe(BODY); // the second capture must not overwrite
  });

  test("re-homing to another bucket removes the stale copy", async () => {
    await captureCompaction("global", session, compaction("msg_rehome", 1760000001000, BODY));
    expect((await listSummaries("global", 10))).toHaveLength(1);

    await captureCompaction("pA", session, compaction("msg_rehome", 1760000001000, BODY));
    expect((await listSummaries("global", 10))).toHaveLength(0);
    expect((await listSummaries("pA", 10)).some((record) => record.id === "msg_rehome")).toBe(true);
  });

  test("does not capture pending or empty compactions", async () => {
    expect(
      await captureCompaction("pA", session, { ...compaction("msg_skip", 1760000002000, ""), status: "pending" }),
    ).toBeUndefined();
    expect((await listSummaries("pA", 10)).some((record) => record.id === "msg_skip")).toBe(false);
  });
});

describe("pruneSummaries", () => {
  test("keeps only the most recent summaries (write path only)", async () => {
    // Capture at the default keep so all five files accumulate...
    for (let i = 0; i < 5; i++) {
      await captureCompaction("pPrune", session, compaction(`msg_prune_${i}`, 1760000100000 + i * 1000, BODY));
    }
    // ...then tighten the keep and prune (write path only).
    process.env.MEMORY_SUMMARY_KEEP = "3";
    try {
      const removed = await pruneSummaries("pPrune");
      expect(removed.sort()).toEqual(["msg_prune_0", "msg_prune_1"]);
      expect((await listSummaries("pPrune", 10)).map((record) => record.id).sort()).toEqual([
        "msg_prune_2",
        "msg_prune_3",
        "msg_prune_4",
      ]);
      const files = await readdir(join(compactionsRoot(), "pPrune"));
      expect(files).toHaveLength(3);
    } finally {
      process.env.MEMORY_SUMMARY_KEEP = "20";
    }
  });
});

describe("findSummary", () => {
  test("resolves latest, exact ids and long prefixes; rejects short prefixes", async () => {
    expect((await findSummary("pA", "latest"))?.id).toBe("msg_rehome");
    expect((await findSummary("pA", "msg_cap1"))?.id).toBe("msg_cap1");
    expect((await findSummary("pA", "summary:msg_cap1"))?.id).toBe("msg_cap1");
    // 8+ character prefix is accepted
    expect((await findSummary("pA", "msg_cap1"))?.id).toBe("msg_cap1");
    // short prefix must not guess
    expect(await findSummary("pA", "msg_c")).toBeUndefined();
    expect(await findSummary("pA", "nope")).toBeUndefined();
  });
});

describe("searchSummaries", () => {
  test("matches titles and bodies", async () => {
    const hits = await searchSummaries("pA", "objective thing", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.record.id === "msg_cap1")).toBe(true);
    expect(await searchSummaries("pA", "zzznottherezzz", 10)).toEqual([]);
  });
});

describe("sections and objective helpers", () => {
  test("extracts ## sections and looks them up case-insensitively", () => {
    const sections = extractSections("## Objective\n- a\n\n## Next Move\n- b\n\n## Tail\ntext");
    expect(sections.map((section) => section.heading)).toEqual(["Objective", "Next Move", "Tail"]);
    expect(findSection("## Objective\n- a", "objective")).toBe("- a");
    expect(findSection("## Objective\n- a", "missing")).toBeUndefined();
  });

  test("objectiveLine strips the bullet", () => {
    expect(objectiveLine({ body: "## Objective\n- do the thing\n" } as never)).toBe("do the thing");
    expect(objectiveLine({ body: "no sections" } as never)).toBe("");
  });
});

describe("parseFrontmatter", () => {
  test("parses written frontmatter and degrades gracefully", () => {
    const parsed = parseFrontmatter("---\nid: \"msg_x\"\ntitle: Test title\n---\nbody here");
    expect(parsed.frontmatter.id).toBe("msg_x");
    expect(parsed.frontmatter.title).toBe("Test title");
    expect(parsed.body).toBe("body here");

    const bare = parseFrontmatter("no frontmatter\nat all");
    expect(Object.keys(bare.frontmatter)).toHaveLength(0);
    expect(bare.body).toBe("no frontmatter\nat all");

    const unclosed = parseFrontmatter("---\nid: \"msg_y\"\nno closing fence");
    expect(Object.keys(unclosed.frontmatter)).toHaveLength(0);
  });
});

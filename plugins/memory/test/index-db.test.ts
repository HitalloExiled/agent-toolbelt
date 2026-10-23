import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { JsonIndex, openIndex } from "../index-db.js";
import type { MemoryIndex } from "../index-db.js";
import type { IndexDoc, MessageKind } from "../types.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

let dataDir = "";

beforeAll(async () => {
  await mkdir(testBase, { recursive: true });
  dataDir = await mkdtemp(join(testBase, "memory-index-"));
  process.env.MEMORY_DATA_DIR = dataDir;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

const docs: IndexDoc[] = [
  { id: "m1", projectID: "pA", sessionID: "s1", messageID: "m1", kind: "user", created: 1000, text: "first text in A" },
  { id: "m2", projectID: "pB", sessionID: "s2", messageID: "m2", kind: "assistant", created: 2000, text: "hello from B" },
  { id: "m3", projectID: "pA", sessionID: "s1", messageID: "m3", kind: "summary", created: 3000, text: "summary text here" },
];

const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id);
const searchAll = (index: MemoryIndex, query: string, kind: MessageKind | "any") =>
  index.search(query, { scope: "all", kind, limit: 10 });

describe("SqliteIndex", () => {
  test("upsert, scoped search, kind filter, counts and removal", async () => {
    const index = await openIndex();
    expect(index.backend).toBe("sqlite-fts5");

    await index.upsert(docs);
    // Same doc id twice: the later one wins.
    await index.upsert([{ ...docs[0]!, text: "replaced text in A" }]);

    expect(await index.count()).toBe(3);
    expect(await index.count("pA")).toBe(2);

    // The replaced m1 no longer contains "hello", so pA has no match.
    expect(
      ids(await index.search("hello", { scope: "project", projectID: "pA", kind: "any", limit: 10 })),
    ).toEqual([]);
    expect(
      ids(await index.search("replaced", { scope: "project", projectID: "pA", kind: "any", limit: 10 })),
    ).toEqual(["m1"]);
    expect(ids(await searchAll(index, "hello", "any"))).toEqual(["m2"]);
    expect(ids(await searchAll(index, "text", "summary"))).toEqual(["m3"]);

    expect(await index.summaryIDs()).toEqual(["m3"]);
    expect(await index.summaryIDs("pB")).toEqual([]);

    index.setSession("s1", "pA", 1234);
    expect(index.getSession("s1")).toEqual({ projectID: "pA", updatedAt: 1234 });

    await index.remove(["m2"]);
    expect(await index.count()).toBe(2);
    await index.clearProject("pA");
    expect(await index.count()).toBe(0);
    expect(await searchAll(index, "hello", "any")).toEqual([]);
    await index.close();
  });
});

describe("JsonIndex", () => {
  test("mirrors the index contract", async () => {
    const index = await JsonIndex.open(join(dataDir, "index.json"), "test");
    await index.upsert(docs);

    expect(await index.count()).toBe(3);
    expect(await index.count("pA")).toBe(2);
    expect(ids(await searchAll(index, "hello", "any"))).toEqual(["m2"]);
    expect(
      ids(await index.search("hello", { scope: "project", projectID: "pA", kind: "any", limit: 10 })),
    ).toEqual([]);
    expect(await index.summaryIDs()).toEqual(["m3"]);
    expect(await index.summaryIDs("pB")).toEqual([]);

    index.setSession("s1", "pA", 99);
    expect(index.getSession("s1")).toEqual({ projectID: "pA", updatedAt: 99 });

    await index.remove(["m2"]);
    expect(await index.count()).toBe(2);
    await index.close();
  });
});

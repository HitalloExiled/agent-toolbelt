import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { projectForDirectory, resetProjectCache, resolveProjectID } from "../projects.js";
import type { ProjectRef } from "../projects.js";
import { resetService } from "../service.js";

// /tmp is ephemeral in the agent environment: keep scratch state in the repo
// (untracked) and clean it up afterwards.
const testBase = process.env.MEMORY_TEST_TMP ?? join(process.cwd(), ".memory-test-tmp");

beforeAll(async () => {
  // No live service in unit tests: the project list must degrade to empty.
  await mkdir(testBase, { recursive: true });
  process.env.OPENCODE_SERVICE_FILE = join(await mkdtemp(join(testBase, "memory-proj-")), "no-service.json");
  resetService();
  resetProjectCache();
});

afterAll(async () => {
  await rm(testBase, { recursive: true, force: true }).catch(() => undefined);
});

const projects: ProjectRef[] = [
  { id: "root", canonical: "/" },
  { id: "home", canonical: "/home/user" },
  { id: "proj", canonical: "/home/user/proj" },
  { id: "proj2", canonical: "/home/user/proj2" },
  { id: "nested", canonical: "/home/user/proj/nested" },
];

describe("projectForDirectory", () => {
  test("picks the innermost project", () => {
    expect(projectForDirectory("/home/user/proj/nested/deep", projects)?.id).toBe("nested");
    expect(projectForDirectory("/home/user/proj", projects)?.id).toBe("proj");
    expect(projectForDirectory("/home/user", projects)?.id).toBe("home");
  });

  test("does not prefix-collide sibling projects", () => {
    expect(projectForDirectory("/home/user/proj2/x", projects)?.id).toBe("proj2");
  });

  test("the root project is never a prefix match", () => {
    expect(projectForDirectory("/elsewhere", projects)).toBeUndefined();
  });

  test("no directory yields no project", () => {
    expect(projectForDirectory(undefined, projects)).toBeUndefined();
    expect(projectForDirectory("", projects)).toBeUndefined();
  });
});

describe("resolveProjectID", () => {
  test("keeps explicit projects; degrades to the own id without a service", async () => {
    expect(await resolveProjectID({ projectID: "pX" })).toBe("pX");
    // Without the service there is no directory fallback: the own id stands.
    expect(await resolveProjectID({ projectID: "global", location: { directory: "/home/user/proj" } })).toBe("global");
    expect(await resolveProjectID({})).toBeUndefined();
  });
});

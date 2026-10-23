/** Read-only git snapshot, computed at injection/tool time (never stored). */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CacheEntry {
  at: number;
  text: string;
}

const cache = new Map<string, CacheEntry>();
const CACHE_MS = 5_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1_000_000,
    encoding: "utf8",
  });
  return stdout.trimEnd();
}

function countStatus(lines: string[]): { total: number; modified: number; added: number; deleted: number; untracked: number; renamed: number } {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  let renamed = 0;
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    const code = line.slice(0, 2);
    if (code.includes("R")) renamed++;
    else if (code.includes("D")) deleted++;
    else if (code.includes("A")) added++;
    else if (code.includes("M") || code.includes("T") || code.includes("U")) modified++;
  }
  return { total: lines.length, modified, added, deleted, untracked, renamed };
}

function changeKind(line: string): string {
  if (line.startsWith("??")) return "untracked";
  const code = line.slice(0, 2);
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  if (code.includes("U")) return "conflict";
  return code.trim() || "changed";
}

async function compute(directory: string, includeWorktree: boolean): Promise<string> {
  let root: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], directory)).trim();
  } catch {
    return `repo: ${directory} (not a git repository)`;
  }

  const [status, last] = await Promise.all([
    git(["status", "--porcelain=v1", "-b"], root).catch(() => ""),
    git(["log", "-1", "--format=%h %s (%cr)"], root).catch(() => ""),
  ]);

  const lines = status ? status.split("\n") : [];
  const branchLine = lines[0]?.startsWith("##") ? lines.shift() ?? "" : "";
  const branch = branchLine.replace(/^##\s*/, "").replace(/^No commits yet on /, "") || "detached";

  // The injected system block must be stable: a live `git status` changes on
  // every edit and invalidates the server's prefix cache from this point on,
  // forcing a full re-prefill of the whole conversation each turn. Callers
  // that need the working tree (the on-demand tool) still get it below.
  if (!includeWorktree) {
    return [
      `repo: ${root} (branch ${branch})`,
      last ? `last: ${last}` : "last: unknown",
    ].join("\n");
  }

  const counts = countStatus(lines);
  const detail =
    counts.total === 0
      ? "clean"
      : `${counts.total} changed, ` +
        [
          counts.modified ? `${counts.modified} modified` : "",
          counts.added ? `${counts.added} added` : "",
          counts.deleted ? `${counts.deleted} deleted` : "",
          counts.renamed ? `${counts.renamed} renamed` : "",
          counts.untracked ? `${counts.untracked} untracked` : "",
        ]
          .filter(Boolean)
          .join(", ");

  const files = lines.slice(0, 12).map((line) => {
    const path = line.slice(3).split(" -> ").pop() ?? line.slice(3);
    return `  ${changeKind(line)} ${path}`;
  });
  if (lines.length > 12) files.push(`  … ${lines.length - 12} more`);

  return [
    `repo: ${root} (branch ${branch})`,
    last ? `last: ${last}` : "last: unknown",
    `worktree: ${detail}`,
    ...files,
  ].join("\n");
}

export async function repoSnapshot(directory?: string, includeWorktree = true): Promise<string> {
  if (!directory) return "repo: unknown (session has no directory)";
  const key = `${directory}\u0000${includeWorktree}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.text;
  let text: string;
  try {
    text = await compute(directory, includeWorktree);
  } catch (error) {
    text = `repo: ${directory} (git unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
  cache.set(key, { at: now, text });
  return text;
}

export function clearRepoCache(): void {
  cache.clear();
}

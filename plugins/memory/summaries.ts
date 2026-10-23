/** Durable compaction summaries (Markdown files, one per compaction). */

import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { compactionsRoot, projectDir, summaryKeep } from "./paths.js";
import type { IndexDoc, MessageLike, SessionInfoLike, SummaryRecord } from "./types.js";
import { atomicWrite, listMarkdown, parseFrontmatter, readText } from "./storage.js";
import {
  clip,
  fmtDate,
  isoCompact,
  modelLabel,
  normalizeWhitespace,
  safeFilename,
  shortID,
  snippet,
  timeMs,
  tokenize,
} from "./util.js";

export function summaryFileName(created: number, messageID: string): string {
  return `${isoCompact(created)}-${safeFilename(messageID)}.md`;
}

export function summaryPath(projectID: string, created: number, messageID: string): string {
  return join(projectDir(projectID), summaryFileName(created, messageID));
}

export function toIndexDoc(record: SummaryRecord): IndexDoc {
  return {
    id: `summary:${record.messageID}`,
    projectID: record.projectID,
    sessionID: record.sessionID,
    messageID: record.messageID,
    kind: "summary",
    created: record.created,
    title: record.title,
    text: record.body,
  };
}

async function summaryFromPath(path: string, fallbackProjectID?: string): Promise<SummaryRecord | undefined> {
  const raw = await readText(path);
  if (raw === undefined) return undefined;
  const parsed = parseFrontmatter(raw);
  const fm = parsed.frontmatter;
  const body = parsed.body.trim();
  if (!body) return undefined;
  const messageID = String(fm.messageID ?? fm.id ?? basename(path).replace(/\.md$/, "").split("-").pop() ?? "").trim();
  if (!messageID) return undefined;
  const sessionID = String(fm.sessionID ?? "").trim();
  const projectID = String(fm.projectID ?? fallbackProjectID ?? "").trim();
  const created = timeMs(fm.created) || timeMs(fm.createdISO) || Date.now();
  return {
    id: messageID,
    messageID,
    sessionID,
    projectID,
    created,
    title: String(fm.title ?? "Untitled session"),
    model: typeof fm.model === "string" ? fm.model : undefined,
    reason: typeof fm.reason === "string" ? fm.reason : undefined,
    body,
    path,
    bytes: Buffer.byteLength(raw, "utf8"),
  };
}

/** Capture one completed compaction message. Returns the record and whether it was new. */
export async function captureCompaction(
  projectID: string,
  session: SessionInfoLike,
  message: MessageLike,
): Promise<{ record: SummaryRecord; fresh: boolean; pruned: string[] } | undefined> {
  if (message.type !== "compaction" || message.status !== "completed") return undefined;
  const body = (message.summary ?? "").trim();
  if (!body) return undefined;

  const messageID = message.id;
  const existing = await findSummaryByMessageID(projectID, messageID);
  if (existing) return { record: existing, fresh: false, pruned: [] };
  // A session re-homed from another project bucket may leave a stale copy there.
  await removeStaleSummaries(projectID, messageID);

  const created = timeMs(message.time?.created) || Date.now();
  const path = summaryPath(projectID, created, messageID);
  const title = (session.title ?? "").trim() || "Untitled session";
  const model = modelLabel(message.model);
  const reason = message.reason;
  const frontmatter = [
    "---",
    `id: ${JSON.stringify(messageID)}`,
    `messageID: ${JSON.stringify(messageID)}`,
    `sessionID: ${JSON.stringify(session.id)}`,
    `projectID: ${JSON.stringify(projectID)}`,
    `created: ${created}`,
    `createdISO: ${JSON.stringify(new Date(created).toISOString())}`,
    `title: ${JSON.stringify(title)}`,
    ...(model ? [`model: ${JSON.stringify(model)}`] : []),
    ...(reason ? [`reason: ${JSON.stringify(reason)}`] : []),
    "---",
  ].join("\n");
  await atomicWrite(path, `${frontmatter}\n\n${body}\n`);

  const info = await stat(path).catch(() => undefined);
  const record: SummaryRecord = {
    id: messageID,
    messageID,
    sessionID: session.id,
    projectID,
    created,
    title,
    model,
    reason,
    body,
    path,
    bytes: info?.size ?? Buffer.byteLength(body, "utf8"),
  };
  const pruned = await pruneSummaries(projectID);
  return { record, fresh: true, pruned };
}

export async function findSummaryByMessageID(projectID: string, messageID: string): Promise<SummaryRecord | undefined> {
  const suffix = `-${safeFilename(messageID)}.md`;
  for (const path of await listMarkdown(projectDir(projectID))) {
    if (!path.endsWith(suffix)) continue;
    return summaryFromPath(path, projectID);
  }
  return undefined;
}

/**
 * Delete stale copies of the same compaction that live in other project
 * buckets (for example after a session was re-homed from `global` or from
 * another project). Only called from the write path.
 */
async function removeStaleSummaries(projectID: string, messageID: string): Promise<void> {
  const suffix = `-${safeFilename(messageID)}.md`;
  let entries;
  try {
    entries = await readdir(compactionsRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  const target = projectDir(projectID);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(compactionsRoot(), entry.name);
    if (dir === target) continue;
    for (const path of await listMarkdown(dir)) {
      if (!path.endsWith(suffix)) continue;
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

/** Rewrite only the projectID line inside the frontmatter (the body is untouched). */
function rewriteProjectLine(raw: string, projectID: string): string {
  const close = raw.indexOf("\n---", 4);
  const fmEnd = close === -1 ? raw.length : close;
  const frontmatter = raw.slice(0, fmEnd).replace(/^projectID:.*/m, `projectID: ${JSON.stringify(projectID)}`);
  return frontmatter + raw.slice(fmEnd);
}

/**
 * Consolidate a session's compaction history after it moved between project
 * buckets: every summary file of `sessionID` still sitting in `oldProjectID`
 * is rewritten (frontmatter projectID) and moved into `newProjectID`.
 * Idempotent; returns the number of files moved.
 */
export async function migrateSessionSummaries(
  oldProjectID: string,
  newProjectID: string,
  sessionID: string,
): Promise<number> {
  if (!oldProjectID || !newProjectID || !sessionID || oldProjectID === newProjectID) return 0;
  let moved = 0;
  for (const record of await listSummaries(oldProjectID, 1000)) {
    if (record.sessionID !== sessionID) continue;
    const target = summaryPath(newProjectID, record.created, record.messageID);
    let targetExists = false;
    try {
      await stat(target);
      targetExists = true;
    } catch {
      // target is free
    }
    if (targetExists) {
      // A copy already lives in the new bucket: drop the source only when the
      // bodies agree (same compaction); conflicting content is left in place.
      const otherRaw = await readText(target);
      const otherBody = otherRaw === undefined ? undefined : parseFrontmatter(otherRaw).body.trim();
      if (otherBody === record.body) {
        await rm(record.path, { force: true }).catch(() => undefined);
        moved++;
      } else {
        console.error(`[memory] summary migration conflict for ${record.messageID}; left both copies`);
      }
      continue;
    }
    const raw = await readText(record.path);
    if (raw === undefined) continue;
    await atomicWrite(target, rewriteProjectLine(raw, newProjectID));
    await rm(record.path, { force: true }).catch(() => undefined);
    moved++;
  }
  return moved;
}

export async function listSummaries(projectID: string, limit = 20): Promise<SummaryRecord[]> {
  const records: SummaryRecord[] = [];
  for (const path of await listMarkdown(projectDir(projectID))) {
    const record = await summaryFromPath(path, projectID);
    if (record) records.push(record);
  }
  records.sort((a, b) => b.created - a.created || b.messageID.localeCompare(a.messageID));
  return records.slice(0, Math.max(1, limit));
}

export async function listAllSummaries(limit = 50): Promise<SummaryRecord[]> {
  const records: SummaryRecord[] = [];
  let dirs: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    dirs = (await readdir(compactionsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(compactionsRoot(), entry.name));
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const projectID = basename(dir);
    for (const path of await listMarkdown(dir)) {
      const record = await summaryFromPath(path, projectID);
      if (record) records.push(record);
    }
  }
  records.sort((a, b) => b.created - a.created);
  return records.slice(0, Math.max(1, limit));
}

export async function findSummary(projectID: string, id = "latest"): Promise<SummaryRecord | undefined> {
  const wanted = id.trim().replace(/^summary:/, "");
  if (!wanted || wanted === "latest") return (await listSummaries(projectID, 1))[0];
  const records = await listSummaries(projectID, 1000);
  // Exact matches (id, message id, file name) always win.
  const exact = records.find(
    (record) =>
      record.id === wanted ||
      record.messageID === wanted ||
      basename(record.path) === wanted ||
      basename(record.path, ".md") === wanted,
  );
  if (exact) return exact;
  // Prefix matching is a convenience, not a contract: a short prefix could
  // grab the wrong summary, so require a meaningful one.
  return wanted.length >= 8 ? records.find((record) => record.messageID.startsWith(wanted)) : undefined;
}

export async function searchSummaries(
  projectID: string | undefined,
  query: string,
  limit = 20,
): Promise<Array<{ record: SummaryRecord; snippet: string; score: number }>> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const records = projectID ? await listSummaries(projectID, 1000) : await listAllSummaries(1000);
  const out: Array<{ record: SummaryRecord; snippet: string; score: number }> = [];
  for (const record of records) {
    const haystack = `${record.title}\n${record.body}`.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(term, from);
        if (at < 0) break;
        score += 1;
        from = at + term.length;
      }
    }
    if (score === 0) continue;
    out.push({ record, snippet: snippet(record.body, terms), score });
  }
  out.sort((a, b) => b.score - a.score || b.record.created - a.record.created);
  return out.slice(0, Math.max(1, limit));
}

export async function pruneSummaries(projectID: string): Promise<string[]> {
  const keep = Math.max(1, summaryKeep());
  const files = await listMarkdown(projectDir(projectID));
  const removed: string[] = [];
  for (const path of files.slice(keep)) {
    const record = await summaryFromPath(path, projectID);
    if (record) removed.push(record.messageID);
    await rm(path, { force: true }).catch(() => undefined);
  }
  return removed;
}

export interface Section {
  heading: string;
  content: string;
}

export function extractSections(body: string): Section[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      if (current) sections.push(current);
      current = { heading: match[1].trim(), content: "" };
      continue;
    }
    if (current) current.content += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections.map((section) => ({ heading: section.heading, content: section.content.trim() }));
}

export function findSection(body: string, name: string): string | undefined {
  const wanted = name.trim().toLocaleLowerCase();
  return extractSections(body).find((section) => section.heading.toLocaleLowerCase() === wanted)?.content;
}

export function objectiveLine(record: SummaryRecord): string {
  const objective = findSection(record.body, "Objective") ?? "";
  const line = objective
    .split("\n")
    .map((part) => part.replace(/^\s*[-*]\s*/, "").trim())
    .find(Boolean);
  return line ? clip(line, 160) : "";
}

export function nextMove(record: SummaryRecord): string {
  return (findSection(record.body, "Next Move") ?? "").trim();
}

function header(record: SummaryRecord): string {
  return [
    `# Compaction summary ${shortID(record.messageID, 16)}`,
    `- project: ${record.projectID}`,
    `- session: ${record.sessionID}${record.title ? ` — ${record.title}` : ""}`,
    `- created: ${fmtDate(record.created)}`,
    record.model ? `- model: ${record.model}` : "",
    record.reason ? `- reason: ${record.reason}` : "",
    `- file: ${record.path}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatBrief(record: SummaryRecord): string {
  const objective = findSection(record.body, "Objective");
  const next = findSection(record.body, "Next Move");
  const work = findSection(record.body, "Work State");
  const parts = [header(record)];
  if (objective) parts.push(`## Objective\n${clip(objective, 2000)}`);
  if (next) parts.push(`## Next Move\n${clip(next, 2000)}`);
  if (work) parts.push(`## Work State (excerpt)\n${clip(work, 1600)}`);
  if (!objective && !next && !work) parts.push(clip(record.body, 3000));
  return parts.join("\n\n");
}

export function formatFull(record: SummaryRecord, max = 32000): string {
  return `${header(record)}\n\n${clip(record.body, max, "\n\n… (truncated; read the file for the rest)")}`;
}

export function formatSections(record: SummaryRecord, names: string[] = []): string {
  const sections = extractSections(record.body);
  if (sections.length === 0) return formatFull(record);
  const wanted = names.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean);
  const selected = wanted.length
    ? sections.filter((section) => wanted.includes(section.heading.toLocaleLowerCase()))
    : sections;
  if (selected.length === 0) {
    return `${header(record)}\n\nNo matching section. Available: ${sections.map((section) => section.heading).join(", ")}`;
  }
  return [
    header(record),
    ...selected.map((section) => `## ${section.heading}\n${clip(section.content, 8000)}`),
  ].join("\n\n");
}

export function formatSummaryList(records: SummaryRecord[]): string {
  if (records.length === 0) return "No compaction summaries for this project yet.";
  return records
    .map((record) => {
      const objective = objectiveLine(record);
      return (
        `- **${fmtDate(record.created)}** · \`${record.messageID}\` · session \`${shortID(record.sessionID, 12)}\`` +
        `${record.title ? ` — ${record.title}` : ""}` +
        (objective ? `\n  ${objective}` : "")
      );
    })
    .join("\n");
}

export function formatSummarySearch(
  results: Array<{ record: SummaryRecord; snippet: string }>,
): string {
  if (results.length === 0) return "No summaries matched.";
  return results
    .map(
      ({ record, snippet: text }) =>
        `- **${fmtDate(record.created)}** · \`${record.messageID}\` · session \`${shortID(record.sessionID, 12)}\`` +
        `${record.title ? ` — ${record.title}` : ""}\n  ${normalizeWhitespace(text)}`,
    )
    .join("\n");
}

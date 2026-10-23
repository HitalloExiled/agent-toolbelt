/** Lazy, incremental backfill of the derived narrative index. */

import { readdir } from "node:fs/promises";

import type { Runtime } from "./runtime.js";
import { embedDocs } from "./embed.js";
import { backfillMessageLimit, backfillSessionLimit, compactionsRoot } from "./paths.js";
import { captureCompaction, listAllSummaries, listSummaries, migrateSessionSummaries, pruneSummaries, toIndexDoc } from "./summaries.js";
import { extractNarrative, listAllMessages, listSessions, messageCreated } from "./history.js";
import { listProjects, resolveProjectID } from "./projects.js";
import type { IndexDoc, MessageLike, SessionInfoLike } from "./types.js";
import { timeMs } from "./util.js";

export interface BackfillResult {
  sessions: number;
  messages: number;
  partial: boolean;
}

/**
 * Index the summary files that are on disk. This is a read path: it never
 * prunes files (pruning happens only on the write path, in captureCompaction),
 * but it does remove index entries whose file is gone, so a manual deletion
 * stays visible in the index.
 */
export async function indexSummaryFiles(runtime: Runtime, projectID?: string): Promise<number> {
  const records = projectID ? await listSummaries(projectID, 1000) : await listAllSummaries(1000);
  const onDisk = new Set(records.map((record) => record.messageID));
  try {
    const indexed = await runtime.index.summaryIDs(projectID);
    const stale = indexed.filter((docID) => docID.startsWith("summary:") && !onDisk.has(docID.slice("summary:".length)));
    if (stale.length > 0) await runtime.index.remove(stale);
  } catch (error) {
    console.error(`[memory] summary index reconciliation failed: ${error instanceof Error ? error.message : error}`);
  }
  if (records.length === 0) return 0;
  const docs = records.map(toIndexDoc);
  await runtime.index.upsert(docs);
  embedAfterUpsert(runtime, docs);
  return records.length;
}

/**
 * The semantic layer runs after the keyword index lands, fire-and-forget:
 * embedding is CPU work that must never block (or fail) the FTS path.
 */
function embedAfterUpsert(runtime: Runtime, docs: IndexDoc[]): void {
  void embedDocs(runtime, docs).catch((error) =>
    console.error(`[memory] background embedding failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

function sessionUpdated(session: SessionInfoLike): number {
  return timeMs(session.time?.updated) || timeMs(session.time?.created) || 0;
}

function narrativeDoc(message: MessageLike, session: SessionInfoLike, projectID: string): IndexDoc | undefined {
  const narrative = extractNarrative(message);
  if (!narrative) return undefined;
  return {
    id: message.id,
    projectID,
    sessionID: session.id,
    messageID: message.id,
    kind: narrative.kind,
    created: messageCreated(message) || Date.now(),
    title: session.title,
    text: narrative.text,
  };
}

async function doBackfill(runtime: Runtime, projectID: string): Promise<BackfillResult> {
  const { ctx, index } = runtime;
  let summaryCount = 0;
  try {
    summaryCount = await indexSummaryFiles(runtime, projectID);
  } catch (error) {
    console.error(`[memory] summary indexing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let sessions: SessionInfoLike[] = [];
  try {
    sessions = await listSessions(ctx, { projectID, scope: "project", limit: backfillSessionLimit() });
  } catch (error) {
    console.error(`[memory] session list failed: ${error instanceof Error ? error.message : String(error)}`);
    return { sessions: 0, messages: summaryCount, partial: true };
  }

  let indexedSessions = 0;
  let indexedMessages = 0;
  let partial = false;

  for (const session of sessions.slice(0, backfillSessionLimit())) {
    const updatedAt = sessionUpdated(session);
    const stored = index.getSession(session.id);
    // Sessions inside a real project's directory can carry the root project
    // id "global"; index them under the project their directory belongs to.
    const effectiveProject = (await resolveProjectID(session)) || projectID;
    // A session that was re-homed (moved to another project's directory)
    // keeps its old compaction files in the old bucket. Consolidate them into
    // the new bucket so the project's history stays complete. The persisted
    // sessions_indexed row is the reliable source for the previous project.
    if (stored && stored.projectID && stored.projectID !== effectiveProject) {
      void migrateSessionSummaries(stored.projectID, effectiveProject, session.id).catch((error) =>
        console.error(
          `[memory] summary migration failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if (stored && stored.projectID === effectiveProject && stored.updatedAt >= updatedAt && updatedAt > 0) continue;

    let listed;
    try {
      listed = await listAllMessages(ctx, session.id, { max: backfillMessageLimit(), pageSize: 100 });
    } catch (error) {
      console.error(`[memory] could not read session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      partial = true;
      continue;
    }
    if (listed.partial) partial = true;

    const docs: IndexDoc[] = [];
    const pruned: string[] = [];
    for (const message of listed.messages) {
      if (message.type === "compaction") {
        try {
          const captured = await captureCompaction(effectiveProject, session, message);
          if (captured) {
            docs.push(toIndexDoc(captured.record));
            pruned.push(...captured.pruned);
          }
        } catch (error) {
          console.error(`[memory] summary capture failed for ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const doc = narrativeDoc(message, session, effectiveProject);
      if (doc) docs.push(doc);
    }

    if (docs.length > 0) {
      try {
        await index.upsert(docs);
        indexedMessages += docs.length;
        embedAfterUpsert(runtime, docs);
      } catch (error) {
        console.error(`[memory] index upsert failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
        partial = true;
        continue;
      }
    }
    // Drop index entries for summaries that pruning just deleted from disk.
    if (pruned.length > 0) {
      await index.remove(pruned.map((id) => `summary:${id}`)).catch(() => undefined);
    }
    // A context-only read is not a complete timeline; retry it next time.
    if (!listed.partial) index.setSession(session.id, effectiveProject, updatedAt);
    indexedSessions++;
  }

  await index.flush();
  return { sessions: indexedSessions, messages: indexedMessages + summaryCount, partial };
}

export function backfillProject(runtime: Runtime, projectID: string): Promise<BackfillResult> {
  const existing = runtime.backfills.get(projectID);
  if (existing) return existing;
  const promise = doBackfill(runtime, projectID).finally(() => {
    runtime.backfills.delete(projectID);
  });
  runtime.backfills.set(projectID, promise);
  return promise;
}

export async function reindexProject(runtime: Runtime, projectID: string): Promise<BackfillResult> {
  await runtime.index.clearProject(projectID);
  runtime.backfilled.delete(projectID);
  return backfillProject(runtime, projectID);
}

export async function indexAllSummaries(runtime: Runtime): Promise<number> {
  return indexSummaryFiles(runtime);
}

export interface IndexAllProject {
  projectID: string;
  sessions: number;
  messages: number;
  partial: boolean;
}

export interface IndexAllResult {
  projects: IndexAllProject[];
  summaries: number;
  totals: { projects: number; sessions: number; messages: number };
}

/** Project bucket names that already exist on disk (summaries outlive sessions). */
async function projectDirsOnDisk(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(compactionsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Manually index every known project: the projects the service reports, the
 * projects that already have summary files on disk, and the current one.
 * Incremental by default (already-indexed sessions are skipped); `rebuild`
 * clears the index first. This is the manual counterpart of the lazy
 * per-project backfill that `scope=all` relies on.
 */
export async function indexAllProjects(
  runtime: Runtime,
  options: { currentProjectID?: string; rebuild?: boolean; concurrency?: number } = {},
): Promise<IndexAllResult> {
  const ids = new Set<string>();
  for (const project of await listProjects()) ids.add(project.id);
  for (const name of await projectDirsOnDisk()) ids.add(name);
  if (options.currentProjectID) ids.add(options.currentProjectID);

  if (options.rebuild) {
    for (const id of ids) await runtime.index.clearProject(id).catch(() => undefined);
  }

  const projects: IndexAllProject[] = [];
  const queue = [...ids];
  // Single-threaded event loop: queue.shift() between awaits is race-free.
  const worker = async () => {
    for (;;) {
      const projectID = queue.shift();
      if (projectID === undefined) break;
      const result = await backfillProject(runtime, projectID);
      projects.push({ projectID, sessions: result.sessions, messages: result.messages, partial: result.partial });
    }
  };
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 3));
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  const summaries = await indexSummaryFiles(runtime).catch(() => 0);
  return {
    projects,
    summaries,
    totals: {
      projects: projects.length,
      sessions: projects.reduce((sum, project) => sum + project.sessions, 0),
      messages: projects.reduce((sum, project) => sum + project.messages, 0),
    },
  };
}

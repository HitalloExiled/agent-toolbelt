/** Lazy, incremental backfill of the derived narrative index. */

import type { Runtime } from "./runtime.js";
import { backfillMessageLimit, backfillSessionLimit } from "./paths.js";
import { captureCompaction, listAllSummaries, listSummaries, pruneSummaries, toIndexDoc } from "./summaries.js";
import { extractNarrative, listAllMessages, listSessions, messageCreated } from "./history.js";
import { resolveProjectID } from "./projects.js";
import type { IndexDoc, MessageLike, SessionInfoLike } from "./types.js";
import { timeMs } from "./util.js";

export interface BackfillResult {
  sessions: number;
  messages: number;
  partial: boolean;
}

export async function indexSummaryFiles(runtime: Runtime, projectID?: string): Promise<number> {
  if (projectID) {
    // Keep the index aligned with what is actually on disk.
    const pruned = await pruneSummaries(projectID);
    if (pruned.length > 0) {
      await runtime.index.remove(pruned.map((id) => `summary:${id}`)).catch(() => undefined);
    }
  }
  const records = projectID ? await listSummaries(projectID, 1000) : await listAllSummaries(1000);
  if (records.length === 0) return 0;
  await runtime.index.upsert(records.map(toIndexDoc));
  return records.length;
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
    console.error(`[toolbelt] summary indexing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let sessions: SessionInfoLike[] = [];
  try {
    sessions = await listSessions(ctx, { projectID, scope: "project", limit: backfillSessionLimit() });
  } catch (error) {
    console.error(`[toolbelt] session list failed: ${error instanceof Error ? error.message : String(error)}`);
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
    if (stored && stored.projectID === effectiveProject && stored.updatedAt >= updatedAt && updatedAt > 0) continue;

    let listed;
    try {
      listed = await listAllMessages(ctx, session.id, { max: backfillMessageLimit(), pageSize: 100 });
    } catch (error) {
      console.error(`[toolbelt] could not read session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
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
          console.error(`[toolbelt] summary capture failed for ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
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
      } catch (error) {
        console.error(`[toolbelt] index upsert failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
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

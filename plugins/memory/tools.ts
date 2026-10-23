/** The three read-only tools exposed by the plugin. */

import type { PluginContext } from "./context.js";
import type { Runtime } from "./runtime.js";
import type { MessageKind, SearchHit } from "./types.js";
import { cosine, embedDocs, getEngine, rrfFuse } from "./embed.js";
import { embedDisabled, embedModelName } from "./paths.js";
import { backfillProject, indexAllProjects, reindexProject, indexSummaryFiles } from "./indexer.js";
import { resolveProjectID } from "./projects.js";
import { repoSnapshot } from "./repo.js";
import {
  findSummary,
  formatBrief,
  formatFull,
  formatSections,
  formatSummaryList,
  formatSummarySearch,
  listAllSummaries,
  listSummaries,
  searchSummaries,
} from "./summaries.js";
import {
  formatHistorySearch,
  formatMessage,
  formatSessionList,
  formatTimeline,
  getHistoryApi,
  getSessionInfo,
  listSessions,
  readPage,
  searchSession,
} from "./history.js";
import type { HistoryPage, HistorySearchHit, HistorySource } from "./history.js";
import { fmtDate, normalizeWhitespace, snippet, tokenize } from "./util.js";

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

function strings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

async function currentProject(ctx: PluginContext, sessionID: string) {
  const info = await getSessionInfo(ctx, sessionID);
  // Sessions inside a real project's directory can carry the root project
  // id "global"; resolve them to the project their directory belongs to.
  const projectID = (await resolveProjectID(info)) || info.projectID;
  return { info, projectID, directory: info.location?.directory };
}

export async function registerTools(ctx: PluginContext, runtime: Runtime) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_search",
      description: [
        "Search past conversations and compaction summaries across sessions of this project.",
        "The index holds only user text, assistant text and compaction summaries (never reasoning or tool payloads).",
        "Search is hybrid: keyword (FTS5) plus local CPU semantic search, fused via RRF; hits are tagged via: fts|vec|fts+vec.",
        "Actions: search (default), stats, reindex, index-all, embed.",
        "action=embed (re)builds the local vector index for the scope; vectors are refreshed automatically as documents are indexed.",
        "scope=all searches what is already indexed plus every summary on disk; run action=index-all first to index all projects.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "stats", "reindex", "index-all", "embed"],
            description:
              "Defaults to search. index-all manually indexes every known project. embed (re)builds the vector index for the scope.",
          },
          query: { type: "string", description: "Words to look for. Required for action=search." },
          scope: {
            type: "string",
            enum: ["project", "all"],
            description:
              "Defaults to the current project. scope=all searches everything already indexed plus every summary on disk.",
          },
          kind: {
            type: "string",
            enum: ["any", "summary", "user", "assistant"],
            description: "Filter by document kind. Defaults to any.",
          },
          limit: { type: "number", description: "Maximum hits (1-50, default 20)." },
          rebuild: {
            type: "boolean",
            description: "For action=index-all: clear the index first (full rebuild instead of incremental).",
          },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "search";
        const { projectID } = await currentProject(ctx, context.sessionID);

        if (action === "stats") {
          const [all, mine, summaries] = await Promise.all([
            runtime.index.count(),
            runtime.index.count(projectID),
            listSummaries(projectID, 1000),
          ]);
          const lines = [
            `backend: ${runtime.index.backend}${runtime.index.error ? ` (${runtime.index.error})` : ""}`,
            `project: ${projectID}`,
            `indexed documents: ${mine} in this project, ${all} total`,
            `summary files in this project: ${summaries.length}`,
          ];
          if (embedDisabled()) {
            lines.push("semantic layer: disabled (MEMORY_EMBED_DISABLED=1)");
          } else {
            const model = embedModelName();
            const embedded = await runtime.index.vectorCount(model).catch(() => 0);
            lines.push(`embedded vectors: ${embedded} document(s) (model: ${model})`);
          }
          return { content: lines.join("\n") };
        }

        if (action === "reindex") {
          const result = await reindexProject(runtime, projectID);
          return {
            content:
              `Reindexed project ${projectID}: ${result.sessions} sessions, ${result.messages} documents.` +
              (result.partial ? "\n> Partial: some sessions could only be read from the active context." : ""),
          };
        }

        if (action === "index-all") {
          const rebuild = bool(input, "rebuild", false);
          const result = await indexAllProjects(runtime, { currentProjectID: projectID, rebuild });
          const lines = result.projects.map(
            (project) =>
              `- \`${project.projectID}\`: ${project.sessions} session(s), ${project.messages} document(s)${
                project.partial ? " (partial)" : ""
              }`,
          );
          return {
            content:
              `Indexed ${result.totals.projects} project(s): ${result.totals.sessions} sessions, ${result.totals.messages} documents` +
              (rebuild ? " (full rebuild)" : " (incremental)") +
              `; ${result.summaries} summary file(s) on disk.\n\n${lines.join("\n")}`,
          };
        }

        if (action === "embed") {
          const scope = str(input, "scope") === "all" ? "all" : "project";
          const engine = await getEngine();
          if (!engine) {
            return {
              content:
                `Vector engine unavailable${embedDisabled() ? " (MEMORY_EMBED_DISABLED=1)" : ""}. ` +
                `Model: ${embedModelName()}. Check the service logs; search stays keyword-only until it starts.`,
            };
          }
          const docs = await runtime.index.docs(scope === "project" ? projectID : undefined);
          const t0 = Date.now();
          const stats = await embedDocs(runtime, docs, engine);
          const pruned = await runtime.index.pruneOldVectors(engine.model);
          return {
            content:
              `Vector index pass (scope: ${scope}): embedded ${stats.embedded} document(s), ${stats.skipped} unchanged, ` +
              `${stats.rehomed} re-bucketed after project moves, ` +
              `${pruned} old vector(s) from other model(s) removed. ` +
              `model: ${engine.model}, dim: ${engine.spec.dim}, ${Date.now() - t0} ms. ` +
              `Documents in scope: ${docs.length}.`,
          };
        }

        const query = str(input, "query");
        if (!query) return { content: "Provide `query` (or use action=stats / action=reindex / action=index-all / action=embed)." };

        const scope = str(input, "scope") === "all" ? "all" : "project";
        const kind = (str(input, "kind") ?? "any") as MessageKind | "any";
        const limit = num(input, "limit", 20, 1, 50);

        let partialNote = "";
        if (scope === "all") {
          await indexSummaryFiles(runtime).catch(() => 0);
          await backfillProject(runtime, projectID).catch(() => undefined);
        } else {
          const result = await backfillProject(runtime, projectID).catch(() => undefined);
          if (result?.partial) {
            partialNote = "\n\n> Partial index: some sessions could only be read from the active context.";
          }
        }

        const terms = tokenize(query);
        const ftsHits = await runtime.index.search(query, { projectID, scope, kind, limit: limit * 3 });

        let vecHits: Array<{ id: string; score: number }> = [];
        let vectorNote = "";
        if (!embedDisabled()) {
          const engine = await getEngine();
          if (!engine) {
            vectorNote = "\n\n> Vector layer unavailable; results are keyword-only.";
          } else {
            try {
              const qvec = await engine.embedText(engine.spec.queryPrefix + query);
              const vectors = await runtime.index.loadVectors(engine.model, scope === "project" ? projectID : undefined);
              for (const [id, entry] of vectors) {
                if (kind !== "any" && entry.kind !== kind) continue;
                let best = -Infinity;
                for (const vec of entry.vecs) {
                  const score = cosine(qvec, vec);
                  if (score > best) best = score;
                }
                if (best > -Infinity) vecHits.push({ id, score: best });
              }
              vecHits.sort((a, b) => b.score - a.score);
              vecHits = vecHits.slice(0, limit * 3);
            } catch (error) {
              vectorNote = `\n\n> Vector layer failed (${error instanceof Error ? error.message : String(error)}); results are keyword-only.`;
            }
          }
        }

        let hits: SearchHit[];
        if (vecHits.length === 0) {
          hits = ftsHits.map((hit) => ({ ...hit, via: "fts" as const }));
        } else {
          const fused = rrfFuse(ftsHits.map((hit) => hit.id), vecHits.map((hit) => hit.id), limit);
          const byFts = new Map(ftsHits.map((hit) => [hit.id, hit]));
          const missing = fused.filter((f) => !byFts.has(f.id)).map((f) => f.id);
          const extras = missing.length > 0 ? await runtime.index.docsByIds(missing) : [];
          const byDoc = new Map(extras.map((doc) => [doc.id, doc]));
          hits = fused
            .map((f): SearchHit | undefined => {
              const doc = byFts.get(f.id) ?? byDoc.get(f.id);
              if (!doc) return undefined;
              return {
                ...doc,
                rank: byFts.get(f.id)?.rank ?? 0,
                snippet: snippet(doc.text, terms),
                via: f.via,
              };
            })
            .filter((hit): hit is SearchHit => hit !== undefined);
        }

        if (hits.length === 0) {
          return {
            content:
              `No matches for "${query}" (scope: ${scope}, kind: ${kind}).` +
              `\nTry scope="all", a different wording, or action="reindex".${partialNote}${vectorNote}`,
          };
        }

        const lines = hits.map((hit) => {
          const session = hit.sessionID === context.sessionID ? "this session" : `\`${hit.sessionID}\``;
          return (
            `- **${fmtDate(hit.created)}** · ${hit.kind} · via: ${hit.via ?? "fts"} · ${session}` +
            `${hit.title ? ` — ${hit.title}` : ""}` +
            `${hit.kind === "summary" && hit.messageID ? ` · summary \`${hit.messageID}\`` : ""}` +
            `\n  ${normalizeWhitespace(hit.snippet)}`
          );
        });
        return {
          content:
            `${hits.length} match(es) for "${query}" (scope: ${scope}).\n\n${lines.join("\n")}` +
            `\n\nRead more with memory_summaries (summaries) or memory_history (full messages).${partialNote}${vectorNote}`,
        };
      },
    });

    editor.add({
      name: "memory_summaries",
      description: [
        "Read compaction summaries stored for this project, plus the current repository state.",
        "Actions: list, search, read (detail brief|full|sections), repo.",
        "Read-only and scoped to the current project unless scope=all.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "search", "read", "repo"], description: "Defaults to list." },
          id: { type: "string", description: 'Summary id (message id) or "latest". Used by action=read.' },
          query: { type: "string", description: "Words to look for. Used by action=search." },
          detail: {
            type: "string",
            enum: ["brief", "full", "sections"],
            description: "How much of the summary to return. Defaults to brief.",
          },
          sections: {
            type: "array",
            items: { type: "string" },
            description: 'Section headings for detail=sections, e.g. ["Objective","Next Move"].',
          },
          scope: { type: "string", enum: ["project", "all"], description: "Defaults to the current project." },
          limit: { type: "number", description: "Maximum summaries (1-50, default 10)." },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "list";
        const scope = str(input, "scope") === "all" ? "all" : "project";
        const limit = num(input, "limit", 10, 1, 50);
        const { projectID, directory } = await currentProject(ctx, context.sessionID);

        if (action === "repo") {
          return { content: await repoSnapshot(directory) };
        }

        if (action === "search") {
          const query = str(input, "query");
          if (!query) return { content: "Provide `query` for action=search." };
          const results = await searchSummaries(scope === "all" ? undefined : projectID, query, limit);
          return { content: formatSummarySearch(results) };
        }

        if (action === "read") {
          const id = str(input, "id") ?? "latest";
          const record_ = await findSummary(projectID, id);
          if (!record_) {
            const available = await listSummaries(projectID, 10);
            return {
              content:
                `No summary matching "${id}" in this project.` +
                (available.length ? `\n\nAvailable:\n${formatSummaryList(available)}` : ""),
            };
          }
          const detail = str(input, "detail") ?? "brief";
          if (detail === "full") return { content: formatFull(record_) };
          if (detail === "sections") return { content: formatSections(record_, strings(input, "sections")) };
          return { content: formatBrief(record_) };
        }

        const records = scope === "all" ? await listAllSummaries(limit) : await listSummaries(projectID, limit);
        const header =
          scope === "all"
            ? `Most recent compaction summaries across all projects (${records.length}):`
            : `Most recent compaction summaries for this project (${records.length}):`;
        return {
          content: `${header}\n\n${formatSummaryList(records)}\n\nRead one with action="read" and its id.`,
        };
      },
    });

    editor.add({
      name: "memory_history",
      description: [
        "Inspect the full message timeline of a session: list sessions, read a page, search inside it, or fetch one message.",
        "action=search returns only a window around the occurrences (context=window width, windows=clusters per message), never the full message — prefer it over action=read to inspect a long conversation.",
        "Tool calls and reasoning are excluded unless includeTools/includeReasoning is set.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["sessions", "read", "search", "message"], description: "Defaults to sessions." },
          sessionID: { type: "string", description: "Target session. Defaults to the current session." },
          query: {
            type: "string",
            description:
              "Words to look for (action=search). For action=sessions it filters by title, session directory or project path/name.",
          },
          messageID: { type: "string", description: "Message to fetch for action=message." },
          limit: { type: "number", description: "Maximum items (1-100; 40 for read, 20 otherwise)." },
          cursor: { type: "string", description: "Pagination cursor returned by a previous read." },
          order: { type: "string", enum: ["asc", "desc"], description: "Page direction for action=read. Defaults to desc." },
          includeTools: { type: "boolean", description: "Include tool calls and results. Off by default." },
          includeReasoning: { type: "boolean", description: "Include reasoning blocks. Off by default." },
          context: {
            type: "number",
            description: "Window width in characters around each occurrence cluster (action=search). 80-4000, defaults to 260.",
          },
          windows: {
            type: "number",
            description: "Maximum windows per message, one per occurrence cluster (action=search). 1-10, defaults to 3.",
          },
          scope: {
            type: "string",
            enum: ["project", "all"],
            description:
              "Scope for sessions (listing) and for read/search/message (target session). Defaults to project. " +
              "Pass scope=all to read or search sessions that belong to another project.",
          },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = record(raw);
        const action = str(input, "action") ?? "sessions";
        const sessionID = str(input, "sessionID") ?? context.sessionID;
        const includeTools = bool(input, "includeTools", false);
        const includeReasoning = bool(input, "includeReasoning", false);
        const { projectID } = await currentProject(ctx, context.sessionID);

        // Session-targeted actions are project-scoped by default; a session
        // that belongs to another project needs scope="all".
        if ((action === "read" || action === "search" || action === "message") && sessionID !== context.sessionID) {
          const scope = str(input, "scope") === "all" ? "all" : "project";
          if (scope === "project") {
            const targetInfo = await getSessionInfo(ctx, sessionID).catch(() => undefined);
            const targetProject = targetInfo
              ? ((await resolveProjectID(targetInfo).catch(() => undefined)) || targetInfo.projectID)
              : undefined;
            if (targetProject && targetProject !== projectID) {
              return {
                content:
                  `Session \`${sessionID}\` belongs to a different project (\`${targetProject}\`). ` +
                  'Pass scope="all" to read or search sessions across projects.',
              };
            }
          }
        }

        if (action === "sessions") {
          const scope = str(input, "scope") === "all" ? "all" : "project";
          const sessions = await listSessions(ctx, {
            projectID,
            scope,
            limit: num(input, "limit", 20, 1, 100),
            query: str(input, "query"),
          });
          return {
            content: `Sessions (${scope === "all" ? "all projects" : "this project"}):\n\n${formatSessionList(sessions)}`,
          };
        }

        if (action === "read") {
          const limit = num(input, "limit", 40, 1, 100);
          const order = str(input, "order") === "asc" ? "asc" : "desc";
          let read: { page: HistoryPage; partial: boolean; source: HistorySource };
          try {
            read = await readPage(ctx, sessionID, {
              limit,
              order,
              cursor: str(input, "cursor"),
            });
          } catch (error) {
            const detail = error instanceof Error && error.message ? error.message : "session not found";
            return {
              content: `Could not read session \`${sessionID}\`: ${detail}. Check the id with action="sessions".`,
            };
          }
          const { page, partial, source } = read;
          const messages = order === "desc" ? [...page.data].reverse() : page.data;
          const body = formatTimeline(messages, { includeTools, includeReasoning });
          const next = page.cursor?.next;
          const notes = [
            partial ? `> Partial: only the active context is available here (source: ${source}).` : "",
            next ? `> More messages available; call again with cursor="${next}".` : "",
            !includeTools ? "> Tool calls hidden; pass includeTools=true to see them." : "",
          ].filter(Boolean);
          return {
            content:
              `Session \`${sessionID}\` — ${messages.length} message(s).\n\n${body || "(nothing to show)"}` +
              (notes.length ? `\n\n${notes.join("\n")}` : ""),
          };
        }

        if (action === "search") {
          const query = str(input, "query");
          if (!query) return { content: "Provide `query` for action=search." };
          let result: { hits: HistorySearchHit[]; partial: boolean; source: HistorySource };
          try {
            result = await searchSession(ctx, sessionID, query, {
              includeTools,
              includeReasoning,
              limit: num(input, "limit", 20, 1, 100),
              context: num(input, "context", 260, 80, 4000),
              windows: num(input, "windows", 3, 1, 10),
            });
          } catch (error) {
            const detail = error instanceof Error && error.message ? error.message : "session not found";
            return {
              content: `Could not search session \`${sessionID}\`: ${detail}. Check the id with action="sessions".`,
            };
          }
          return {
            content:
              `Matches for "${query}" in \`${sessionID}\`:\n\n${formatHistorySearch(result, sessionID)}` +
              `\n\nFetch one with action="message" and its messageID.`,
          };
        }

        if (action === "message") {
          const messageID = str(input, "messageID");
          if (!messageID) return { content: "Provide `messageID` for action=message." };
          const { api, source } = await getHistoryApi(ctx, sessionID);
          try {
            const message = await api.get({ sessionID, messageID });
            // Same defaults as read/search: tool payloads are opt-in.
            const text = formatMessage(message, { includeTools, includeReasoning });
            if (!text) return { content: `Message ${messageID} has no displayable content.` };
            const note = includeTools ? "" : "\n\n> Tool calls hidden; pass includeTools=true to see them.";
            return { content: text + note };
          } catch (error) {
            return {
              content: `Could not read ${messageID} from ${sessionID} (source: ${source}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }

        return { content: `Unknown action "${action}". Use sessions, read, search or message.` };
      },
    });
  });
}

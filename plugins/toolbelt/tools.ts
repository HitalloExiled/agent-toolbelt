/** The three read-only tools exposed by the plugin. */

import type { PluginContext } from "./context.js";
import type { Runtime } from "./runtime.js";
import type { MessageKind } from "./types.js";
import { backfillProject, reindexProject, indexSummaryFiles } from "./indexer.js";
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
import { fmtDate, normalizeWhitespace } from "./util.js";

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
  return { info, projectID: info.projectID, directory: info.location?.directory };
}

export async function registerTools(ctx: PluginContext, runtime: Runtime) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "toolbelt_search",
      description: [
        "Search past conversations and compaction summaries across sessions of this project.",
        "The index holds only user text, assistant text and compaction summaries (never reasoning or tool payloads).",
        "Actions: search (default), stats, reindex.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "stats", "reindex"], description: "Defaults to search." },
          query: { type: "string", description: "Words to look for. Required for action=search." },
          scope: { type: "string", enum: ["project", "all"], description: "Defaults to the current project." },
          kind: {
            type: "string",
            enum: ["any", "summary", "user", "assistant"],
            description: "Filter by document kind. Defaults to any.",
          },
          limit: { type: "number", description: "Maximum hits (1-50, default 20)." },
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
          return {
            content: [
              `backend: ${runtime.index.backend}${runtime.index.error ? ` (${runtime.index.error})` : ""}`,
              `project: ${projectID}`,
              `indexed documents: ${mine} in this project, ${all} total`,
              `summary files in this project: ${summaries.length}`,
            ].join("\n"),
          };
        }

        if (action === "reindex") {
          const result = await reindexProject(runtime, projectID);
          return {
            content:
              `Reindexed project ${projectID}: ${result.sessions} sessions, ${result.messages} documents.` +
              (result.partial ? "\n> Partial: some sessions could only be read from the active context." : ""),
          };
        }

        const query = str(input, "query");
        if (!query) return { content: "Provide `query` (or use action=stats / action=reindex)." };

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

        const hits = await runtime.index.search(query, { projectID, scope, kind, limit });
        if (hits.length === 0) {
          return {
            content:
              `No matches for "${query}" (scope: ${scope}, kind: ${kind}).` +
              `\nTry scope="all", a different wording, or action="reindex".${partialNote}`,
          };
        }

        const lines = hits.map((hit) => {
          const session = hit.sessionID === context.sessionID ? "this session" : `\`${hit.sessionID}\``;
          return (
            `- **${fmtDate(hit.created)}** · ${hit.kind} · ${session}` +
            `${hit.title ? ` — ${hit.title}` : ""}` +
            `${hit.kind === "summary" && hit.messageID ? ` · summary \`${hit.messageID}\`` : ""}` +
            `\n  ${normalizeWhitespace(hit.snippet)}`
          );
        });
        return {
          content:
            `${hits.length} match(es) for "${query}" (scope: ${scope}).\n\n${lines.join("\n")}` +
            `\n\nRead more with toolbelt_summaries (summaries) or toolbelt_history (full messages).${partialNote}`,
        };
      },
    });

    editor.add({
      name: "toolbelt_summaries",
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
      name: "toolbelt_history",
      description: [
        "Inspect the full message timeline of a session: list sessions, read a page, search inside it, or fetch one message.",
        "Tool calls and reasoning are excluded unless includeTools/includeReasoning is set.",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["sessions", "read", "search", "message"], description: "Defaults to sessions." },
          sessionID: { type: "string", description: "Target session. Defaults to the current session." },
          query: { type: "string", description: "Words to look for (action=search) or title filter (action=sessions)." },
          messageID: { type: "string", description: "Message to fetch for action=message." },
          limit: { type: "number", description: "Maximum items (1-100; 40 for read, 20 otherwise)." },
          cursor: { type: "string", description: "Pagination cursor returned by a previous read." },
          order: { type: "string", enum: ["asc", "desc"], description: "Page direction for action=read. Defaults to desc." },
          includeTools: { type: "boolean", description: "Include tool calls and results. Off by default." },
          includeReasoning: { type: "boolean", description: "Include reasoning blocks. Off by default." },
          scope: { type: "string", enum: ["project", "all"], description: "Session listing scope. Defaults to project." },
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
          const { page, partial, source } = await readPage(ctx, sessionID, {
            limit,
            order,
            cursor: str(input, "cursor"),
          });
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
          const result = await searchSession(ctx, sessionID, query, {
            includeTools,
            includeReasoning,
            limit: num(input, "limit", 20, 1, 100),
          });
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
            const text = formatMessage(message, {
              includeTools: input.includeTools === undefined ? true : includeTools,
              includeReasoning,
            });
            return { content: text || `Message ${messageID} has no displayable content.` };
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

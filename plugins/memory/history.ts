/**
 * Session history access.
 *
 * The plugin API intentionally exposes `session.context` (active context) and
 * not the full message timeline. We probe the in-process runtime first (some
 * builds attach the message domain), then talk HTTP to the local service, and
 * finally fall back to the active context. The last fallback is explicitly
 * marked partial.
 */

import type { PluginContext } from "./context.js";
import type { ContentPart, MessageLike, SessionInfoLike } from "./types.js";
import { discoverService, serviceGet } from "./service.js";
import { listProjects, resolveProjectID, sessionHaystack } from "./projects.js";
import { clip, fmtDate, modelLabel, normalizeWhitespace, shortID, snippet, timeMs, tokenize } from "./util.js";

export type HistorySource = "session" | "service" | "context";

export interface HistoryPage {
  data: MessageLike[];
  cursor?: { next?: string | null; previous?: string | null } | null;
}

export interface HistoryApi {
  list(input: {
    sessionID: string;
    limit?: number;
    order?: "asc" | "desc";
    cursor?: string;
    type?: string;
  }): Promise<HistoryPage>;
  get(input: { sessionID: string; messageID: string }): Promise<MessageLike>;
}

export interface HistoryApiInfo {
  api: HistoryApi;
  source: HistorySource;
}

function asArray(value: unknown): MessageLike[] {
  if (Array.isArray(value)) return value as MessageLike[];
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: MessageLike[] }).data;
  }
  return [];
}

const serviceApi: HistoryApi = {
  async list(input) {
    const params = new URLSearchParams();
    if (input.limit) params.set("limit", String(input.limit));
    // The service rejects `order` combined with `cursor`: the cursor already
    // encodes the paging direction from the page it was issued on.
    if (input.cursor) params.set("cursor", input.cursor);
    else if (input.order) params.set("order", input.order);
    if (input.type) params.set("type", input.type);
    const query = params.toString();
    const page = await serviceGet<{ data?: MessageLike[]; cursor?: HistoryPage["cursor"] }>(
      `/api/session/${encodeURIComponent(input.sessionID)}/message${query ? `?${query}` : ""}`,
    );
    return { data: asArray(page), cursor: page?.cursor ?? null };
  },
  async get(input) {
    const response = await serviceGet<{ data?: MessageLike } | MessageLike>(
      `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
    );
    const message =
      response && typeof response === "object" && "data" in response
        ? (response as { data?: MessageLike }).data
        : (response as MessageLike | undefined);
    if (!message?.id) throw new Error(`message ${input.messageID} not found`);
    return message;
  },
};

const serviceSessions = new Map<string, boolean>();

/** The registered service may be a different server than the one we run in. */
async function serviceHasSession(sessionID: string): Promise<boolean> {
  const known = serviceSessions.get(sessionID);
  if (known !== undefined) return known;
  let ok = false;
  let definitive = false;
  try {
    const page = await serviceApi.list({ sessionID, limit: 1, order: "desc" });
    ok = Array.isArray(page.data);
    definitive = true;
  } catch (error) {
    // Only a definitive 404 is worth caching; transient failures (service
    // restart, timeout) must not poison the cache for the whole process.
    definitive = error instanceof Error && /HTTP 404/.test(error.message);
  }
  if (definitive) {
    if (serviceSessions.size > 500) serviceSessions.clear();
    serviceSessions.set(sessionID, ok);
  }
  return ok;
}

export async function getHistoryApi(ctx: PluginContext, sessionID?: string): Promise<HistoryApiInfo> {
  const embedded = (ctx.session as unknown as { message?: Partial<HistoryApi> }).message;
  if (embedded && typeof embedded.list === "function" && typeof embedded.get === "function") {
    return { api: embedded as HistoryApi, source: "session" };
  }

  if (await discoverService()) {
    if (!sessionID || (await serviceHasSession(sessionID))) return { api: serviceApi, source: "service" };
  }

  const contextApi: HistoryApi = {
    async list(input) {
      const active = asArray(await ctx.session.context({ sessionID: input.sessionID } as never));
      let data = active;
      if (input.order === "desc") data = [...data].reverse();
      if (input.limit && input.limit > 0) data = data.slice(-input.limit);
      return { data, cursor: null };
    },
    async get(input) {
      const page = await this.list({ sessionID: input.sessionID, limit: 10_000 });
      const found = page.data.find((message) => message.id === input.messageID);
      if (!found) throw new Error(`message ${input.messageID} is not in the active context (it may predate a compaction)`);
      return found;
    },
  };
  return { api: contextApi, source: "context" };
}

export async function getSessionInfo(ctx: PluginContext, sessionID: string): Promise<SessionInfoLike> {
  return (await ctx.session.get({ sessionID } as never)) as unknown as SessionInfoLike;
}

export interface ListSessionsOptions {
  projectID?: string;
  scope: "project" | "all";
  limit?: number;
  query?: string;
}

/**
 * List sessions. The server-side `search` only matches session titles, so the
 * query is applied client-side against the title, the session directory and
 * the project's canonical path/name. Sessions that OpenCode left at the root
 * project `global` while their directory belongs to a real project are
 * re-homed client-side, so they show up in that project's listing.
 *
 * Each source is paged (cursor) until the requested limit is satisfied or the
 * server stops returning pages, so projects with more than 100 sessions are
 * not silently truncated.
 */
export async function listSessions(ctx: PluginContext, options: ListSessionsOptions): Promise<SessionInfoLike[]> {
  const pageSize = Math.max(1, Math.min(100, options.limit ?? 20));
  const query = options.query?.trim();
  const terms = query ? tokenize(query) : [];
  const projects = await listProjects();

  const sources: Array<{ project?: string }> =
    options.scope === "project" && options.projectID
      ? [
          { project: options.projectID },
          // Pull in root-project sessions too; the project filter below
          // re-homes the ones that physically belong to this project.
          ...(options.projectID !== "global" ? [{ project: "global" }] : []),
        ]
      : [];
  if (sources.length === 0) sources.push({ project: undefined });

  // Without a query one page per source already covers the limit (≤100);
  // with a query we may need to page further to collect enough matches.
  const maxPages = terms.length > 0 ? 5 : 1;

  const seen = new Set<string>();
  const sessions: SessionInfoLike[] = [];
  outer: for (const source of sources) {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const request: Record<string, unknown> = { limit: 100 };
      if (source.project) request.project = source.project;
      if (cursor) request.cursor = cursor;
      let raw: unknown;
      try {
        raw = await ctx.session.list(request as never);
      } catch {
        break;
      }
      const data = ((raw as { data?: unknown[] } | undefined)?.data ?? []) as SessionInfoLike[];
      if (data.length === 0) break;
      for (const session of data) {
        if (!session?.id || seen.has(session.id)) continue;
        seen.add(session.id);
        if (options.scope === "project" && options.projectID) {
          const resolved = (await resolveProjectID(session)) ?? session.projectID;
          if (resolved !== options.projectID) continue;
        }
        if (terms.length > 0 && !terms.every((term) => sessionHaystack(session, projects).includes(term))) continue;
        sessions.push(session);
        if (sessions.length >= pageSize) break outer;
      }
      const next = (raw as { cursor?: { next?: string } } | undefined)?.cursor?.next;
      if (!next || next === cursor) break;
      cursor = next;
    }
  }
  return sessions;
}

export interface ListedMessages {
  messages: MessageLike[];
  partial: boolean;
  source: HistorySource;
}

/** Page through the whole timeline (or the active context when only that is available). */
export async function listAllMessages(
  ctx: PluginContext,
  sessionID: string,
  options: { max?: number; pageSize?: number } = {},
): Promise<ListedMessages> {
  const { api, source } = await getHistoryApi(ctx, sessionID);
  const max = Math.max(1, options.max ?? 4000);
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 100));
  const seen = new Set<string>();
  const messages: MessageLike[] = [];
  let cursor: string | undefined;

  if (source === "context") {
    const page = await api.list({ sessionID, limit: max, order: "asc" });
    return { messages: page.data.slice(0, max), partial: true, source };
  }

  for (let guard = 0; guard < 1000 && messages.length < max; guard++) {
    const page = await api.list({ sessionID, limit: pageSize, order: "asc", ...(cursor ? { cursor } : {}) });
    for (const message of page.data) {
      if (!message?.id || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
      if (messages.length >= max) break;
    }
    const next = page.cursor?.next;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return { messages, partial: false, source };
}

export async function readPage(
  ctx: PluginContext,
  sessionID: string,
  options: { limit?: number; cursor?: string; order?: "asc" | "desc" },
): Promise<{ page: HistoryPage; partial: boolean; source: HistorySource }> {
  const { api, source } = await getHistoryApi(ctx, sessionID);
  const page = await api.list({
    sessionID,
    limit: Math.max(1, Math.min(100, options.limit ?? 40)),
    order: options.order ?? "desc",
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return { page, partial: source === "context", source };
}

export function messageCreated(message: MessageLike): number {
  return timeMs(message.time?.created) || 0;
}

function partText(part: ContentPart): string {
  return typeof part.text === "string" ? part.text : "";
}

function filesSuffix(message: MessageLike): string {
  const names = (message.files ?? [])
    .map((file) => file.name ?? file.description ?? "")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? `\n[attachments: ${names.join(", ")}]` : "";
}

export interface ExtractOptions {
  includeTools?: boolean;
  includeReasoning?: boolean;
}

/** Text that belongs in the narrative index: user text, assistant text, summaries. */
export function extractNarrative(message: MessageLike): { kind: "user" | "assistant" | "summary"; text: string } | undefined {
  if (message.type === "user") {
    const text = `${message.text ?? ""}${filesSuffix(message)}`.trim();
    return text ? { kind: "user", text } : undefined;
  }
  if (message.type === "assistant") {
    const text = (message.content ?? [])
      .filter((part) => part.type === "text")
      .map(partText)
      .join("\n")
      .trim();
    return text ? { kind: "assistant", text } : undefined;
  }
  if (message.type === "compaction" && message.status === "completed") {
    const text = (message.summary ?? "").trim();
    return text ? { kind: "summary", text } : undefined;
  }
  return undefined;
}

/** Text used by on-demand history search, with tools/reasoning opt-in. */
export function extractSearchText(message: MessageLike, options: ExtractOptions = {}): string {
  const parts: string[] = [];
  if (message.type === "user") {
    const text = `${message.text ?? ""}${filesSuffix(message)}`.trim();
    if (text) parts.push(text);
  } else if (message.type === "assistant") {
    for (const part of message.content ?? []) {
      if (part.type === "text") {
        const text = partText(part).trim();
        if (text) parts.push(text);
      } else if (part.type === "reasoning" && options.includeReasoning) {
        const text = partText(part).trim();
        if (text) parts.push(`[reasoning] ${text}`);
      } else if (part.type === "tool" && options.includeTools) {
        const text = formatToolPart(part, 4000);
        if (text) parts.push(text);
      }
    }
  } else if (message.type === "compaction") {
    const text = (message.summary ?? "").trim();
    if (text) parts.push(text);
  } else if (message.type === "synthetic" || message.type === "system") {
    const text = String(message.text ?? "").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function valueToText(value: unknown, max = 4000): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value, null, 2), max);
  } catch {
    return clip(String(value), max);
  }
}

function formatToolPart(part: ContentPart, max = 4000): string {
  const state = part.state;
  if (!state) return "";
  const lines = [`[tool: ${part.name ?? "unknown"}] ${state.status ?? ""}`.trim()];
  const title = state.title ? String(state.title) : "";
  if (title) lines.push(title);
  if (state.input !== undefined) lines.push(`input:\n${valueToText(state.input, max)}`);
  if (state.output !== undefined) lines.push(`output:\n${valueToText(state.output, max)}`);
  if (state.error !== undefined) lines.push(`error:\n${valueToText(state.error, max)}`);
  return lines.join("\n");
}

export function formatMessage(message: MessageLike, options: ExtractOptions = {}): string {
  const date = fmtDate(messageCreated(message));
  const header = `### [${message.type}] ${date} · ${message.id}`;
  if (message.type === "user") {
    return `${header}\n\n${message.text ?? ""}${filesSuffix(message)}`.trim();
  }
  if (message.type === "assistant") {
    const blocks: string[] = [];
    for (const part of message.content ?? []) {
      if (part.type === "text") {
        const text = partText(part).trim();
        if (text) blocks.push(text);
      } else if (part.type === "reasoning" && options.includeReasoning) {
        const text = partText(part).trim();
        if (text) blocks.push(`[reasoning]\n${clip(text, 3000)}`);
      } else if (part.type === "tool" && options.includeTools) {
        blocks.push(formatToolPart(part));
      }
    }
    const meta = message.model ? `\nmodel: ${modelLabel(message.model)}` : "";
    return `${header}${meta}\n\n${blocks.join("\n\n")}`.trim();
  }
  if (message.type === "compaction") {
    return `${header}\n\n${clip(message.summary ?? "", 16_000, "\n\n… (truncated)")}`.trim();
  }
  if (message.type === "shell") {
    const text = extractSearchText(message, { includeTools: true });
    return `${header}\n\n${clip(text || valueToText(message), 8000)}`.trim();
  }
  if (message.type === "synthetic" || message.type === "system" || message.type === "skill") {
    const text = String(message.text ?? message.description ?? "").trim();
    return `${header}\n\n${clip(text, 4000)}`.trim();
  }
  return "";
}

export function formatTimeline(
  messages: MessageLike[],
  options: ExtractOptions & { maxTotal?: number } = {},
): string {
  const maxTotal = options.maxTotal ?? 40_000;
  const blocks: string[] = [];
  let size = 0;
  for (const message of messages) {
    const block = formatMessage(message, options);
    if (!block) continue;
    if (size + block.length > maxTotal) {
      blocks.push(`… (timeline truncated at ${maxTotal} characters; use cursor to continue)`);
      break;
    }
    blocks.push(block);
    size += block.length;
  }
  return blocks.join("\n\n---\n\n");
}

export interface HistorySearchHit {
  message: MessageLike;
  snippet: string;
  score: number;
}

export interface SearchSessionOptions extends ExtractOptions {
  maxMessages?: number;
  limit?: number;
  /** Width in characters of the window around each occurrence cluster. */
  context?: number;
  /** Max windows per message, one per occurrence cluster. */
  windows?: number;
}

/**
 * Search a session's timeline. Hits carry only a window around the
 * occurrences (never the full message): `context` controls the window width
 * and `windows` how many clusters of occurrences are shown per message.
 */
export async function searchSession(
  ctx: PluginContext,
  sessionID: string,
  query: string,
  options: SearchSessionOptions,
): Promise<{ hits: HistorySearchHit[]; partial: boolean; source: HistorySource }> {
  const terms = tokenize(query);
  if (terms.length === 0) return { hits: [], partial: false, source: "session" };
  const context = Math.max(80, Math.min(4000, options.context ?? 260));
  const windows = Math.max(1, Math.min(10, options.windows ?? 3));
  const listed = await listAllMessages(ctx, sessionID, { max: options.maxMessages ?? 4000 });
  const hits: HistorySearchHit[] = [];
  for (const message of listed.messages) {
    const text = extractSearchText(message, options);
    if (!text) continue;
    const haystack = text.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(term, from);
        if (at < 0) break;
        score++;
        from = at + term.length;
      }
    }
    if (score > 0) hits.push({ message, score, snippet: snippet(text, terms, context, windows) });
  }
  hits.sort((a, b) => b.score - a.score || messageCreated(a.message) - messageCreated(b.message));
  return {
    hits: hits.slice(0, Math.max(1, options.limit ?? 20)),
    partial: listed.partial,
    source: listed.source,
  };
}

export function formatHistorySearch(
  result: { hits: HistorySearchHit[]; partial: boolean; source: HistorySource },
  sessionID: string,
): string {
  const note = result.partial
    ? `\n\n> Partial: this build only exposes the active context after a compaction (source: ${result.source}).`
    : "";
  if (result.hits.length === 0) return `No matches in session ${sessionID}.${note}`;
  const lines = result.hits.map(
    (hit) =>
      `- **${fmtDate(messageCreated(hit.message))}** · \`${hit.message.id}\` · ${hit.message.type}\n  ${normalizeWhitespace(hit.snippet)}`,
  );
  return `${lines.join("\n")}${note}`;
}

export function formatSessionList(sessions: SessionInfoLike[]): string {
  if (sessions.length === 0) return "No sessions found.";
  return sessions
    .map((session) => {
      const updated = fmtDate(timeMs(session.time?.updated));
      return `- \`${session.id}\` · ${updated} · ${session.title ?? "(untitled)"}${
        session.location?.directory ? `\n  ${session.location.directory}` : ""
      }`;
    })
    .join("\n");
}

export function formatMessageCompact(message: MessageLike): string {
  const text = extractNarrative(message)?.text ?? extractSearchText(message, { includeTools: true });
  return `${shortID(message.id, 14)} ${message.type}: ${clip(normalizeWhitespace(text), 120)}`;
}

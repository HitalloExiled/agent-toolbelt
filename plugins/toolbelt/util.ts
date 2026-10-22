/** Small formatting/search helpers with no OpenCode dependency. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Accepts milliseconds or an ISO string and always returns milliseconds. */
export function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function fmtDate(ms: number): string {
  if (!ms) return "unknown";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function shortID(id: string, size = 10): string {
  if (!id) return "?";
  return id.length <= size ? id : `${id.slice(0, size)}…`;
}

export function clip(text: string, max: number, note = "…"): string {
  if (text.length <= max) return text;
  if (max <= note.length) return text.slice(0, max);
  return text.slice(0, max - note.length) + note;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 2) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Window(s) around the occurrences of any query term, useful for compact
 * search results. Up to `maxWindows` non-overlapping windows, each `width`
 * characters centered on a cluster of occurrences; clusters that overlap
 * merge into one window. With no occurrence the beginning of the text is
 * returned instead.
 */
export function snippet(text: string, terms: string[], width = 260, maxWindows = 1): string {
  const flat = normalizeWhitespace(text);
  if (!flat) return "";
  const lower = flat.toLocaleLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      positions.push(at);
      from = at + Math.max(1, term.length);
    }
  }
  if (positions.length === 0) return clip(flat, width);
  positions.sort((a, b) => a - b);
  const half = Math.floor(width / 2);
  const windows: Array<[number, number]> = [];
  for (const at of positions) {
    const start = Math.max(0, at - half);
    const end = Math.min(flat.length, start + width);
    const last = windows[windows.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
      if (windows.length >= maxWindows) break;
    }
  }
  return windows
    .map(([s, e]) => `${s > 0 ? "…" : ""}${flat.slice(s, e)}${e < flat.length ? "…" : ""}`)
    .join("  …  ");
}

export function modelLabel(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const provider = typeof model.providerID === "string" ? model.providerID : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (provider && id) return `${provider}/${id}`;
  return id || provider || undefined;
}

export function safeFilename(value: string, fallback = "unknown"): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180);
  return safe || fallback;
}

export function isoCompact(ms: number): string {
  const date = new Date(ms || Date.now());
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Atomic, private storage helpers. */

import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compactionsRoot, dataRoot } from "./paths.js";

export interface Frontmatter {
  [key: string]: string | number | boolean | null;
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function ensureDataDirs(): Promise<void> {
  await ensurePrivateDir(dataRoot());
  await ensurePrivateDir(compactionsRoot());
}

export async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode });
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function formatFrontmatter(fields: Frontmatter): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
  raw: string;
}

export function parseFrontmatter(raw: string): ParsedDocument {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { frontmatter: {}, body: text.trim(), raw: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: {}, body: text.trim(), raw: text };
  }
  const header = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "").trim();
  const frontmatter: Frontmatter = {};
  for (const line of header.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const rawValue = line.slice(at + 1).trim();
    if (!key || !rawValue) continue;
    let value: string | number | boolean | null = rawValue;
    if (rawValue === "null") value = null;
    else if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
    else if (rawValue.startsWith('"') || rawValue.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(rawValue);
        if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") value = parsed;
      } catch {
        value = rawValue;
      }
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body, raw: text };
}

export async function listMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name))
    .sort()
    .reverse();
}

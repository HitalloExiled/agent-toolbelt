/** Filesystem layout. Everything lives under XDG data, never in the repo. */

import { homedir } from "node:os";
import { join } from "node:path";
import { safeFilename } from "./util.js";

export function dataRoot(): string {
  const override = process.env.MEMORY_DATA_DIR?.trim();
  if (override) return override;
  // Shared with the notes DB ($XDG_DATA_HOME/opencode/memory/notes.db): the
  // memory root holds all durable memory of the agent.
  return join(opencodeDataDir(), "memory");
}

/** Default XDG data base (OpenCode's own data dir), shared with legacyDataRoot. */
function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || join(homedir(), ".local", "share");
  return join(base, "opencode");
}

/**
 * Pre-rename data root (~/.local/share/opencode/agent-toolbelt); used for
 * one-time migration. (The original root, ~/.local/share/agent-toolbelt,
 * was already folded into it by the previous version.)
 */
export function legacyDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || join(homedir(), ".local", "share");
  return join(base, "opencode", "agent-toolbelt");
}

export function compactionsRoot(): string {
  return join(dataRoot(), "compactions");
}

export function projectDir(projectID: string): string {
  return join(compactionsRoot(), safeFilename(projectID, "project"));
}

export function indexPath(): string {
  return join(dataRoot(), "index.db");
}

export function jsonIndexPath(): string {
  return join(dataRoot(), "index.json");
}

export function summaryKeep(): number {
  const value = Number(process.env.MEMORY_SUMMARY_KEEP ?? "20");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

export function injectMax(): number {
  const value = Number(process.env.MEMORY_INJECT_MAX ?? "6000");
  return Number.isFinite(value) && value > 1000 ? Math.floor(value) : 6000;
}

export function indexTextMax(): number {
  const value = Number(process.env.MEMORY_INDEX_TEXT_MAX ?? "16000");
  return Number.isFinite(value) && value > 1000 ? Math.floor(value) : 16000;
}

export function backfillSessionLimit(): number {
  const value = Number(process.env.MEMORY_BACKFILL_SESSIONS ?? "100");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
}

export function backfillMessageLimit(): number {
  const value = Number(process.env.MEMORY_BACKFILL_MESSAGES ?? "4000");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4000;
}

/** Root for the local embedding model weights (downloaded once). */
export function embedModelsDir(): string {
  return join(dataRoot(), "embed-models");
}

/** Active embedding model id (see EMBED_MODELS in embed.ts). */
export function embedModelName(): string {
  return process.env.MEMORY_EMBED_MODEL?.trim() || "minilm-qint8";
}

/** Set MEMORY_EMBED_DISABLED=1 to turn the semantic layer off (FTS only). */
export function embedDisabled(): boolean {
  return process.env.MEMORY_EMBED_DISABLED?.trim() === "1";
}

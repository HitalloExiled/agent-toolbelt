/** Filesystem layout. Everything lives under XDG data, never in the repo. */

import { homedir } from "node:os";
import { join } from "node:path";
import { safeFilename } from "./util.js";

export function dataRoot(): string {
  const override = process.env.TOOLBELT_DATA_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg || join(homedir(), ".local", "share");
  return join(base, "agent-toolbelt");
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
  const value = Number(process.env.TOOLBELT_SUMMARY_KEEP ?? "20");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

export function injectMax(): number {
  const value = Number(process.env.TOOLBELT_INJECT_MAX ?? "6000");
  return Number.isFinite(value) && value > 1000 ? Math.floor(value) : 6000;
}

export function indexTextMax(): number {
  const value = Number(process.env.TOOLBELT_INDEX_TEXT_MAX ?? "16000");
  return Number.isFinite(value) && value > 1000 ? Math.floor(value) : 16000;
}

export function backfillSessionLimit(): number {
  const value = Number(process.env.TOOLBELT_BACKFILL_SESSIONS ?? "100");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 100;
}

export function backfillMessageLimit(): number {
  const value = Number(process.env.TOOLBELT_BACKFILL_MESSAGES ?? "4000");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4000;
}

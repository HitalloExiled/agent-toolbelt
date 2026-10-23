/**
 * Minimal HTTP access to the local OpenCode service.
 *
 * Plugins run inside a runtime that only provides `effect` and
 * `@opencode/plugin`; `@opencode/client` cannot be imported from here. The
 * service registration file carries everything needed to talk to the same
 * server over HTTP, which is how we reach endpoints the plugin context does not
 * expose (notably the full message timeline).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceEndpoint {
  url: string;
  headers: Record<string, string>;
  version?: string;
}

function registrationPath(): string {
  const override = process.env.OPENCODE_SERVICE_FILE?.trim();
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg || join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

let cached: Promise<ServiceEndpoint | undefined> | undefined;

async function read(): Promise<ServiceEndpoint | undefined> {
  try {
    const raw = JSON.parse(await readFile(registrationPath(), "utf8")) as {
      url?: unknown;
      password?: unknown;
      version?: unknown;
    };
    if (typeof raw.url !== "string" || !raw.url) return undefined;
    const headers: Record<string, string> = { accept: "application/json" };
    if (typeof raw.password === "string" && raw.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${raw.password}`).toString("base64")}`;
    }
    const endpoint: ServiceEndpoint = {
      url: raw.url.replace(/\/$/, ""),
      headers,
      version: typeof raw.version === "string" ? raw.version : undefined,
    };
    // Confirm the registration points at a live server before trusting it.
    const response = await fetch(`${endpoint.url}/api/info`, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    await response.arrayBuffer();
    return endpoint;
  } catch {
    return undefined;
  }
}

export function discoverService(): Promise<ServiceEndpoint | undefined> {
  if (!cached) cached = read();
  return cached;
}

export function resetService(): void {
  cached = undefined;
}

export async function serviceGet<T>(path: string, timeoutMs = 15_000): Promise<T | undefined> {
  const endpoint = await discoverService();
  if (!endpoint) return undefined;
  const response = await fetch(`${endpoint.url}${path}`, {
    headers: endpoint.headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) resetService();
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

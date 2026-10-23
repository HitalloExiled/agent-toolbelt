/**
 * Project resolution.
 *
 * OpenCode assigns sessions to a project, but in this build sessions inside
 * a real project's directory can carry the root project id `global` instead.
 * The memory plugin operates per project, so every session is resolved to the
 * innermost project whose canonical path contains its directory.
 *
 * The plugin context has no project domain, so the list comes from the local
 * service over HTTP. Everything degrades gracefully: with no live service the
 * session keeps its own projectID.
 */

import { serviceGet } from "./service.js";

export interface ProjectRef {
  id: string;
  canonical: string;
  name?: string;
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; list: ProjectRef[] } | undefined;

export function resetProjectCache(): void {
  cache = undefined;
}

export async function listProjects(): Promise<ProjectRef[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;
  try {
    const raw = await serviceGet<unknown>("/api/project");
    const arr: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown[] }).data)
        ? (raw as { data: unknown[] }).data
        : [];
    const list: ProjectRef[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const project = entry as Record<string, unknown>;
      if (typeof project.id !== "string" || typeof project.canonical !== "string") continue;
      list.push({
        id: project.id,
        canonical: project.canonical,
        name: typeof project.name === "string" ? project.name : undefined,
      });
    }
    cache = { at: Date.now(), list };
    return list;
  } catch {
    return cache?.list ?? [];
  }
}

/** Innermost project containing the directory (longest canonical prefix). */
export function projectForDirectory(
  directory: string | undefined,
  projects: ProjectRef[],
): ProjectRef | undefined {
  if (!directory) return undefined;
  let best: ProjectRef | undefined;
  for (const project of projects) {
    const canonical = project.canonical;
    if (canonical === "/") continue; // the root project is a last resort, never a prefix match
    if (directory === canonical || directory.startsWith(canonical + "/")) {
      if (!best || canonical.length > best.canonical.length) best = project;
    }
  }
  return best;
}

/**
 * The project a session belongs to for the memory plugin. Explicit
 * associations win; sessions left at `global` (or without a project) are
 * re-homed by their directory.
 */
export async function resolveProjectID(
  session: { projectID?: string; location?: { directory?: string } },
): Promise<string | undefined> {
  const own = session.projectID;
  if (own && own !== "global") return own;
  const projects = await listProjects();
  if (projects.length === 0) return own;
  return projectForDirectory(session.location?.directory, projects)?.id ?? own;
}

/** Haystack used to match a session-listing query: title, directory, project. */
export function sessionHaystack(session: {
  title?: string;
  projectID?: string;
  location?: { directory?: string };
}, projects: ProjectRef[]): string {
  const ref = projects.find((project) => project.id === session.projectID);
  return [session.title ?? "", session.location?.directory ?? "", ref?.canonical ?? "", ref?.name ?? ""]
    .join(" ")
    .toLocaleLowerCase();
}

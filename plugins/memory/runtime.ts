/** Per-process state shared by hooks, tools and commands. */

import type { PluginContext } from "./context.js";
import type { MemoryIndex } from "./index-db.js";

export interface SessionRuntime {
  projectID?: string;
  injected: boolean;
  captured: boolean;
  lastCompactionID?: string;
}

export interface Runtime {
  readonly ctx: PluginContext;
  readonly index: MemoryIndex;
  readonly pendingCompactions: Set<string>;
  readonly sessions: Map<string, SessionRuntime>;
  readonly backfills: Map<string, Promise<{ sessions: number; messages: number; partial: boolean }>>;
  readonly backfilled: Set<string>;
}

export function createRuntime(ctx: PluginContext, index: MemoryIndex): Runtime {
  return {
    ctx,
    index,
    pendingCompactions: new Set(),
    sessions: new Map(),
    backfills: new Map(),
    backfilled: new Set(),
  };
}

export function sessionRuntime(runtime: Runtime, sessionID: string): SessionRuntime {
  let state = runtime.sessions.get(sessionID);
  if (!state) {
    state = { injected: false, captured: false };
    runtime.sessions.set(sessionID, state);
    // Bound the map; old sessions are recreated lazily if they come back.
    if (runtime.sessions.size > 500) {
      const oldest = runtime.sessions.keys().next().value;
      if (oldest) runtime.sessions.delete(oldest);
    }
  }
  return state;
}

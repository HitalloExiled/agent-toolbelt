/**
 * memory plugin (formerly agent-toolbelt).
 *
 * - Captures every completed compaction summary as a Markdown file under XDG data.
 * - Injects the repository state and the previous session handoff once per session.
 * - Exposes read-only tools to search summaries and past conversations.
 */

import { Plugin } from "@opencode/plugin";
import { registerCommands } from "./commands.js";
import { openIndex } from "./index-db.js";
import { onContext } from "./inject.js";
import { createRuntime } from "./runtime.js";
import { ensureDataDirs } from "./storage.js";
import { registerTools } from "./tools.js";

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    await ensureDataDirs().catch((error) => {
      console.error(`[memory] data directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });

    const index = await openIndex();
    const runtime = createRuntime(ctx, index);

    const registrations = await Promise.all([
      registerTools(ctx, runtime),
      registerCommands(ctx),
      ctx.session.hook("compaction", (event) => {
        // The summary does not exist yet; mark the session and read it on the
        // next agent-loop context.
        runtime.pendingCompactions.add(event.sessionID);
      }),
      ctx.session.hook("context", async (event) => {
        await onContext(ctx, runtime, { sessionID: event.sessionID, system: event.system });
      }),
    ]);

    return async () => {
      for (const registration of registrations) {
        await registration.dispose().catch(() => undefined);
      }
      await index.close().catch(() => undefined);
    };
  },
});

/**
 * notes plugin — long-term memory tools under the "notes" namespace
 * (same pattern as the memory plugin: memory.* / notes.*).
 *
 * - In Code Mode the tools are callable as tools.notes.add /
 *   tools.notes.search / ... (one "notes" group in the catalog).
 * - In regular sessions the definitions keep the underscored names
 *   (notes_add, notes_search, ...) exactly as before, so the existing
 *   permission rules (resource: "notes_add", ...) keep matching.
 *
 * The tools are a thin, typed wrapper over the global `notes` CLI
 * (memory/notes.py in this repo). Nothing is ever deleted: `retract`
 * only hides a note and `restore` brings back old revisions.
 */

import { Plugin } from "@opencode/plugin";
import {
  add,
  confirm,
  dispute,
  doctor,
  history,
  restore,
  retract,
  search,
  update,
  view,
} from "./notes.js";

export default Plugin.define({
  id: "notes",
  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      // editor.namespace() only labels the catalog group; the per-tool
      // options.namespace below is what actually prefixes the qualified
      // name (tools.notes.*) in Code Mode.
      editor.namespace({
        name: "notes",
        description:
          "Curated long-term memory: decisions, solved problems, configuration and snippets, with a trust lifecycle (confirm/dispute/retract) and full version history. Use notes.search BEFORE working on a project with history and before saving a new note. Register durable facts with notes.add (in English). Nothing is ever deleted: retract hides, restore revives.",
      });
      editor.add({ ...add, options: { namespace: "notes" } });
      editor.add({ ...update, options: { namespace: "notes" } });
      editor.add({ ...search, options: { namespace: "notes" } });
      editor.add({ ...confirm, options: { namespace: "notes" } });
      editor.add({ ...dispute, options: { namespace: "notes" } });
      editor.add({ ...retract, options: { namespace: "notes" } });
      editor.add({ ...history, options: { namespace: "notes" } });
      editor.add({ ...restore, options: { namespace: "notes" } });
      editor.add({ ...view, options: { namespace: "notes" } });
      editor.add({ ...doctor, options: { namespace: "notes" } });
    });

    return async () => {
      await registration.dispose().catch(() => undefined);
    };
  },
});

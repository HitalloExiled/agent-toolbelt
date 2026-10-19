/**
 * notes — long-term memory tools.
 *
 * Thin, typed wrapper over the global `notes` CLI, which lives in
 * ../memory/notes.py inside this repo. The wrapper exposes NO destructive
 * operation: only add / update / search / list / doctor. `update` is the only
 * mutation of an existing note and exists to correct conflicting information.
 *
 * Safety:
 *  - execution via spawn with argv (no shell) => the note content is never
 *    interpreted; quotes, `;`, `$(...)`, emoji and newlines stay literal;
 *  - the `#problem` guardrail refuses to save without Symptom/Cause/Solution,
 *    turning the skill's convention into something the tool *guarantees*.
 */

import { tool } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CATEGORIES = [
  "problem",
  "decision",
  "config",
  "snippet",
  "architecture",
  "general",
] as const;

type Run = { code: number; stdout: string; stderr: string };

/** Resolve the binary: $NOTES_BIN > ~/.local/bin/notes > PATH. */
function nbCommand(): string {
  if (process.env.NOTES_BIN) return process.env.NOTES_BIN;
  const local = join(homedir(), ".local", "bin", "notes");
  if (existsSync(local)) return local;
  return "notes";
}

function runNb(args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nbCommand(), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) =>
      resolve({
        code: 127,
        stdout,
        stderr:
          stderr +
          `\ncould not run '${nbCommand()}': ${err.message}\n` +
          "install it with ./install.sh in the agent-toolbelt repo (creates the symlink in ~/.local/bin).",
      }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin?.end(input ?? "");
  });
}

function render(run: Run): string {
  const out = run.stdout.trim();
  const err = run.stderr.trim();
  if (run.code === 0) return err ? `${out}\n${err}` : out;
  return [out, err, `(exit ${run.code})`].filter(Boolean).join("\n");
}

/** Normalize for comparison: strip accents, lowercase. */
function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Required sections missing from a #problem note. */
function missingProblemSections(content: string): string[] {
  const text = norm(content);
  const required: Array<[string, string]> = [
    ["Symptom", "symptom"],
    ["Cause", "cause"],
    ["Solution", "solution"],
  ];
  return required.filter(([, needle]) => !text.includes(needle)).map(([label]) => label);
}

export const add = tool({
  description:
    "Save a note to long-term memory (notes). Use for decisions, non-obvious " +
    "configuration, snippets and — above all — solved problems. " +
    "Rule: if category=problem, content MUST contain Symptom, Cause and Solution " +
    "(the tool refuses to save if one is missing). Before saving, search with " +
    "notes_search to avoid duplicates. Write notes in English.",
  args: {
    category: tool.schema
      .enum(CATEGORIES)
      .describe("Note category. Use 'problem' for a solved problem."),
    title: tool.schema
      .string()
      .describe("Short, specific title. For 'problem', describe the symptom."),
    content: tool.schema
      .string()
      .describe(
        "Content written for someone who did not see the conversation. If category=problem: " +
          "Symptom: ... | Cause: <root> | Solution: <reproducible> | Files: ...",
      ),
    tags: tool.schema
      .string()
      .optional()
      .describe("Space-separated keywords, without '#' (e.g. 'selinux module')."),
  },
  async execute(args) {
    const category = args.category;
    const content = args.content ?? "";
    const tags = args.tags ?? "";

    if (category === "problem") {
      const missing = missingProblemSections(content);
      if (missing.length > 0) {
        return {
          title: "notes_add: refused (incomplete #problem note)",
          output:
            `❌ Note NOT saved. Missing from content: ${missing.join(", ")}.\n\n` +
            "The convention requires a root cause and a reproducible solution, not a restated symptom.\n" +
            "Rewrite the content in this format and call again:\n" +
            "Symptom: <what was observed / error message> | " +
            "Cause: <root cause> | Solution: <exact command or steps> | " +
            "Files: <paths touched, optional>",
          metadata: { rejected: true, missing },
        };
      }
    }

    if (!args.title.trim()) {
      return { title: "notes_add: refused", output: "❌ empty title." };
    }

    const run = await runNb(["add", `#${category}`, args.title, tags, content]);
    return {
      title: `notes_add: ${category} — ${args.title}`,
      output: render(run),
      metadata: { category, exit: run.code },
    };
  },
});

export const update = tool({
  description:
    "LAST RESORT: correct an existing note whose content is now known to be wrong " +
    "or conflicts with verified information. Do NOT use it to append new facts, " +
    "reword for style, or erase history — save a new note instead. Only the fields " +
    "you pass change; the timestamp is set to now, so the corrected note moves to " +
    "the top. If the resulting note is category=problem, it still needs " +
    "Symptom, Cause and Solution.",
  args: {
    id: tool.schema
      .number()
      .int()
      .positive()
      .describe("Note id, shown in [...] by notes_search / notes_list."),
    title: tool.schema
      .string()
      .optional()
      .describe("New title, only if the current one is wrong."),
    content: tool.schema
      .string()
      .optional()
      .describe("New content that replaces the wrong content."),
    tags: tool.schema
      .string()
      .optional()
      .describe("New space-separated keywords (empty string clears them)."),
    category: tool.schema
      .enum(CATEGORIES)
      .optional()
      .describe("New category, only if the note was filed wrongly."),
  },
  async execute(args) {
    if (
      args.title === undefined &&
      args.content === undefined &&
      args.tags === undefined &&
      args.category === undefined
    ) {
      return {
        title: "notes_update: refused",
        output:
          "❌ Nothing to update. Pass at least one of title/content/tags/category.\n" +
          "If the goal is to record new information, use notes_add instead.",
        metadata: { rejected: true },
      };
    }

    if (args.title !== undefined && !args.title.trim()) {
      return { title: "notes_update: refused", output: "❌ empty title." };
    }
    if (args.content !== undefined && !args.content.trim()) {
      return { title: "notes_update: refused", output: "❌ empty content." };
    }
    if (args.category === "problem" && args.content !== undefined) {
      const missing = missingProblemSections(args.content);
      if (missing.length > 0) {
        return {
          title: "notes_update: refused (incomplete #problem note)",
          output:
            `❌ Note NOT updated. Missing from content: ${missing.join(", ")}.\n` +
            "A #problem note needs a root cause and a reproducible solution.\n" +
            "Format: Symptom: ... | Cause: ... | Solution: ... | Files: ... (optional)",
          metadata: { rejected: true, missing },
        };
      }
    }

    const argv = ["update", String(args.id)];
    if (args.title !== undefined) argv.push("--title", args.title);
    if (args.tags !== undefined) argv.push("--tags", args.tags);
    if (args.content !== undefined) argv.push("--content", args.content);
    if (args.category !== undefined) argv.push("--category", `#${args.category}`);

    const run = await runNb(argv);
    return {
      title: `notes_update: ${args.id}`,
      output: render(run),
      metadata: { id: args.id, exit: run.code },
    };
  },
});

export const search = tool({
  description:
    "Search long-term memory. Without 'query', lists the most recent notes. " +
    "Multiple words are combined with OR (matches any). Use BEFORE working on a " +
    "project with history and before saving a new note.",
  args: {
    query: tool.schema
      .string()
      .optional()
      .describe("Search term(s). Omit or leave empty to list the latest notes."),
    limit: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max notes to return (default: 10)."),
  },
  async execute(args) {
    const query = (args.query ?? "").trim();
    const limit = args.limit ?? 10;
    const run = query
      ? await runNb(["search", query, String(limit)])
      : await runNb(["list", String(limit)]);
    return {
      title: query ? `notes_search: ${query}` : "notes_search: latest notes",
      output: render(run),
      metadata: { query, limit, exit: run.code },
    };
  },
});

export const doctor = tool({
  description:
    "Memory subsystem diagnosis: python/sqlite, FTS5 availability (full-text " +
    "search; when absent the CLI degrades to LIKE), database schema path and " +
    "version, note count and index sync. Use when a search/save fails or to " +
    "check whether the machine is ready.",
  args: {},
  async execute() {
    const run = await runNb(["doctor"]);
    return {
      title: "notes_doctor",
      output: render(run),
      metadata: { exit: run.code },
    };
  },
});

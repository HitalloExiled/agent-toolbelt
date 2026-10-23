import { describe, expect, test } from "bun:test";

import { extractNarrative, extractSearchText, formatMessage, formatTimeline } from "../history.js";
import type { MessageLike } from "../types.js";

const userMsg: MessageLike = { type: "user", id: "u1", text: "hello world", time: { created: 1000 } };

const assistantMsg: MessageLike = {
  type: "assistant",
  id: "a1",
  time: { created: 2000 },
  content: [
    { type: "text", text: "answer text" },
    { type: "reasoning", text: "secret thoughts" },
    { type: "tool", name: "shell", state: { status: "completed", title: "run x", input: { cmd: "ls" }, output: "out" } },
  ],
};

const compactionMsg: MessageLike = {
  type: "compaction",
  id: "c1",
  status: "completed",
  summary: "## Objective\n- x",
  time: { created: 3000 },
};

describe("extractNarrative", () => {
  test("indexes user text, assistant text and completed summaries only", () => {
    expect(extractNarrative(userMsg)?.kind).toBe("user");
    const assistant = extractNarrative(assistantMsg);
    expect(assistant?.kind).toBe("assistant");
    expect(assistant?.text).toBe("answer text"); // no reasoning, no tool payload
    expect(extractNarrative(compactionMsg)?.kind).toBe("summary");
  });

  test("excludes pending compactions and tool-only messages", () => {
    expect(extractNarrative({ ...compactionMsg, status: "pending", summary: "" })).toBeUndefined();
    expect(extractNarrative({ type: "assistant", id: "a2", content: [] })).toBeUndefined();
  });
});

describe("extractSearchText", () => {
  test("excludes reasoning and tool payloads by default", () => {
    const text = extractSearchText(assistantMsg);
    expect(text).toContain("answer text");
    expect(text).not.toContain("secret thoughts");
    expect(text).not.toContain("cmd");
  });

  test("includes them only when opted in", () => {
    const text = extractSearchText(assistantMsg, { includeTools: true, includeReasoning: true });
    expect(text).toContain("secret thoughts");
    expect(text).toContain("[tool: shell]");
  });
});

describe("formatMessage", () => {
  test("hides tools and reasoning by default", () => {
    const text = formatMessage(assistantMsg);
    expect(text).toContain("answer text");
    expect(text).not.toContain("[tool:");
    expect(text).not.toContain("secret thoughts");
  });

  test("shows them when opted in", () => {
    const text = formatMessage(assistantMsg, { includeTools: true, includeReasoning: true });
    expect(text).toContain("[tool: shell]");
    expect(text).toContain("secret thoughts");
  });

  test("compaction summaries are clipped", () => {
    const long: MessageLike = { type: "compaction", id: "c2", status: "completed", summary: "s".repeat(20_000), time: { created: 1 } };
    expect(formatMessage(long)).toContain("truncated");
  });
});

describe("formatTimeline", () => {
  test("truncates with a marker", () => {
    const big: MessageLike = { type: "user", id: "big", text: "z".repeat(50_000), time: { created: 1 } };
    const out = formatTimeline([big], { maxTotal: 1000 });
    expect(out).toContain("timeline truncated");
  });
});

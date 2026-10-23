import { describe, expect, test } from "bun:test";

import { clip, fmtDate, normalizeWhitespace, safeFilename, snippet, timeMs, tokenize } from "../util.js";

describe("tokenize", () => {
  test("lowercases, dedupes and drops one-character terms", () => {
    expect(tokenize("Hello hello WORLD world a")).toEqual(["hello", "world"]);
  });

  test("keeps unicode letters, digits and underscores", () => {
    expect(tokenize("ação B7 café foo_bar")).toEqual(["ação", "b7", "café", "foo_bar"]);
  });

  test("splits on punctuation and drops short fragments", () => {
    expect(tokenize("foo-bar")).toEqual(["foo", "bar"]);
    expect(tokenize("a-b")).toEqual([]);
  });
});

describe("snippet", () => {
  test("returns the beginning when no term occurs", () => {
    expect(snippet("alpha beta", ["nope"], 5)).toBe("alph…");
  });

  test("windows around a distant occurrence", () => {
    const text = `${"x".repeat(200)}needle${"x".repeat(200)}`;
    const out = snippet(text, ["needle"], 100, 1);
    expect(out).toContain("needle");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  test("merges overlapping occurrences into one window", () => {
    const text = `start needle one needle two ${"y".repeat(100)}`;
    const out = snippet(text, ["needle"], 40, 5);
    expect(out.split("  …  ")).toHaveLength(1);
  });

  test("caps the number of windows", () => {
    // "x" filler: whitespace padding would be collapsed before windowing.
    const text = ["zero needle", "one needle", "two needle", "three needle"]
      .map((part) => part + "x".repeat(80))
      .join("");
    const out = snippet(text, ["needle"], 20, 2);
    expect(out.split("  …  ")).toHaveLength(2);
  });

  test("normalizes whitespace before windowing", () => {
    expect(snippet("a\r\nb   c", ["c"], 100)).toBe("a\nb c");
  });
});

describe("safeFilename", () => {
  test("strips path separators (no traversal)", () => {
    const safe = safeFilename("../../evil dir/../x", "fallback");
    expect(safe).not.toContain("/");
    expect(safe).not.toBe("..");
    expect(safe).not.toBe(".");
  });

  test("keeps the allowed characters and falls back", () => {
    expect(safeFilename("a.b_c-d 192k")).toBe("a.b_c-d_192k");
    expect(safeFilename("///", "fallback")).toBe("fallback");
  });
});

describe("timeMs and fmtDate", () => {
  test("accepts milliseconds, seconds and ISO strings", () => {
    expect(timeMs(1e13)).toBe(1e13);
    expect(timeMs(1700000000)).toBe(1700000000 * 1000);
    expect(timeMs("2026-10-22T12:00:00Z")).toBe(Date.parse("2026-10-22T12:00:00Z"));
    expect(timeMs(undefined)).toBe(0);
    expect(timeMs("garbage")).toBe(0);
  });

  test("formats zero as unknown", () => {
    expect(fmtDate(0)).toBe("unknown");
    expect(fmtDate(Date.parse("2026-10-22T12:34:56Z"))).toBe("2026-10-22 12:34Z");
  });
});

describe("clip and normalizeWhitespace", () => {
  test("clips with the note and passes short text through", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("ab", 4)).toBe("ab");
  });

  test("collapses whitespace runs", () => {
    expect(normalizeWhitespace("a\r\nb\t\tc\n\n\nd")).toBe("a\nb c\n\nd");
  });
});

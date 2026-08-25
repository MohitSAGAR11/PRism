import { describe, expect, it } from "vitest";
import {
  changedLineCount,
  normalizedLineContent,
  parseFile,
  parsePatch,
  renderHunksForPrompt,
} from "../src/github/diff.js";

const NO_NEWLINE = String.raw`\ No newline at end of file`;

const file = (patch: string, over: Partial<{ filename: string; status: string }> = {}) =>
  parseFile({ filename: over.filename ?? "src/a.ts", status: over.status ?? "modified", patch });

describe("parsePatch", () => {
  it("maps added lines to head-revision line numbers", () => {
    const hunks = parsePatch(
      ["@@ -1,3 +1,5 @@", " one", " two", "+inserted a", "+inserted b", " three"].join("\n"),
    );
    expect(hunks).toHaveLength(1);
    const added = hunks[0]!.lines.filter((l) => l.kind === "add");
    expect(added.map((l) => l.newLine)).toEqual([3, 4]);
    expect(added.map((l) => l.content)).toEqual(["inserted a", "inserted b"]);
    // The trailing context line shifts down by the two insertions.
    expect(hunks[0]!.lines.at(-1)).toMatchObject({ kind: "context", newLine: 5, oldLine: 3 });
  });

  it("advances only the old counter across deletions", () => {
    const hunks = parsePatch(["@@ -1,4 +1,2 @@", " keep", "-gone a", "-gone b", " tail"].join("\n"));
    const lines = hunks[0]!.lines;
    expect(lines[1]).toMatchObject({ kind: "del", oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ kind: "del", oldLine: 3, newLine: null });
    // "tail" was line 4 in the base and is line 2 in the head.
    expect(lines[3]).toMatchObject({ kind: "context", oldLine: 4, newLine: 2 });
  });

  it("treats a missing count in the hunk header as one line", () => {
    const hunks = parsePatch(["@@ -5 +5 @@", "-old", "+new"].join("\n"));
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
    expect(hunks[0]!.lines[1]).toMatchObject({ kind: "add", newLine: 5 });
  });

  it("does not let the no-newline marker advance line numbers", () => {
    const hunks = parsePatch(
      ["@@ -1,2 +1,2 @@", " first", "-last", NO_NEWLINE, "+last!", NO_NEWLINE].join("\n"),
    );
    const add = hunks[0]!.lines.find((l) => l.kind === "add");
    expect(add).toMatchObject({ newLine: 2, content: "last!" });
    expect(hunks[0]!.lines.some((l) => l.content.startsWith(" No newline"))).toBe(false);
  });

  it("treats a whitespace-stripped blank line as empty context", () => {
    const hunks = parsePatch(["@@ -1,3 +1,4 @@", " a", "", "+b", " c"].join("\n"));
    const lines = hunks[0]!.lines;
    expect(lines[1]).toMatchObject({ kind: "context", content: "", oldLine: 2, newLine: 2 });
    expect(lines[2]).toMatchObject({ kind: "add", newLine: 3 });
  });

  it("tracks line numbers independently across multiple hunks", () => {
    const hunks = parsePatch(
      ["@@ -1,2 +1,3 @@", " a", "+b", " c", "@@ -20,2 +21,3 @@", " x", "+y", " z"].join("\n"),
    );
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.find((l) => l.kind === "add")!.newLine).toBe(2);
    expect(hunks[1]!.lines.find((l) => l.kind === "add")!.newLine).toBe(22);
  });

  it("ignores git preamble lines outside any hunk", () => {
    const hunks = parsePatch(
      ["diff --git a/x b/x", "index 111..222 100644", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+only"].join("\n"),
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toHaveLength(1);
  });

  it("returns nothing for a missing patch", () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch(null)).toEqual([]);
    expect(parsePatch("")).toEqual([]);
  });
});

describe("parseFile", () => {
  it("marks added and context lines commentable but never deleted ones", () => {
    const parsed = file(["@@ -1,3 +1,3 @@", " keep", "-gone", "+fresh", " tail"].join("\n"));
    expect([...parsed.commentableLines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...parsed.addedLines]).toEqual([2]);
  });

  it("carries the previous path for a rename", () => {
    const parsed = parseFile({
      filename: "src/new.ts",
      status: "renamed",
      previous_filename: "src/old.ts",
      patch: "@@ -1 +1 @@\n+x",
    });
    expect(parsed.previousPath).toBe("src/old.ts");
    expect(parsed.status).toBe("renamed");
  });

  it("yields an empty commentable set for a binary file with no patch", () => {
    const parsed = parseFile({ filename: "logo.png", status: "modified" });
    expect(parsed.commentableLines.size).toBe(0);
    expect(renderHunksForPrompt(parsed)).toContain("no textual diff");
  });
});

describe("renderHunksForPrompt", () => {
  it("prefixes each row with the head-revision line number", () => {
    const parsed = file(["@@ -1,2 +1,3 @@", " a", "+b", " c"].join("\n"));
    const rendered = renderHunksForPrompt(parsed).split("\n");
    expect(rendered[0]).toBe("@@ -1,2 +1,3 @@");
    expect(rendered[1]).toBe("    1   a");
    expect(rendered[2]).toBe("    2 + b");
    expect(rendered[3]).toBe("    3   c");
  });

  it("leaves the number column blank for deletions", () => {
    const parsed = file(["@@ -1,2 +1,1 @@", " a", "-b"].join("\n"));
    const rendered = renderHunksForPrompt(parsed).split("\n");
    expect(rendered[2]).toBe("      - b");
  });
});

describe("helpers", () => {
  it("normalizes whitespace when fingerprinting a line", () => {
    const parsed = file(["@@ -1 +1,2 @@", " a", "+    const   x =  1;   "].join("\n"));
    expect(normalizedLineContent(parsed, 2)).toBe("const x = 1;");
    expect(normalizedLineContent(parsed, 999)).toBe("");
  });

  it("counts only changed lines", () => {
    const parsed = file(["@@ -1,4 +1,4 @@", " a", "+b", "-c", " d"].join("\n"));
    expect(changedLineCount(parsed)).toBe(2);
  });
});

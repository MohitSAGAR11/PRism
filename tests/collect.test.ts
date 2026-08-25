import { describe, expect, it } from "vitest";
import {
  groupFiles,
  renderFileContext,
  shrinkContext,
  type FileContext,
} from "../src/context/collect.js";
import { parseFile, renderHunksForPrompt } from "../src/github/diff.js";
import { numberLines } from "../src/github/pr.js";
import { mapPool } from "../src/util/pool.js";

const PATCH = ["@@ -1,2 +1,3 @@", " const a = 1;", "+const b = 2;", " use(a);"].join("\n");

function ctx(path: string, tokens: number, withBody = true): FileContext {
  const file = parseFile({ filename: path, status: "modified", patch: PATCH });
  return {
    file,
    numberedContent: withBody ? numberLines("const a = 1;\nconst b = 2;\nuse(a);") : null,
    renderedDiff: renderHunksForPrompt(file),
    tokens,
  };
}

describe("groupFiles", () => {
  it("packs small files into one request", () => {
    const groups = groupFiles([ctx("src/a.ts", 100), ctx("src/b.ts", 100)], 1000);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contexts).toHaveLength(2);
    expect(groups[0]!.tokens).toBe(200);
  });

  it("opens a new group once the budget is reached", () => {
    const groups = groupFiles(
      [ctx("src/a.ts", 600), ctx("src/b.ts", 600), ctx("src/c.ts", 600)],
      1000,
    );
    expect(groups).toHaveLength(3);
  });

  it("keeps a directory together when it fits", () => {
    const groups = groupFiles(
      [
        ctx("api/one.ts", 100),
        ctx("web/one.ts", 100),
        ctx("api/two.ts", 100),
        ctx("web/two.ts", 100),
      ],
      250,
    );
    // Directories are packed in order, so each group holds one directory.
    const dirs = groups.map((g) => [
      ...new Set(g.contexts.map((c) => c.file.path.split("/")[0])),
    ]);
    expect(dirs).toEqual([["api"], ["web"]]);
  });

  it("gives an oversized file its own group rather than dropping it", () => {
    const groups = groupFiles(
      [ctx("src/a.ts", 50), ctx("src/huge.ts", 5000), ctx("src/b.ts", 50)],
      1000,
    );
    const huge = groups.find((g) => g.contexts.some((c) => c.file.path === "src/huge.ts"));
    expect(huge).toBeDefined();
    expect(huge!.contexts).toHaveLength(1);
    // Nothing is lost in the process.
    const paths = groups.flatMap((g) => g.contexts.map((c) => c.file.path)).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts", "src/huge.ts"]);
  });

  it("returns nothing for no input", () => {
    expect(groupFiles([], 1000)).toEqual([]);
  });
});

describe("renderFileContext", () => {
  it("includes the diff, the numbered body, and the line-citation instruction", () => {
    const rendered = renderFileContext(ctx("src/a.ts", 100));
    expect(rendered).toContain('<file path="src/a.ts"');
    expect(rendered).toContain("```diff");
    expect(rendered).toContain("head revision");
    expect(rendered).toContain("Full file at head");
  });

  it("says so plainly when the body is unavailable", () => {
    const rendered = renderFileContext(ctx("src/a.ts", 100, false));
    expect(rendered).toContain("full file unavailable");
    expect(rendered).not.toContain("Full file at head");
  });
});

describe("shrinkContext", () => {
  it("drops the body and recounts, keeping the diff", () => {
    const original = ctx("src/a.ts", 9999);
    const shrunk = shrinkContext(original);
    expect(shrunk.numberedContent).toBeNull();
    expect(shrunk.renderedDiff).toBe(original.renderedDiff);
    expect(shrunk.tokens).toBeLessThan(original.tokens);
    expect(shrunk.tokens).toBeGreaterThan(0);
  });
});

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapPool([30, 10, 20, 1], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 1]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("handles an empty list", async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});

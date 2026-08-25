import { describe, expect, it } from "vitest";
import { parseFile } from "../src/github/diff.js";
import {
  extensionOf,
  globToRegExp,
  matchesAny,
  partitionFiles,
  shouldSkip,
} from "../src/context/filters.js";

const mk = (filename: string, status = "modified", patch = "@@ -1 +1,2 @@\n a\n+b") =>
  parseFile({ filename, status, patch });

describe("globToRegExp", () => {
  it("matches a single segment with *", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/a.ts")).toBe(false);
  });

  it("lets **/ span zero or more segments", () => {
    const re = globToRegExp("**/dist/**");
    expect(re.test("dist/a.js")).toBe(true);
    expect(re.test("packages/web/dist/a.js")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    const re = globToRegExp("a+b(c).ts");
    expect(re.test("a+b(c).ts")).toBe(true);
    expect(re.test("aXbXcX.ts")).toBe(false);
  });

  it("matches exactly one character with ?", () => {
    const re = globToRegExp("v?.ts");
    expect(re.test("v1.ts")).toBe(true);
    expect(re.test("v12.ts")).toBe(false);
  });

  it("anchors the whole path", () => {
    expect(globToRegExp("src/a.ts").test("other/src/a.ts")).toBe(false);
  });
});

describe("extensionOf", () => {
  it("reads the last extension", () => {
    expect(extensionOf("a/b/c.test.ts")).toBe("ts");
    expect(extensionOf("Makefile")).toBe("");
    // A dotfile has no extension, it has a name.
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("shouldSkip", () => {
  it("reviews ordinary source", () => {
    expect(shouldSkip(mk("src/app.ts"), []).skip).toBe(false);
  });

  it("skips deleted files", () => {
    expect(shouldSkip(mk("src/app.ts", "removed"), [])).toMatchObject({
      skip: true,
      reason: "file deleted",
    });
  });

  it("skips files with no textual diff", () => {
    const parsed = parseFile({ filename: "src/app.ts", status: "modified" });
    expect(shouldSkip(parsed, [])).toMatchObject({ skip: true, reason: "no textual diff" });
  });

  it("skips binaries by extension", () => {
    expect(shouldSkip(mk("assets/logo.png"), [])).toMatchObject({ skip: true, reason: "binary" });
  });

  it("skips lockfiles and generated output", () => {
    for (const path of [
      "package-lock.json",
      "pnpm-lock.yaml",
      "dist/bundle.js",
      "node_modules/x/index.js",
      "api/service.pb.go",
      "src/types.generated.ts",
    ]) {
      expect(shouldSkip(mk(path), []).skip, path).toBe(true);
    }
  });

  it("honours a configured ignore list", () => {
    expect(shouldSkip(mk("docs/guide.md"), ["docs/**"])).toMatchObject({
      skip: true,
      reason: "matched paths_ignore",
    });
    expect(shouldSkip(mk("docs/guide.md"), []).skip).toBe(false);
  });
});

describe("partitionFiles", () => {
  it("splits reviewable from skipped and records a reason for each", () => {
    const { review, skipped } = partitionFiles(
      [mk("src/app.ts"), mk("yarn.lock"), mk("img.png"), mk("src/util.ts")],
      [],
    );
    expect(review.map((f) => f.path)).toEqual(["src/app.ts", "src/util.ts"]);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.reason.length > 0)).toBe(true);
  });
});

describe("matchesAny", () => {
  it("is false for an empty glob list", () => {
    expect(matchesAny("src/a.ts", [])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseFileConfig, resolveConfig, type Config } from "../src/config.js";
import { parseFile } from "../src/github/diff.js";
import {
  clampConfidence,
  extractFingerprints,
  fingerprint,
  fingerprintMarker,
  meetsBar,
  rankFindings,
  type Finding,
  type ReviewedFinding,
} from "../src/review/schema.js";
import { renderSummary, splitFindings, SUMMARY_MARKER } from "../src/review/render.js";

const PATCH = ["@@ -1,4 +1,6 @@", " const a = 1;", "+const b = 2;", "+const c = 3;", " use(a);"].join(
  "\n",
);

const parsed = parseFile({ filename: "src/app.ts", status: "modified", patch: PATCH });
const filesByPath = new Map([[parsed.path, parsed]]);

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 2,
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: "Off-by-one in the loop bound",
    body: "The loop reads one past the end.",
    failure_scenario: "items=[1] reads items[1], which is undefined.",
    suggested_patch: null,
    ...over,
  };
}

function reviewed(over: Partial<Finding> = {}): ReviewedFinding {
  const f = makeFinding(over);
  return { ...f, fingerprint: fingerprint(f, parsed) };
}

const cfg: Config = { ...DEFAULT_CONFIG };

describe("config", () => {
  it("falls back to defaults for an empty file", () => {
    expect(resolveConfig(parseFileConfig(""))).toEqual(DEFAULT_CONFIG);
  });

  it("defaults the verify model to the find model", () => {
    const resolved = resolveConfig(parseFileConfig("model: stealth/ox-alpha"));
    expect(resolved.model).toBe("stealth/ox-alpha");
    expect(resolved.verifyModel).toBe("stealth/ox-alpha");
  });

  it("keeps an explicit verify model distinct", () => {
    const resolved = resolveConfig(
      parseFileConfig("model: stealth/ox-alpha\nverify_model: poolside/laguna-s-2.1:free"),
    );
    expect(resolved.verifyModel).toBe("poolside/laguna-s-2.1:free");
  });

  it("lets action inputs win over the repo file", () => {
    const resolved = resolveConfig(parseFileConfig("severity_threshold: low"), {
      severityThreshold: "critical",
    });
    expect(resolved.severityThreshold).toBe("critical");
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(() => parseFileConfig("sevrity_threshold: low")).toThrow();
  });

  it("rejects an out-of-range confidence", () => {
    expect(() => parseFileConfig("min_confidence: 1.5")).toThrow();
  });
});

describe("fingerprints", () => {
  it("is stable for the same finding", () => {
    expect(fingerprint(makeFinding(), parsed)).toBe(fingerprint(makeFinding(), parsed));
  });

  it("ignores the line number, so inserting code above does not resurrect it", () => {
    // Same cited code, different line number -> same identity.
    const shifted = parseFile({
      filename: "src/app.ts",
      status: "modified",
      patch: ["@@ -1,4 +1,8 @@", " const a = 1;", "+pad();", "+pad();", "+const b = 2;", " use(a);"].join("\n"),
    });
    const a = fingerprint(makeFinding({ line: 2 }), parsed);
    const b = fingerprint(makeFinding({ line: 4 }), shifted);
    expect(b).toBe(a);
  });

  it("changes when the cited line is edited", () => {
    const edited = parseFile({
      filename: "src/app.ts",
      status: "modified",
      patch: ["@@ -1,4 +1,6 @@", " const a = 1;", "+const b = 99;", " use(a);"].join("\n"),
    });
    expect(fingerprint(makeFinding(), edited)).not.toBe(fingerprint(makeFinding(), parsed));
  });

  it("round-trips through a hidden marker", () => {
    const fp = fingerprint(makeFinding(), parsed);
    expect(extractFingerprints("text " + fingerprintMarker(fp) + " more")).toEqual([fp]);
  });

  it("finds every marker in a ledger", () => {
    const body = ["a", fingerprintMarker("0".repeat(16)), fingerprintMarker("1".repeat(16))].join("\n");
    expect(extractFingerprints(body)).toHaveLength(2);
  });
});

describe("meetsBar", () => {
  const opts = { severityThreshold: "medium" as const, minConfidence: 0.7, focus: [] };

  it("drops findings below the severity threshold", () => {
    expect(meetsBar(makeFinding({ severity: "low" }), opts)).toBe(false);
    expect(meetsBar(makeFinding({ severity: "medium" }), opts)).toBe(true);
  });

  it("drops findings below the confidence floor", () => {
    expect(meetsBar(makeFinding({ confidence: 0.5 }), opts)).toBe(false);
  });

  it("clamps a nonsensical confidence instead of trusting it", () => {
    expect(clampConfidence(4)).toBe(1);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
  });
});

describe("rankFindings", () => {
  it("puts the most severe first", () => {
    const ranked = rankFindings([
      makeFinding({ severity: "low", title: "l" }),
      makeFinding({ severity: "critical", title: "c" }),
      makeFinding({ severity: "medium", title: "m" }),
    ]);
    expect(ranked.map((f) => f.severity)).toEqual(["critical", "medium", "low"]);
  });
});

describe("splitFindings", () => {
  it("anchors a finding on an added line", () => {
    const result = splitFindings({
      findings: [reviewed({ line: 2 })],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]).toMatchObject({ path: "src/app.ts", line: 2, side: "RIGHT" });
  });

  it("demotes a finding on a line outside the diff instead of risking a 422", () => {
    const result = splitFindings({
      findings: [reviewed({ line: 500 })],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(result.inline).toHaveLength(0);
    expect(result.summaryOnly).toHaveLength(1);
  });

  it("suppresses a finding already posted on an earlier push", () => {
    const f = reviewed();
    const result = splitFindings({
      findings: [f],
      filesByPath,
      cfg,
      alreadyPosted: new Set([f.fingerprint]),
    });
    expect(result.inline).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it("collapses two identical findings from different groups", () => {
    const result = splitFindings({
      findings: [reviewed(), reviewed()],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(result.inline).toHaveLength(1);
  });

  it("routes overflow past the inline cap into the summary", () => {
    const findings = [1, 2, 3].map((n) =>
      reviewed({ line: 2, title: "finding " + String(n) }),
    );
    const result = splitFindings({
      findings,
      filesByPath,
      cfg: { ...cfg, maxInlineComments: 2 },
      alreadyPosted: new Set(),
    });
    expect(result.inline).toHaveLength(2);
    expect(result.summaryOnly).toHaveLength(1);
  });

  it("separates below-bar findings from reportable ones", () => {
    const result = splitFindings({
      findings: [reviewed({ severity: "low", title: "nit" }), reviewed()],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(result.inline).toHaveLength(1);
    expect(result.belowBar).toHaveLength(1);
  });

  it("emits a suggestion block only when a patch is offered", () => {
    const withPatch = splitFindings({
      findings: [reviewed({ suggested_patch: "const b = 2; // fixed" })],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(withPatch.inline[0]!.body).toContain("```suggestion");

    const without = splitFindings({
      findings: [reviewed()],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    expect(without.inline[0]!.body).not.toContain("```suggestion");
  });
});

describe("renderSummary", () => {
  const base = {
    refuted: [],
    skipped: [],
    failures: [],
    usage: { promptTokens: 1000, completionTokens: 200, cachedTokens: 900, cost: 0.0123 },
    models: ["stealth/ox-alpha"],
    headSha: "a".repeat(40),
    filesReviewed: 2,
    knownFingerprints: [],
  };

  it("carries the marker and head sha so the next run can find it", () => {
    const summary = renderSummary({
      ...base,
      split: { inline: [], summaryOnly: [], belowBar: [], duplicates: [] },
    });
    expect(summary).toContain(SUMMARY_MARKER);
    expect(summary).toContain("ai-review:sha=" + "a".repeat(40));
    expect(summary).toContain("No blocking issues found");
  });

  it("writes the fingerprint ledger so summary-only findings dedupe next push", () => {
    const f = reviewed({ line: 500 });
    const split = splitFindings({
      findings: [f],
      filesByPath,
      cfg,
      alreadyPosted: new Set(),
    });
    const summary = renderSummary({ ...base, split, knownFingerprints: [f.fingerprint] });
    expect(extractFingerprints(summary)).toContain(f.fingerprint);
  });

  it("reports cost and the model that actually served the request", () => {
    const summary = renderSummary({
      ...base,
      split: { inline: [], summaryOnly: [], belowBar: [], duplicates: [] },
    });
    expect(summary).toContain("$0.0123");
    expect(summary).toContain("900 cached");
    expect(summary).toContain("stealth/ox-alpha");
  });

  it("names files it did not review rather than staying silent", () => {
    const summary = renderSummary({
      ...base,
      split: { inline: [], summaryOnly: [], belowBar: [], duplicates: [] },
      skipped: [{ path: "yarn.lock", reason: "generated or vendored" }],
    });
    expect(summary).toContain("yarn.lock");
    expect(summary).toContain("generated or vendored");
  });
});

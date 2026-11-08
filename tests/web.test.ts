import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "../src/server/types.js";
import { parseSseChunk } from "../web/src/api.js";
import { looksLikePullUrl } from "../web/src/format.js";
import { IDLE, letterFor, letterMap, reduce, type ReviewState } from "../web/src/review-state.js";

describe("parseSseChunk", () => {
  it("parses complete frames and keeps the partial tail", () => {
    const a: ReviewEvent = { type: "files", reviewable: 2, skipped: 0 };
    const text = `event: files\ndata: ${JSON.stringify(a)}\n\n: ping\n\nevent: analyzing\ndata: {"type":"analy`;
    const { events, rest } = parseSseChunk(text);
    expect(events).toEqual([a]);
    expect(rest).toBe('event: analyzing\ndata: {"type":"analy');
  });

  it("tolerates CRLF framing and skips malformed frames", () => {
    const { events } = parseSseChunk('data: {"type":"verified","survived":1,"refuted":0}\r\n\r\ndata: {nope\r\n\r\n');
    expect(events).toEqual([{ type: "verified", survived: 1, refuted: 0 }]);
  });
});

describe("review reducer", () => {
  const cand = { id: "f1", file: "a.ts", line: 3, title: "t", severity: "high" as const, category: "bug" as const };

  function play(events: ReviewEvent[]): ReviewState {
    let s = reduce(IDLE, { type: "start", url: "https://github.com/o/r/pull/1", now: 1000 });
    for (const [i, e] of events.entries()) s = reduce(s, { type: "event", event: e, now: 1000 + (i + 1) * 100 });
    return s;
  }

  it("tracks candidates from pending to their verdicts without mutating state", () => {
    const before = play([{ type: "candidates", count: 1, findings: [cand] }]);
    const after = reduce(before, {
      type: "event",
      event: { type: "verdict", id: "f1", refuted: true, reason: "guarded", done: 1, total: 1 },
      now: 2000,
    });
    expect(before.candidates?.[0]?.status).toBe("pending");
    expect(after.candidates?.[0]).toMatchObject({ status: "refuted", reason: "guarded" });
    expect(after.verdicts).toBe(1);
  });

  it("records stage timings relative to the start", () => {
    const s = play([{ type: "accepted", cached: false, key: "k" }, { type: "analyzing", groups: 2 }]);
    expect(s.stages.map((x) => [x.key, x.at])).toEqual([
      ["accepted", 100],
      ["analyzing", 200],
    ]);
  });

  it("moves to error on an error event and keeps the message", () => {
    const s = play([{ type: "error", code: "timeout", message: "too slow" }]);
    expect(s.phase).toBe("error");
    expect(s.error).toEqual({ code: "timeout", message: "too slow" });
  });
});

describe("letters", () => {
  it("letters left to right by file then line, like a spectral plate", () => {
    const m = letterMap([
      { id: "x", file: "b.ts", line: 1 },
      { id: "y", file: "a.ts", line: 9 },
      { id: "z", file: "a.ts", line: 2 },
    ]);
    expect([m.get("z"), m.get("y"), m.get("x")]).toEqual(["A", "B", "C"]);
  });

  it("continues past Z", () => {
    expect([letterFor(25), letterFor(26), letterFor(27)]).toEqual(["Z", "AA", "AB"]);
  });
});

describe("looksLikePullUrl (client mirror)", () => {
  it("agrees with the server on the common shapes", () => {
    expect(looksLikePullUrl("https://github.com/o/r/pull/1")).toBe(true);
    expect(looksLikePullUrl("github.com/o/r/pull/1/files")).toBe(true);
    expect(looksLikePullUrl("https://github.com/o/r/issues/1")).toBe(false);
    expect(looksLikePullUrl("https://gitlab.com/o/r/pull/1")).toBe(false);
  });
});

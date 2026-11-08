import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebReviewResult } from "./types.js";
import { cacheKey } from "./validate.js";

export interface SampleDef {
  url: string;
  label: string;
  blurb: string;
}

/**
 * Example pull requests offered as one-click buttons. Their reviews are
 * pre-computed by `npm run seed:samples` and shipped in `samples/`, so a
 * visitor sees real output instantly and the demo pays nothing for it.
 */
export const SAMPLES: SampleDef[] = [
  {
    url: "https://github.com/expressjs/express/pull/7584",
    label: "expressjs/express #7584",
    blurb: "res.send() and non-Uint8Array typed arrays",
  },
  {
    url: "https://github.com/chalk/chalk/pull/681",
    label: "chalk/chalk #681",
    blurb: "Validate non-numeric level options",
  },
  {
    url: "https://github.com/sindresorhus/ky/pull/868",
    label: "sindresorhus/ky #868",
    blurb: "Validate retry.afterStatusCodes is an array",
  },
];

function looksLikeResult(value: unknown): value is WebReviewResult {
  const v = value as Partial<WebReviewResult> | null;
  return (
    !!v &&
    v.version === 1 &&
    typeof v.pr?.headSha === "string" &&
    typeof v.pr.owner === "string" &&
    Array.isArray(v.findings)
  );
}

/** Read every pre-computed review in `dir`. A bad file is skipped, not fatal. */
export function loadSampleResults(
  dir: string,
  warn: (message: string) => void = () => {},
): Map<string, WebReviewResult> {
  const out = new Map<string, WebReviewResult>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!looksLikeResult(parsed)) {
        warn(`skipping ${name}: not a review result`);
        continue;
      }
      const key = cacheKey(
        { owner: parsed.pr.owner, repo: parsed.pr.repo, pull: parsed.pr.number },
        parsed.pr.headSha,
      );
      out.set(key, parsed);
    } catch (err) {
      warn(`skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** `owner/repo#N` for a sample, lowercased the way cache keys are. */
export function sampleRef(url: string): string | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]}` : null;
}

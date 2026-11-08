/**
 * Input validation for the web demo. Everything a visitor sends is checked
 * here, before any network call.
 */

export interface PullTarget {
  owner: string;
  repo: string;
  pull: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** GitHub's own rules: alphanumerics and single hyphens, max 39, no edge hyphen. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repo names: letters, digits, `.`, `_`, `-`; never `.` or `..`. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** Anything after `/pull/N` that the GitHub UI itself produces. */
const PULL_SUFFIX = /^(?:\/(?:files|commits|checks|changes))?\/?$/;

const MAX_URL_LENGTH = 300;
const MAX_PULL = 10_000_000;

const EXPECTED = "Expected a pull request URL like https://github.com/owner/repo/pull/123";

/**
 * Parse a public GitHub pull request URL, strictly.
 *
 * Accepts only github.com (optionally `www.`), over https or with no scheme,
 * and the `/owner/repo/pull/N` shape. Query strings and fragments are
 * tolerated and dropped. Everything else is rejected, including other hosts,
 * credentials in the URL, ports, and `/issues/N`.
 */
export function parsePullUrl(input: unknown): Parsed<PullTarget> {
  if (typeof input !== "string") return { ok: false, message: EXPECTED };
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return { ok: false, message: EXPECTED };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: EXPECTED };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: EXPECTED };
  if (url.username || url.password || url.port) return { ok: false, message: EXPECTED };
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { ok: false, message: "Only github.com pull requests are supported." };
  }

  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(.*)$/.exec(url.pathname);
  if (!m) return { ok: false, message: EXPECTED };
  const [, owner, repo, num, rest] = m as unknown as [string, string, string, string, string];

  if (!OWNER.test(owner)) return { ok: false, message: "That owner name is not valid on GitHub." };
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    return { ok: false, message: "That repository name is not valid on GitHub." };
  }
  if (!PULL_SUFFIX.test(rest)) return { ok: false, message: EXPECTED };

  const pull = Number(num);
  if (!Number.isSafeInteger(pull) || pull < 1 || pull > MAX_PULL) {
    return { ok: false, message: "That pull request number is out of range." };
  }

  return { ok: true, value: { owner, repo, pull } };
}

/**
 * Shape check for a bring-your-own OpenRouter key. This is a format filter,
 * not authentication -- OpenRouter decides whether the key is real.
 */
const OPENROUTER_KEY = /^sk-or-[A-Za-z0-9_-]{16,256}$/;

export function parseOpenRouterKey(input: unknown): Parsed<string | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, message: "The API key must be a string." };
  const key = input.trim();
  if (!key) return { ok: true, value: null };
  if (!OPENROUTER_KEY.test(key)) {
    return { ok: false, message: "That does not look like an OpenRouter key (they start with sk-or-)." };
  }
  return { ok: true, value: key };
}

/** Remove anything shaped like a secret before a message leaves the server. */
export function redactSecrets(message: string): string {
  return message
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "sk-or-[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]");
}

export function cacheKey(t: PullTarget, headSha: string): string {
  return `${t.owner.toLowerCase()}/${t.repo.toLowerCase()}#${t.pull}@${headSha}`;
}

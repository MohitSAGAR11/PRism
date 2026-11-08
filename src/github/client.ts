import { Octokit } from "@octokit/rest";

export interface OctokitOverrides {
  /** Custom fetch, e.g. one bound to a per-request AbortSignal. */
  fetch?: typeof fetch;
  /** Silence Octokit's request logging (it logs every 404 as a warning). */
  quiet?: boolean;
}

/**
 * An empty token gives an unauthenticated client: enough for public repos,
 * at GitHub's much lower anonymous rate limit.
 */
export function createOctokit(token: string, overrides: OctokitOverrides = {}): Octokit {
  const noop = (): void => {};
  return new Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: "pr-reviewer",
    ...(overrides.fetch ? { request: { fetch: overrides.fetch } } : {}),
    ...(overrides.quiet
      ? { log: { debug: noop, info: noop, warn: noop, error: noop } }
      : {}),
  });
}

export type GitHubClient = Octokit;

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse "owner/repo#123", the form the local CLI accepts. */
export function parsePullRef(ref: string): RepoRef & { pull: number } {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref.trim());
  if (!m) {
    throw new Error(`Expected a pull request reference like "owner/repo#123", got "${ref}"`);
  }
  return { owner: m[1]!, repo: m[2]!, pull: Number(m[3]) };
}

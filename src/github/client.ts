import { Octokit } from "@octokit/rest";

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "pr-reviewer" });
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

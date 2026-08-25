import type { GitHubClient, RepoRef } from "./client.js";
import { parseFile, type ParsedFile } from "./diff.js";

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  author: string;
  url: string;
  isFork: boolean;
}

export async function getPullRequest(
  gh: GitHubClient,
  ref: RepoRef,
  pull: number,
): Promise<PullRequestInfo> {
  const { data } = await gh.pulls.get({ ...ref, pull_number: pull });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    baseSha: data.base.sha,
    headSha: data.head.sha,
    author: data.user?.login ?? "unknown",
    url: data.html_url,
    isFork: data.head.repo?.full_name !== `${ref.owner}/${ref.repo}`,
  };
}

export async function listChangedFiles(
  gh: GitHubClient,
  ref: RepoRef,
  pull: number,
): Promise<ParsedFile[]> {
  const files = await gh.paginate(gh.pulls.listFiles, {
    ...ref,
    pull_number: pull,
    per_page: 100,
  });
  return files.map((f) =>
    parseFile({
      filename: f.filename,
      status: f.status,
      patch: f.patch,
      previous_filename: f.previous_filename,
    }),
  );
}

/** Above this, sending the whole file is not worth it; the diff alone will do. */
const MAX_FILE_BYTES = 400_000;

const NUL = String.fromCharCode(0);

/**
 * Fetch a file at a specific ref. Returns null when the path is missing,
 * oversized, or not decodable as text -- all normal outcomes, not errors.
 */
export async function getFileContent(
  gh: GitHubClient,
  ref: RepoRef,
  path: string,
  gitRef: string,
): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ ...ref, path, ref: gitRef });
    if (Array.isArray(data) || data.type !== "file") return null;
    if (data.size > MAX_FILE_BYTES) return null;
    if (!data.content) return null;
    const text = Buffer.from(data.content, "base64").toString("utf8");
    // A NUL byte means we decoded something binary; the diff is more useful.
    return text.includes(NUL) ? null : text;
  } catch {
    return null;
  }
}

/** Number a file body so findings cite the same lines the diff uses. */
export function numberLines(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(5)} | ${line}`)
    .join("\n");
}

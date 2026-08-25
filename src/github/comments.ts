import type { GitHubClient, RepoRef } from "./client.js";
import { extractFingerprints } from "../review/schema.js";
import { SHA_PREFIX, SUMMARY_MARKER, type InlineComment } from "../review/render.js";

export interface PostOptions {
  gh: GitHubClient;
  ref: RepoRef;
  pull: number;
  headSha: string;
  inline: InlineComment[];
  summary: string;
}

/**
 * Fingerprints of findings this bot has already posted, across every push.
 *
 * Read from both the inline review comments and the summary body, because a
 * finding demoted to the summary on one push should not reappear inline on the
 * next just because it moved between the two places.
 */
export async function collectPostedFingerprints(
  gh: GitHubClient,
  ref: RepoRef,
  pull: number,
): Promise<Set<string>> {
  const fingerprints = new Set<string>();

  const reviewComments = await gh.paginate(gh.pulls.listReviewComments, {
    ...ref,
    pull_number: pull,
    per_page: 100,
  });
  for (const c of reviewComments) {
    for (const fp of extractFingerprints(c.body ?? "")) fingerprints.add(fp);
  }

  const issueComments = await gh.paginate(gh.issues.listComments, {
    ...ref,
    issue_number: pull,
    per_page: 100,
  });
  for (const c of issueComments) {
    for (const fp of extractFingerprints(c.body ?? "")) fingerprints.add(fp);
  }

  return fingerprints;
}

/** The bot's own summary comment, if it has posted one before. */
export async function findSummaryComment(
  gh: GitHubClient,
  ref: RepoRef,
  pull: number,
): Promise<{ id: number; body: string } | null> {
  const comments = await gh.paginate(gh.issues.listComments, {
    ...ref,
    issue_number: pull,
    per_page: 100,
  });
  for (const c of [...comments].reverse()) {
    if ((c.body ?? "").includes(SUMMARY_MARKER)) return { id: c.id, body: c.body ?? "" };
  }
  return null;
}

export function lastReviewedSha(summaryBody: string): string | null {
  const m = new RegExp(SHA_PREFIX + "([0-9a-f]{7,40})").exec(summaryBody);
  return m ? m[1]! : null;
}

export interface PostResult {
  inlinePosted: number;
  degraded: boolean;
}

/**
 * Post the review.
 *
 * GitHub rejects the whole review with a 422 if any single comment names a line
 * outside the diff, so a failure here falls back to posting everything as one
 * summary comment. Losing inline placement is much better than losing the
 * review.
 */
export async function postReview(opts: PostOptions): Promise<PostResult> {
  const { gh, ref, pull } = opts;

  if (opts.inline.length > 0) {
    try {
      await gh.pulls.createReview({
        ...ref,
        pull_number: pull,
        commit_id: opts.headSha,
        event: "COMMENT",
        comments: opts.inline.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      await upsertSummary(opts);
      return { inlinePosted: opts.inline.length, degraded: false };
    } catch {
      const appended =
        opts.summary +
        "\n\n### Inline placement failed\n\n" +
        "GitHub rejected the inline comments, so they are inlined here instead.\n\n" +
        opts.inline
          .map((c) => "#### `" + c.path + ":" + String(c.line) + "`\n\n" + c.body)
          .join("\n\n");
      await upsertSummary({ ...opts, summary: appended });
      return { inlinePosted: 0, degraded: true };
    }
  }

  await upsertSummary(opts);
  return { inlinePosted: 0, degraded: false };
}

async function upsertSummary(opts: PostOptions): Promise<void> {
  const existing = await findSummaryComment(opts.gh, opts.ref, opts.pull);
  if (existing) {
    await opts.gh.issues.updateComment({
      ...opts.ref,
      comment_id: existing.id,
      body: opts.summary,
    });
    return;
  }
  await opts.gh.issues.createComment({
    ...opts.ref,
    issue_number: opts.pull,
    body: opts.summary,
  });
}

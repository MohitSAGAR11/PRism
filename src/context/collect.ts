import type { GitHubClient, RepoRef } from "../github/client.js";
import { renderHunksForPrompt, type ParsedFile } from "../github/diff.js";
import { getFileContent, numberLines } from "../github/pr.js";
import { estimateTokens } from "../util/tokens.js";

export interface FileContext {
  file: ParsedFile;
  /** Head-revision body with line numbers, or null when unavailable. */
  numberedContent: string | null;
  renderedDiff: string;
  tokens: number;
}

/** A set of files small enough to review in one request. */
export interface FileGroup {
  contexts: FileContext[];
  tokens: number;
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function renderFileContext(ctx: FileContext): string {
  const parts = [
    `<file path="${ctx.file.path}" status="${ctx.file.status}">`,
    "",
    "Diff (the number column is the line number in the head revision --",
    "cite these numbers, and only these):",
    "```diff",
    ctx.renderedDiff,
    "```",
  ];

  if (ctx.numberedContent) {
    parts.push(
      "",
      "Full file at head, for context:",
      "```",
      ctx.numberedContent,
      "```",
    );
  } else {
    parts.push("", "(full file unavailable -- reason about the diff alone)");
  }

  parts.push("</file>");
  return parts.join("\n");
}

export async function buildFileContexts(
  gh: GitHubClient,
  ref: RepoRef,
  headSha: string,
  files: ParsedFile[],
): Promise<FileContext[]> {
  const contexts = await Promise.all(
    files.map(async (file): Promise<FileContext> => {
      const renderedDiff = renderHunksForPrompt(file);
      const raw = await getFileContent(gh, ref, file.path, headSha);
      const numberedContent = raw === null ? null : numberLines(raw);
      const ctx: FileContext = { file, numberedContent, renderedDiff, tokens: 0 };
      ctx.tokens = estimateTokens(renderFileContext(ctx));
      return ctx;
    }),
  );
  return contexts;
}

/**
 * Pack files into request-sized groups, keeping a directory together where it
 * fits. Related files reviewed together catch cross-file breakage that a
 * per-file review cannot see.
 *
 * A single file larger than the budget still gets its own group: dropping the
 * full-file context is better than dropping the file, and the caller degrades
 * that case rather than truncating mid-function.
 */
export function groupFiles(contexts: FileContext[], budgetTokens: number): FileGroup[] {
  const byDirectory = new Map<string, FileContext[]>();
  for (const ctx of contexts) {
    const dir = directoryOf(ctx.file.path);
    const bucket = byDirectory.get(dir);
    if (bucket) bucket.push(ctx);
    else byDirectory.set(dir, [ctx]);
  }

  const groups: FileGroup[] = [];
  let current: FileGroup = { contexts: [], tokens: 0 };

  const flush = () => {
    if (current.contexts.length > 0) {
      groups.push(current);
      current = { contexts: [], tokens: 0 };
    }
  };

  for (const dir of [...byDirectory.keys()].sort()) {
    for (const ctx of byDirectory.get(dir)!) {
      if (ctx.tokens > budgetTokens) {
        flush();
        groups.push({ contexts: [ctx], tokens: ctx.tokens });
        continue;
      }
      if (current.tokens + ctx.tokens > budgetTokens) flush();
      current.contexts.push(ctx);
      current.tokens += ctx.tokens;
    }
  }

  flush();
  return groups;
}

/**
 * Drop the full-file context from an oversized single-file group so the diff
 * still gets reviewed instead of being skipped outright.
 */
export function shrinkContext(ctx: FileContext): FileContext {
  const shrunk: FileContext = { ...ctx, numberedContent: null, tokens: 0 };
  shrunk.tokens = estimateTokens(renderFileContext(shrunk));
  return shrunk;
}

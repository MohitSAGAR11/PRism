import type { GitHubClient, RepoRef } from "../github/client.js";
import { getFileContent } from "../github/pr.js";
import { estimateTokens } from "../util/tokens.js";

/**
 * Files that tell the reviewer what this repo already expects of itself.
 * Feeding them in is what stops the bot from suggesting things the team has
 * already decided against.
 */
const CONVENTION_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  ".editorconfig",
];

const PER_FILE_TOKEN_CAP = 2_000;
const TOTAL_TOKEN_CAP = 6_000;

function truncateToTokens(text: string, cap: number): string {
  const total = estimateTokens(text);
  if (total <= cap) return text;
  // The estimate is close enough for a cap; slice by the implied char budget.
  const cut = Math.max(200, Math.floor(text.length * (cap / total)) - 100);
  return text.slice(0, cut) + "\n...(truncated)";
}

function directoryOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * List the directories the convention paths live in, so only files that exist
 * get fetched. Probing each path blind also works, but every miss is a logged
 * 404 and a wasted round trip -- and most repos have none of these files.
 */
async function existingPaths(
  gh: GitHubClient,
  ref: RepoRef,
  gitRef: string,
): Promise<Set<string>> {
  const directories = [...new Set(CONVENTION_PATHS.map(directoryOf))];
  const found = new Set<string>();

  await Promise.all(
    directories.map(async (dir) => {
      try {
        const { data } = await gh.repos.getContent({ ...ref, path: dir, ref: gitRef });
        if (!Array.isArray(data)) return;
        for (const entry of data) {
          if (entry.type === "file") found.add(entry.path);
        }
      } catch {
        // A missing directory just means none of its files are candidates.
      }
    }),
  );

  return found;
}

/**
 * Read the repo's own conventions at the head revision.
 *
 * This becomes part of the cached prompt prefix, so it must stay byte-stable
 * across a run: iterate CONVENTION_PATHS in a fixed order and never interleave
 * anything request-specific.
 */
export async function collectConventions(
  gh: GitHubClient,
  ref: RepoRef,
  gitRef: string,
): Promise<string> {
  const present = await existingPaths(gh, ref, gitRef);
  const byLowerCase = new Map<string, string>();
  for (const p of present) byLowerCase.set(p.toLowerCase(), p);

  const sections: string[] = [];
  let spent = 0;

  for (const path of CONVENTION_PATHS) {
    if (spent >= TOTAL_TOKEN_CAP) break;
    // Match case-insensitively so "Contributing.md" is still picked up.
    const actual = byLowerCase.get(path.toLowerCase());
    if (!actual) continue;

    const content = await getFileContent(gh, ref, actual, gitRef);
    if (!content?.trim()) continue;

    const budget = Math.min(PER_FILE_TOKEN_CAP, TOTAL_TOKEN_CAP - spent);
    const body = truncateToTokens(content, budget);
    spent += estimateTokens(body);
    sections.push("### " + actual + "\n" + body);
  }

  return sections.join("\n\n");
}

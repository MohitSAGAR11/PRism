/**
 * Unified-diff parsing.
 *
 * The only thing this module really has to get right is the mapping from a
 * position inside a patch to a line number in the *new* file, because GitHub
 * rejects an inline comment whose line is not part of the diff -- and it
 * rejects the entire review, not just the offending comment.
 */
export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  /** Line number in the base revision, or null for added lines. */
  oldLine: number | null;
  /** Line number in the head revision, or null for deleted lines. */
  newLine: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface ParsedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  hunks: Hunk[];
  /**
   * New-file line numbers that accept a RIGHT-side inline comment: every added
   * line plus every context line inside a hunk. Deleted lines are absent --
   * they are only addressable with side=LEFT, which v1 does not use.
   */
  commentableLines: Set<number>;
  addedLines: Set<number>;
  /** New-file line number -> raw content, for fingerprinting findings. */
  lineContent: Map<number, string>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse the `patch` string GitHub returns for a single file.
 *
 * GitHub omits `patch` for binary files and for diffs above its size limit; in
 * both cases the caller gets a file with no hunks and nothing commentable.
 */
export function parsePatch(patch: string | undefined | null): Hunk[] {
  if (!patch) return [];

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const headerMatch = HUNK_HEADER.exec(raw);
    if (headerMatch) {
      current = {
        header: raw,
        oldStart: Number(headerMatch[1]),
        // A missing count in `@@ -a +c @@` means exactly one line, not zero.
        oldLines: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
        newStart: Number(headerMatch[3]),
        newLines: headerMatch[4] === undefined ? 1 : Number(headerMatch[4]),
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }

    if (!current) continue; // preamble ("diff --git", "index ...") -- ignore

    // "\ No newline at end of file" annotates the previous line and must not
    // advance either counter.
    if (raw.startsWith("\\")) continue;

    const marker = raw.charAt(0);
    const content = raw.slice(1);

    if (marker === "+") {
      current.lines.push({ kind: "add", content, oldLine: null, newLine });
      newLine += 1;
    } else if (marker === "-") {
      current.lines.push({ kind: "del", content, oldLine, newLine: null });
      oldLine += 1;
    } else if (marker === " " || raw === "") {
      // A blank context line arrives as a single space, but some producers
      // strip trailing whitespace and emit "". Both mean an empty context line.
      current.lines.push({
        kind: "context",
        content: raw === "" ? "" : content,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
    // Anything else is not part of a hunk body; skip it.
  }

  return hunks;
}

export interface RawPullFile {
  filename: string;
  status: string;
  patch?: string | null | undefined;
  previous_filename?: string | null | undefined;
}

export function parseFile(file: RawPullFile): ParsedFile {
  const hunks = parsePatch(file.patch);
  const commentableLines = new Set<number>();
  const addedLines = new Set<number>();
  const lineContent = new Map<number, string>();

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine === null) continue;
      lineContent.set(line.newLine, line.content);
      commentableLines.add(line.newLine);
      if (line.kind === "add") addedLines.add(line.newLine);
    }
  }

  const parsed: ParsedFile = {
    path: file.filename,
    status: file.status as FileStatus,
    hunks,
    commentableLines,
    addedLines,
    lineContent,
  };
  if (file.previous_filename) parsed.previousPath = file.previous_filename;
  return parsed;
}

/**
 * Render a patch for the model with explicit head-revision line numbers.
 *
 * A raw unified diff carries no line numbers, so a model asked to cite one has
 * to count rows -- which it does badly. Printing the number the review API
 * expects, next to the code it belongs to, is the cheapest accuracy win here.
 */
export function renderHunksForPrompt(file: ParsedFile): string {
  if (file.hunks.length === 0) {
    return `(no textual diff available -- binary, generated, or too large)`;
  }

  const out: string[] = [];
  for (const hunk of file.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const num = line.newLine === null ? "     " : String(line.newLine).padStart(5);
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(`${num} ${marker} ${line.content}`);
    }
  }
  return out.join("\n");
}

/**
 * Whitespace-normalized content of a head-revision line, used as part of a
 * finding's fingerprint so that reindenting code does not resurrect a comment
 * that was already posted.
 */
export function normalizedLineContent(file: ParsedFile, line: number): string {
  return (file.lineContent.get(line) ?? "").trim().replace(/\s+/g, " ");
}

/** Total added + deleted lines across all hunks, for size heuristics. */
export function changedLineCount(file: ParsedFile): number {
  let n = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "context") n += 1;
    }
  }
  return n;
}
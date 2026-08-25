import type { ParsedFile } from "../github/diff.js";

/**
 * Paths never worth spending tokens on: machine-generated, vendored, or
 * minified. A lockfile diff produces nothing but noise.
 */
const ALWAYS_SKIP = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/go.sum",
  "**/*.pb.go",
  "**/*_pb2.py",
  "**/*.generated.*",
];

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "gz",
  "tar", "bz2", "7z", "rar", "exe", "dll", "so", "dylib", "class", "jar",
  "woff", "woff2", "ttf", "eot", "otf", "mp3", "mp4", "mov", "avi", "wav",
  "sqlite", "db", "bin", "wasm", "pyc", "pdb", "psd",
]);

const REGEX_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]"]);
const BACKSLASH = String.fromCharCode(92);

/** Translate a gitignore-flavoured glob into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // Leading **/ matches zero or more whole path segments.
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === BACKSLASH || REGEX_SPECIAL.has(c)) {
      out += BACKSLASH + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export interface SkipDecision {
  skip: boolean;
  reason?: string;
}

export function shouldSkip(file: ParsedFile, pathsIgnore: string[]): SkipDecision {
  if (file.status === "removed") return { skip: true, reason: "file deleted" };
  if (file.hunks.length === 0) return { skip: true, reason: "no textual diff" };
  if (BINARY_EXTENSIONS.has(extensionOf(file.path))) return { skip: true, reason: "binary" };
  if (matchesAny(file.path, ALWAYS_SKIP)) return { skip: true, reason: "generated or vendored" };
  if (pathsIgnore.length > 0 && matchesAny(file.path, pathsIgnore)) {
    return { skip: true, reason: "matched paths_ignore" };
  }
  return { skip: false };
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export function partitionFiles(
  files: ParsedFile[],
  pathsIgnore: string[],
): { review: ParsedFile[]; skipped: SkippedFile[] } {
  const review: ParsedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const f of files) {
    const decision = shouldSkip(f, pathsIgnore);
    if (decision.skip) skipped.push({ path: f.path, reason: decision.reason ?? "skipped" });
    else review.push(f);
  }
  return { review, skipped };
}

export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface ParsedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  hunks: DiffHunk[];
}

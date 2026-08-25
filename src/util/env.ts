import { existsSync, readFileSync } from "node:fs";

/**
 * Load a `.env` file into `process.env` for local runs.
 *
 * `.env.example` tells you to copy it to `.env`, so something has to read it.
 * Deliberately tiny and dependency-free.
 *
 * Three rules, each of which exists to avoid a specific confusion:
 *
 * - A real environment variable always wins. An explicit `export` should beat a
 *   stale file, not the other way round.
 * - An empty assignment (`GITHUB_TOKEN=`, straight out of `.env.example`) is
 *   skipped rather than set. Setting it to `""` would shadow the `gh auth token`
 *   fallback with a value that looks present and authenticates as nobody.
 * - A missing file is not an error. In CI these values come from Action inputs
 *   and repository secrets.
 *
 * Not called from `index.ts`: an Action gets its configuration from its inputs,
 * and a workflow holding secrets has no business reading env files off disk.
 */
export function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (!value) continue;

    const existing = process.env[key];
    if (existing === undefined || existing === "") process.env[key] = value;
  }
}

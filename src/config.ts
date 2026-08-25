import { z } from "zod";
import yaml from "js-yaml";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "edge-case",
  "performance",
  "security",
  "test-gap",
  "style",
] as const;
export type Category = (typeof CATEGORIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** Shape of .github/ai-review.yml in the repository being reviewed. */
const FileConfigSchema = z
  .object({
    model: z.string().optional(),
    verify_model: z.string().optional(),
    fallback_models: z.array(z.string()).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    severity_threshold: z.enum(SEVERITIES).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    max_inline_comments: z.number().int().positive().optional(),
    paths_ignore: z.array(z.string()).optional(),
    focus: z.array(z.enum(CATEGORIES)).optional(),
    custom_rules: z.array(z.string()).optional(),
    max_files: z.number().int().positive().optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

export interface Config {
  model: string;
  verifyModel: string;
  fallbackModels: string[];
  effort: "low" | "medium" | "high";
  severityThreshold: Severity;
  minConfidence: number;
  maxInlineComments: number;
  pathsIgnore: string[];
  focus: Category[];
  customRules: string[];
  maxFiles: number;
}

export const DEFAULT_CONFIG: Config = {
  model: "anthropic/claude-sonnet-4.5",
  verifyModel: "anthropic/claude-sonnet-4.5",
  fallbackModels: [],
  effort: "high",
  severityThreshold: "medium",
  minConfidence: 0.7,
  maxInlineComments: 15,
  pathsIgnore: [],
  focus: [],
  customRules: [],
  maxFiles: 60,
};

export function parseFileConfig(raw: string): FileConfig {
  const doc = yaml.load(raw);
  if (doc === null || doc === undefined) return {};
  return FileConfigSchema.parse(doc);
}

/**
 * Layer the repo config file over the defaults, then Action inputs over that,
 * so a workflow can override a repo without needing a commit to that repo.
 */
export function resolveConfig(file: FileConfig, inputs: Partial<Config> = {}): Config {
  const model = inputs.model ?? file.model ?? DEFAULT_CONFIG.model;
  return {
    model,
    // Defaults to the find model, so one key configures both passes.
    verifyModel: inputs.verifyModel ?? file.verify_model ?? model,
    fallbackModels: inputs.fallbackModels ?? file.fallback_models ?? DEFAULT_CONFIG.fallbackModels,
    effort: inputs.effort ?? file.effort ?? DEFAULT_CONFIG.effort,
    severityThreshold:
      inputs.severityThreshold ?? file.severity_threshold ?? DEFAULT_CONFIG.severityThreshold,
    minConfidence: inputs.minConfidence ?? file.min_confidence ?? DEFAULT_CONFIG.minConfidence,
    maxInlineComments:
      inputs.maxInlineComments ?? file.max_inline_comments ?? DEFAULT_CONFIG.maxInlineComments,
    pathsIgnore: inputs.pathsIgnore ?? file.paths_ignore ?? DEFAULT_CONFIG.pathsIgnore,
    focus: inputs.focus ?? file.focus ?? DEFAULT_CONFIG.focus,
    customRules: inputs.customRules ?? file.custom_rules ?? DEFAULT_CONFIG.customRules,
    maxFiles: inputs.maxFiles ?? file.max_files ?? DEFAULT_CONFIG.maxFiles,
  };
}

import { z } from "zod";
import { parse as parseYaml } from "yaml";

const MAX_SKILLS = 50;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DESCRIPTION_CHARS = 500;
const MAX_SKILL_CONTENT_CHARS = 50_000;
const MAX_SKILL_MARKDOWN_CHARS = 80_000;
const MAX_SKILL_IMPORT_FILES = 200;
const MAX_SKILL_IMPORT_FILE_CHARS = 80_000;
const MAX_SKILL_RESOURCE_FILES = 20;
const MAX_SKILL_RESOURCE_CHARS = 20_000;
const MAX_SKILL_RESOURCE_TOTAL_CHARS = 80_000;
const MAX_INLINE_RESOURCE_CHARS = 8_000;

export const SKILL_SETTINGS_KEY = "skills";

export const SkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SKILL_NAME_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, or hyphens.");

export const SkillDefinitionSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().max(MAX_SKILL_DESCRIPTION_CHARS).optional(),
  content: z.string().trim().min(1).max(MAX_SKILL_CONTENT_CHARS),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(300),
        content: z.string().max(MAX_SKILL_RESOURCE_CHARS),
        truncated: z.boolean().optional(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(MAX_SKILL_RESOURCE_FILES)
    .optional()
    .default([]),
  metadata: z
    .object({
      internal: z.boolean().optional(),
    })
    .optional(),
  sourcePath: z.string().trim().max(300).optional(),
});

export const SkillSettingsSchema = z.object({
  skills: z.array(SkillDefinitionSchema).max(MAX_SKILLS).default([]),
});

export const SkillMarkdownImportSchema = z.object({
  markdown: z.string().trim().min(1).max(MAX_SKILL_MARKDOWN_CHARS),
  files: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(300),
        content: z.string().max(MAX_SKILL_IMPORT_FILE_CHARS),
      }),
    )
    .max(MAX_SKILL_IMPORT_FILES)
    .optional()
    .default([]),
  sourcePath: z.string().trim().max(300).optional(),
  includeInternal: z.boolean().optional().default(false),
});

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;
export type SkillSettings = z.infer<typeof SkillSettingsSchema>;

export function parseSkillSettingsPayload(payload: unknown): SkillSettings {
  const result = SkillSettingsSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid skills settings", result.error));
  }
  return dedupeSkills(result.data);
}

export function parseSkillDefinitionPayload(payload: unknown): SkillDefinition {
  const markdown = SkillMarkdownImportSchema.safeParse(payload);
  if (markdown.success) {
    return parseSkillMarkdown(markdown.data.markdown, {
      sourcePath: markdown.data.sourcePath,
      includeInternal: markdown.data.includeInternal,
      files: markdown.data.files,
    });
  }

  const result = SkillDefinitionSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid skill", result.error));
  }
  return result.data;
}

export function parseSkillMarkdownPayload(payload: unknown): SkillDefinition {
  const result = SkillMarkdownImportSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid skill markdown", result.error));
  }
  return parseSkillMarkdown(result.data.markdown, {
    sourcePath: result.data.sourcePath,
    includeInternal: result.data.includeInternal,
    files: result.data.files,
  });
}

export function dedupeSkills(settings: SkillSettings): SkillSettings {
  const byName = new Map<string, SkillDefinition>();
  for (const skill of settings.skills) {
    byName.set(skill.name, skill);
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function skillGuidance(skills: SkillDefinition[]) {
  const described = skills.filter((skill) => skill.description?.trim() && !skill.metadata?.internal);
  if (described.length === 0) return undefined;
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    ...described.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description ?? "")}</description>`,
      ...(skill.sourcePath ? [`    <source>${escapeXml(skill.sourcePath)}</source>`] : []),
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

export function formatSkillContent(skill: SkillDefinition) {
  return [
    `<skill_content name="${escapeXml(skill.name)}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    "This skill is stored in the agent's SQL-backed runtime settings.",
    ...(skill.sourcePath ? [`Source path: ${skill.sourcePath}`] : []),
    ...(skill.files.length
      ? [
          "",
          "<skill_files>",
          ...skill.files.map((file) => `<file path="${escapeXml(file.path)}" truncated="${file.truncated === true ? "true" : "false"}" size="${file.size ?? file.content.length}">${escapeXml(file.path)}</file>`),
          "</skill_files>",
          "",
          "<skill_file_contents>",
          ...skill.files.flatMap((file) =>
            file.content.length <= MAX_INLINE_RESOURCE_CHARS
              ? [
                  `<file_content path="${escapeXml(file.path)}">`,
                  file.content,
                  "</file_content>",
                ]
              : [
                  `<file_content path="${escapeXml(file.path)}" truncated="true">`,
                  file.content.slice(0, MAX_INLINE_RESOURCE_CHARS),
                  "</file_content>",
                ],
          ),
          "</skill_file_contents>",
        ]
      : []),
    "</skill_content>",
  ].join("\n");
}

export function parseSkillMarkdown(
  markdown: string,
  options: {
    sourcePath?: string;
    includeInternal?: boolean;
    files?: Array<{ path: string; content: string }>;
  } = {},
): SkillDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown.trim());
  if (!match) {
    throw new Error("Invalid SKILL.md: missing YAML frontmatter delimited by ---.");
  }

  const frontmatter = parseYaml(match[1]) as unknown;
  const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    throw new Error(formatZodError("Invalid SKILL.md frontmatter", parsed.error));
  }
  if (parsed.data.metadata?.internal && !options.includeInternal) {
    throw new Error(`Skill ${parsed.data.name} is internal. Set includeInternal to import it.`);
  }

  const content = match[2].trim();
  if (!content) {
    throw new Error("Invalid SKILL.md: body is empty.");
  }

  return SkillDefinitionSchema.parse({
    name: parsed.data.name,
    description: parsed.data.description,
    content,
    files: normalizeResourceFiles(options.files ?? [], options.sourcePath),
    metadata: parsed.data.metadata,
    sourcePath: options.sourcePath,
  });
}

function normalizeResourceFiles(files: Array<{ path: string; content: string }>, sourcePath?: string) {
  const sourceDir = sourcePath ? dirname(sourcePath) : "";
  let remainingChars = MAX_SKILL_RESOURCE_TOTAL_CHARS;
  const normalized = files
    .filter((file) => file.path !== sourcePath && !isLikelyIgnoredResource(file.path))
    .map((file) => ({
      path: sourceDir && file.path.startsWith(`${sourceDir}/`)
        ? file.path.slice(sourceDir.length + 1)
        : file.path,
      content: file.content,
    }))
    .sort((left, right) => resourceRank(left.path) - resourceRank(right.path) || left.path.localeCompare(right.path));

  const result: Array<{ path: string; content: string; truncated?: boolean; size?: number }> = [];
  for (const file of normalized) {
    if (result.length >= MAX_SKILL_RESOURCE_FILES || remainingChars <= 0) break;
    const limit = Math.min(MAX_SKILL_RESOURCE_CHARS, remainingChars);
    const content = file.content.slice(0, limit);
    result.push({
      path: file.path,
      content,
      truncated: file.content.length > content.length,
      size: file.content.length,
    });
    remainingChars -= content.length;
  }
  return result;
}

function dirname(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function resourceRank(path: string) {
  if (/^scripts?\//.test(path)) return 0;
  if (/\.(?:js|mjs|cjs|ts|tsx|py|sh|sql|json|ya?ml|md|txt)$/i.test(path)) return 1;
  return 2;
}

function isLikelyIgnoredResource(path: string) {
  return /(^|\/)(?:\.git|node_modules|dist|build|\.venv|__pycache__)\//.test(path);
}

const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(MAX_SKILL_DESCRIPTION_CHARS),
  metadata: z
    .object({
      internal: z.boolean().optional(),
    })
    .optional(),
});

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue?.message ?? "schema error"}`;
}

import { z } from "zod";
import {
  normalizeSkillSources,
  parseSkillMarkdown,
  SkillNameSchema,
  SkillSourceStringSchema,
  type SkillDefinition,
} from "./settings";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SOURCE_FILES = 80;
const MAX_SOURCE_FILE_CHARS = 80_000;
const MAX_IMPORTED_SKILLS = 50;

const PRIORITY_PREFIXES = [
  "",
  "skills/",
  "skills/.curated/",
  "skills/.experimental/",
  "skills/.system/",
  ".aider-desk/skills/",
  ".agents/skills/",
  "data/skills/",
  ".autohand/skills/",
  ".augment/skills/",
  ".bob/skills/",
  ".claude/skills/",
  ".codeartsdoer/skills/",
  ".cline/skills/",
  ".codebuddy/skills/",
  ".codemaker/skills/",
  ".codestudio/skills/",
  ".codex/skills/",
  ".commandcode/skills/",
  ".continue/skills/",
  ".cortex/skills/",
  ".crush/skills/",
  ".devin/skills/",
  ".factory/skills/",
  ".forge/skills/",
  ".github/skills/",
  ".goose/skills/",
  ".hermes/skills/",
  ".inferencesh/skills/",
  ".jazz/skills/",
  ".iflow/skills/",
  ".junie/skills/",
  ".kilocode/skills/",
  ".kiro/skills/",
  ".kode/skills/",
  ".lingma/skills/",
  ".mcpjam/skills/",
  ".vibe/skills/",
  ".moxby/skills/",
  ".mux/skills/",
  ".neovate/skills/",
  ".ona/skills/",
  ".opencode/skills/",
  ".openhands/skills/",
  ".pi/skills/",
  ".qoder/skills/",
  ".qwen/skills/",
  ".reasonix/skills/",
  ".rovodev/skills/",
  ".roo/skills/",
  ".tabnine/agent/skills/",
  ".terramind/skills/",
  ".tinycloud/skills/",
  ".trae/skills/",
  ".windsurf/skills/",
  ".zencoder/skills/",
  ".adal/skills/",
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

const MAX_SKILL_SOURCES = 20;

export const SkillSourceImportSchema = z.object({
  source: SkillSourceStringSchema.optional(),
  sources: z.array(SkillSourceStringSchema).max(MAX_SKILL_SOURCES).optional(),
  skill: SkillNameSchema.optional(),
  includeInternal: z.boolean().optional().default(false),
}).refine((value) => Boolean(value.source || value.sources?.length), {
  message: "Provide source or sources.",
});

export type SkillSourceImport = z.infer<typeof SkillSourceImportSchema>;

interface GitHubSource {
  ownerRepo: string;
  ref?: string;
  subpath?: string;
  skillFilter?: string;
}

interface GitHubTree {
  branch: string;
  tree: GitHubTreeEntry[];
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree" | string;
  sha?: string;
  size?: number;
}

interface ImportOptions {
  fetchImpl?: typeof fetch;
  token?: string;
}

export async function importSkillsFromSource(
  payload: unknown,
  options: ImportOptions = {},
): Promise<SkillDefinition[]> {
  const input = SkillSourceImportSchema.safeParse(payload);
  if (!input.success) {
    throw new Error(formatZodError("Invalid skill source", input.error));
  }

  const sources = normalizeSourceList(input.data);
  const byName = new Map<string, SkillDefinition>();
  for (const sourceText of sources) {
    try {
      const skills = await importSingleGitHubSource(sourceText, input.data, options);
      for (const skill of skills) {
        byName.set(skill.name, skill);
        if (byName.size >= MAX_IMPORTED_SKILLS) break;
      }
    } catch (error) {
      throw new Error(`Could not import ${sourceText}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (byName.size >= MAX_IMPORTED_SKILLS) break;
  }
  if (byName.size === 0) {
    throw new Error("No importable skills found in sources.");
  }
  return [...byName.values()];
}

async function importSingleGitHubSource(
  sourceText: string,
  input: SkillSourceImport,
  options: ImportOptions,
) {
  const source = parseGitHubSource(sourceText);
  const skillFilter = input.skill ?? source.skillFilter;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tree = await fetchRepoTree(source.ownerRepo, source.ref, fetchImpl, options.token);
  if (!tree) {
    throw new Error(`Could not load GitHub repository tree for ${source.ownerRepo}.`);
  }

  let skillMdPaths = findSkillMdPaths(tree, source.subpath);
  if (skillFilter) {
    const filterSlug = toSkillSlug(skillFilter);
    const byFolder = skillMdPaths.filter((path) => {
      const parts = path.split("/");
      if (parts.length < 2) return false;
      return toSkillSlug(parts[parts.length - 2]) === filterSlug;
    });
    if (byFolder.length > 0) skillMdPaths = byFolder;
  }
  if (skillMdPaths.length === 0) {
    throw new Error(`No SKILL.md files found in ${source.ownerRepo}.`);
  }

  const skills: SkillDefinition[] = [];
  for (const skillMdPath of skillMdPaths.slice(0, MAX_IMPORTED_SKILLS)) {
    const skillMdEntry = tree.tree.find((entry) => entry.path === skillMdPath && entry.type === "blob");
    if (!skillMdEntry?.sha) continue;

    const markdown = await fetchBlobText(source.ownerRepo, skillMdEntry.sha, fetchImpl, options.token);
    if (!markdown) continue;

    const resourceEntries = resourceEntriesForSkill(tree.tree, skillMdPath).slice(0, MAX_SOURCE_FILES);
    const files = await Promise.all(
      resourceEntries.map(async (entry) => ({
        path: entry.path,
        content: entry.sha
          ? await fetchBlobText(source.ownerRepo, entry.sha, fetchImpl, options.token)
          : null,
      })),
    );

    try {
      const parsed = parseSkillMarkdown(markdown, {
        sourcePath: skillMdPath,
        includeInternal: input.includeInternal,
        files: files.flatMap((file) =>
          file.content === null ? [] : [{ path: file.path, content: file.content }],
        ),
      });
      if (!skillFilter || toSkillSlug(parsed.name) === toSkillSlug(skillFilter) || matchesFolderFilter(skillMdPath, skillFilter)) {
        skills.push(parsed);
      }
    } catch (error) {
      if (input.includeInternal || !String(error).includes("is internal")) throw error;
    }
  }

  if (skills.length === 0) {
    throw new Error(skillFilter
      ? `No importable skill matched ${skillFilter}.`
      : "No importable skills found in source.");
  }
  return skills;
}

function normalizeSourceList(input: SkillSourceImport) {
  const values = [
    ...(input.source ? splitSourceText(input.source) : []),
    ...(input.sources ?? []).flatMap(splitSourceText),
  ];
  const sources = normalizeSkillSources(values);
  if (sources.length === 0) {
    throw new Error("Provide at least one skill source.");
  }
  return sources.slice(0, MAX_SKILL_SOURCES);
}

function splitSourceText(value: string) {
  return value
    .split(/[\s,]+/)
    .map((source) => source.trim())
    .filter(Boolean);
}

export function parseGitHubSource(input: string): GitHubSource {
  let source = input.trim();
  const fragment = parseFragmentRef(source);
  source = fragment.inputWithoutFragment;

  if (source === "coinbase/agentWallet") source = "coinbase/agentic-wallet-skills";
  if (source.startsWith("github:")) return parseGitHubSource(withFragment(source.slice("github:".length), fragment));
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/") || source === "." || source === "..") {
    throw new Error("Local skill sources are not supported in the Worker runtime. Use a GitHub source URL.");
  }
  if (source.startsWith("gitlab:") || source.includes("gitlab.com")) {
    throw new Error("GitLab skill sources are not supported yet. Use a GitHub source URL.");
  }

  const githubTreeWithPath = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (githubTreeWithPath) {
    const [, owner, repo, ref, subpath] = githubTreeWithPath;
    return withFragmentFields({
      ownerRepo: normalizeOwnerRepo(owner, repo),
      ref,
      subpath: sanitizeSubpath(subpath),
    }, fragment);
  }

  const githubTree = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
  if (githubTree) {
    const [, owner, repo, ref] = githubTree;
    return withFragmentFields({ ownerRepo: normalizeOwnerRepo(owner, repo), ref }, fragment);
  }

  const githubRepo = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (githubRepo) {
    const [, owner, repo] = githubRepo;
    return withFragmentFields({ ownerRepo: normalizeOwnerRepo(owner, repo) }, fragment);
  }

  const githubSshRepo = source.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (githubSshRepo) {
    const [, owner, repo] = githubSshRepo;
    return withFragmentFields({ ownerRepo: normalizeOwnerRepo(owner, repo) }, fragment);
  }

  const atSkill = source.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atSkill && !source.includes(":")) {
    const [, owner, repo, skillFilter] = atSkill;
    return withFragmentFields({
      ownerRepo: normalizeOwnerRepo(owner, repo),
      skillFilter,
    }, fragment);
  }

  const shorthand = source.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (shorthand && !source.includes(":")) {
    const [, owner, repo, subpath] = shorthand;
    return withFragmentFields({
      ownerRepo: normalizeOwnerRepo(owner, repo),
      subpath: subpath ? sanitizeSubpath(subpath) : undefined,
    }, fragment);
  }

  throw new Error("Unsupported skill source. Use github:owner/repo, owner/repo, owner/repo/path, owner/repo@skill, or a GitHub tree URL.");
}

async function fetchRepoTree(
  ownerRepo: string,
  ref: string | undefined,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<GitHubTree | null> {
  const refs = ref ? [ref] : ["HEAD", "main", "master"];
  for (const branch of refs) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!response.ok) continue;
    const body = GitHubTreeResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!body.success) continue;
    return {
      branch,
      tree: body.data.tree,
    };
  }
  return null;
}

async function fetchBlobText(
  ownerRepo: string,
  sha: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${ownerRepo}/git/blobs/${encodeURIComponent(sha)}`,
    { headers: githubHeaders(token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!response.ok) return null;
  const body = GitHubBlobResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success || body.data.encoding !== "base64") return null;
  const text = decodeBase64Text(body.data.content);
  if (text.includes("\0")) return null;
  return text.slice(0, MAX_SOURCE_FILE_CHARS);
}

function findSkillMdPaths(tree: GitHubTree, subpath?: string) {
  const allSkillMds = tree.tree
    .filter((entry) => entry.type === "blob" && entry.path.toLowerCase().endsWith("skill.md"))
    .map((entry) => entry.path);
  const prefix = subpath ? subpath.endsWith("/") ? subpath : `${subpath}/` : "";
  const filtered = prefix
    ? allSkillMds.filter((path) => path.startsWith(prefix) || path === `${prefix}SKILL.md`)
    : allSkillMds;
  if (filtered.length === 0) return [];

  const priorityResults: string[] = [];
  const seen = new Set<string>();
  const lowerSkillMdSet = new Set(filtered.map((path) => path.toLowerCase()));
  for (const priorityPrefix of PRIORITY_PREFIXES) {
    const fullPrefix = prefix + priorityPrefix;
    const isContainer = priorityPrefix !== "";
    for (const skillMd of filtered) {
      if (!skillMd.startsWith(fullPrefix)) continue;
      const rest = skillMd.slice(fullPrefix.length);
      if (rest.toLowerCase() === "skill.md") {
        pushUnique(priorityResults, seen, skillMd);
        continue;
      }

      const parts = rest.split("/");
      if (parts.length === 2 && parts[1].toLowerCase() === "skill.md") {
        pushUnique(priorityResults, seen, skillMd);
        continue;
      }

      if (
        isContainer &&
        parts.length === 3 &&
        parts[2].toLowerCase() === "skill.md" &&
        !SKIP_DIRS.has(parts[0]) &&
        !SKIP_DIRS.has(parts[1])
      ) {
        const parentSkillMd = `${fullPrefix}${parts[0]}/SKILL.md`.toLowerCase();
        if (!lowerSkillMdSet.has(parentSkillMd)) pushUnique(priorityResults, seen, skillMd);
      }
    }
  }
  return priorityResults.length > 0
    ? priorityResults
    : filtered.filter((path) => path.split("/").length <= 6);
}

function resourceEntriesForSkill(entries: GitHubTreeEntry[], skillMdPath: string) {
  const baseDir = dirname(skillMdPath);
  return entries
    .filter((entry) => {
      if (entry.type !== "blob" || !entry.sha) return false;
      if (entry.path === skillMdPath) return false;
      if (entry.path.toLowerCase().endsWith("/skill.md") || entry.path.toLowerCase() === "skill.md") return false;
      if (isLikelyIgnoredResource(entry.path) || isLikelyBinaryResource(entry.path)) return false;
      return baseDir ? entry.path.startsWith(`${baseDir}/`) : true;
    })
    .sort((left, right) => resourceRank(left.path) - resourceRank(right.path) || left.path.localeCompare(right.path));
}

function parseFragmentRef(input: string) {
  const hashIndex = input.indexOf("#");
  if (hashIndex < 0) return { inputWithoutFragment: input };
  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);
  if (!fragment) return { inputWithoutFragment: input };
  const atIndex = fragment.indexOf("@");
  if (atIndex === -1) {
    return { inputWithoutFragment, ref: decodeFragmentValue(fragment) };
  }
  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    inputWithoutFragment,
    ref: ref ? decodeFragmentValue(ref) : undefined,
    skillFilter: skillFilter ? decodeFragmentValue(skillFilter) : undefined,
  };
}

function withFragment(source: string, fragment: ReturnType<typeof parseFragmentRef>) {
  if (!fragment.ref) return source;
  return `${source}#${fragment.ref}${fragment.skillFilter ? `@${fragment.skillFilter}` : ""}`;
}

function withFragmentFields(source: GitHubSource, fragment: ReturnType<typeof parseFragmentRef>): GitHubSource {
  return {
    ...source,
    ref: source.ref ?? fragment.ref,
    skillFilter: fragment.skillFilter ?? source.skillFilter,
  };
}

function normalizeOwnerRepo(owner: string, repo: string) {
  const cleanedRepo = repo.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(cleanedRepo)) {
    throw new Error("Invalid GitHub owner or repository name.");
  }
  return `${owner}/${cleanedRepo}`;
}

function sanitizeSubpath(subpath: string) {
  const normalized = subpath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Unsafe skill source subpath.");
  }
  return normalized;
}

function githubHeaders(token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "agent-worker-skills",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function decodeFragmentValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBase64Text(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function matchesFolderFilter(path: string, skillFilter: string) {
  const parts = path.split("/");
  return parts.length >= 2 && toSkillSlug(parts[parts.length - 2]) === toSkillSlug(skillFilter);
}

function toSkillSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function resourceRank(path: string) {
  if (/^scripts?\//.test(path) || /\/scripts?\//.test(path)) return 0;
  if (/\.(?:js|mjs|cjs|ts|tsx|py|sh|sql|json|ya?ml|md|txt)$/i.test(path)) return 1;
  return 2;
}

function isLikelyIgnoredResource(path: string) {
  return /(^|\/)(?:\.git|node_modules|dist|build|\.venv|__pycache__)\//.test(path);
}

function isLikelyBinaryResource(path: string) {
  return /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|tar|gz|tgz|mp4|mov|mp3|wav|wasm|woff2?|ttf|otf)$/i.test(path);
}

function pushUnique(target: string[], seen: Set<string>, path: string) {
  if (seen.has(path)) return;
  target.push(path);
  seen.add(path);
}

const GitHubTreeResponseSchema = z.object({
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      sha: z.string().optional(),
      size: z.number().optional(),
    }),
  ),
});

const GitHubBlobResponseSchema = z.object({
  content: z.string(),
  encoding: z.string(),
});

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue?.message ?? "schema error"}`;
}

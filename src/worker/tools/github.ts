import { request as octokitRequest } from "@octokit/request";
import { z } from "zod";
import type { ToolDefinition } from "./registry";

const MAX_GITHUB_RESULTS = 10;
const MAX_FILE_TEXT_CHARS = 80_000;

const OwnerRepoSchema = {
  owner: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .describe("GitHub owner or organization."),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .describe("GitHub repository name."),
};

const GithubSearchRepositoriesInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("GitHub repository search query, for example 'cloudflare workers language:typescript'."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_GITHUB_RESULTS)
    .optional()
    .default(5)
    .describe("Maximum repositories to return."),
  sort: z
    .enum(["stars", "forks", "updated"])
    .optional()
    .describe("Optional GitHub repository search sort."),
  order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order."),
});

const GithubGetRepositoryInputSchema = z.object(OwnerRepoSchema);

const GithubReadFileInputSchema = z.object({
  ...OwnerRepoSchema,
  path: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Repository file path, for example README.md or src/index.ts."),
  ref: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional branch, tag, or commit SHA."),
});

type GithubSearchRepositoriesInput = z.infer<typeof GithubSearchRepositoriesInputSchema>;
type GithubGetRepositoryInput = z.infer<typeof GithubGetRepositoryInputSchema>;
type GithubReadFileInput = z.infer<typeof GithubReadFileInputSchema>;

interface GithubRepoApiResponse {
  full_name: string;
  name: string;
  owner?: { login?: string };
  description?: string | null;
  html_url: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
  default_branch?: string;
  updated_at?: string;
  pushed_at?: string;
}

interface GithubSearchApiResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GithubRepoApiResponse[];
}

interface GithubContentApiResponse {
  type?: string;
  name?: string;
  path?: string;
  sha?: string;
  size?: number;
  encoding?: string;
  content?: string;
  download_url?: string | null;
  html_url?: string;
}

export const githubSearchRepositoriesTool: ToolDefinition<
  GithubSearchRepositoriesInput,
  {
    query: string;
    totalCount?: number;
    incompleteResults?: boolean;
    items: ReturnType<typeof summarizeRepository>[];
  }
> = {
  name: "github_search_repositories",
  description:
    "Search public GitHub repositories. Use for finding projects, libraries, examples, and comparing repo popularity.",
  inputSchema: GithubSearchRepositoriesInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "github",
  maxResultChars: 20_000,
  presentation: {
    label: "GitHub Search",
    icon: "github",
  },
  async execute(ctx, input) {
    const body = await githubRequest<GithubSearchApiResponse>(ctx, "GET /search/repositories", {
      q: input.query,
      per_page: input.maxResults,
      sort: input.sort,
      order: input.order,
    });
    return {
      query: input.query,
      totalCount: body.total_count,
      incompleteResults: body.incomplete_results,
      items: (body.items ?? []).slice(0, input.maxResults).map(summarizeRepository),
    };
  },
};

export const githubGetRepositoryTool: ToolDefinition<
  GithubGetRepositoryInput,
  ReturnType<typeof summarizeRepository>
> = {
  name: "github_get_repository",
  description: "Get public GitHub repository metadata by owner and repository name.",
  inputSchema: GithubGetRepositoryInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "github",
  maxResultChars: 8_000,
  presentation: {
    label: "GitHub Repo",
    icon: "github",
  },
  async execute(ctx, input) {
    return summarizeRepository(
      await githubRequest<GithubRepoApiResponse>(ctx, "GET /repos/{owner}/{repo}", {
        owner: input.owner,
        repo: input.repo,
      }),
    );
  },
};

export const githubReadFileTool: ToolDefinition<
  GithubReadFileInput,
  {
    repository: string;
    path: string;
    ref?: string;
    htmlUrl?: string;
    downloadUrl?: string;
    size?: number;
    truncated: boolean;
    text: string;
  }
> = {
  name: "github_read_file",
  description:
    "Read a text file from a public GitHub repository, such as README.md, package.json, or source snippets.",
  inputSchema: GithubReadFileInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "github",
  maxResultChars: MAX_FILE_TEXT_CHARS + 4_000,
  presentation: {
    label: "GitHub File",
    icon: "file-text",
  },
  async execute(ctx, input) {
    const body = await githubRequest<GithubContentApiResponse>(
      ctx,
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        ref: input.ref,
      },
    );
    if (body.type !== "file") {
      throw new Error(`GitHub path is not a file: ${input.path}`);
    }
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      throw new Error(`GitHub file content is not available as base64: ${input.path}`);
    }

    const text = decodeBase64Utf8(body.content.replace(/\s+/g, ""));
    return {
      repository: `${input.owner}/${input.repo}`,
      path: body.path ?? input.path,
      ref: input.ref,
      htmlUrl: body.html_url,
      downloadUrl: body.download_url ?? undefined,
      size: body.size,
      truncated: text.length > MAX_FILE_TEXT_CHARS,
      text: text.slice(0, MAX_FILE_TEXT_CHARS),
    };
  },
};

async function githubRequest<T>(
  ctx: Parameters<ToolDefinition["execute"]>[0],
  route: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  const request = octokitRequest.defaults({
    headers: githubHeaders(ctx.env?.GITHUB_TOKEN),
    request: {
      fetch: ctx.fetch,
    },
  });

  try {
    const response = await request(route, compactRecord(parameters));
    return response.data as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) {
      const status = (error as { status?: unknown }).status;
      const message = error instanceof Error ? error.message : "GitHub request failed.";
      throw new Error(`GitHub request failed: ${String(status)} ${message}`.trim());
    }
    throw error;
  }
}

function githubHeaders(token: string | undefined) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-worker/0.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function summarizeRepository(repo: GithubRepoApiResponse) {
  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login,
    description: repo.description ?? "",
    htmlUrl: repo.html_url,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    language: repo.language ?? undefined,
    topics: repo.topics ?? [],
    license: repo.license?.spdx_id || repo.license?.name,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
  };
}

function decodeBase64Utf8(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

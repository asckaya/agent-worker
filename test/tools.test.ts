import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDefaultToolRegistry } from "../src/worker/tools";
import { arxivSearchTool } from "../src/worker/tools/arxiv";
import { calculateTool, currentTimeTool } from "../src/worker/tools/basic";
import { capToolResult, ToolExecutor } from "../src/worker/tools/executor";
import { fetchUrlTool } from "../src/worker/tools/fetch-url";
import {
  githubGetRepositoryTool,
  githubReadFileTool,
  githubSearchRepositoriesTool,
} from "../src/worker/tools/github";
import { httpRequestTool } from "../src/worker/tools/http-request";
import {
  stableJsonStringify,
  ToolLoopRecovery,
  ToolRunGuardrails,
  toolCallSignature,
} from "../src/worker/tools/guardrails";
import { ToolRegistry } from "../src/worker/tools/registry";

describe("tool registry", () => {
  it("registers default tools for the model", () => {
    const tools = createDefaultToolRegistry().listModelTools();
    expect(tools.map((tool) => tool.function.name).sort()).toEqual([
      "arxiv_search",
      "calculate",
      "current_time",
      "delete_mcp_server",
      "delete_skill",
      "fetch_url",
      "github_get_repository",
      "github_read_file",
      "github_search_repositories",
      "http_request",
      "save_memory",
      "search_memory",
      "skill",
      "upsert_mcp_server",
      "upsert_skill",
    ]);
    expect(tools.find((tool) => tool.function.name === "fetch_url")?.function.parameters).toMatchObject({
      type: "object",
      required: ["url"],
      properties: {
        url: expect.objectContaining({ type: "string" }),
      },
    });
    expect(tools.find((tool) => tool.function.name === "fetch_url")?.function.description).toContain(
      "Requires explicit user approval",
    );
    expect(createDefaultToolRegistry().get("fetch_url")?.toolset).toBe("web");
    expect(createDefaultToolRegistry().get("http_request")?.toolset).toBe("web");
    expect(createDefaultToolRegistry().get("calculate")?.toolset).toBe("basic");
    expect(createDefaultToolRegistry().get("arxiv_search")?.toolset).toBe("research");
    expect(createDefaultToolRegistry().get("github_search_repositories")?.toolset).toBe("github");
    expect(createDefaultToolRegistry().get("save_memory")?.toolset).toBe("memory");
    expect(createDefaultToolRegistry().get("skill")?.toolset).toBe("skills");
    expect(createDefaultToolRegistry().get("upsert_mcp_server")?.toolset).toBe("mcp");
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    registry.register(fetchUrlTool);
    expect(() => registry.register(fetchUrlTool)).toThrow("Tool already registered");
  });

  it("filters unavailable tools from model exposure", () => {
    const registry = new ToolRegistry({ env: {} as never });
    registry.register({
      name: "needs_env",
      description: "Needs env",
      inputSchema: z.object({}),
      risk: "read",
      requiresApproval: false,
      requiresEnv: ["MISSING_TOKEN"],
      execute: async () => ({ ok: true }),
    });

    expect(registry.listModelTools()).toEqual([]);
    expect(registry.get("needs_env")).toBeUndefined();
    expect(registry.list({ includeUnavailable: true }).map((tool) => tool.name)).toEqual([
      "needs_env",
    ]);
    expect(registry.getAvailability(registry.list({ includeUnavailable: true })[0])).toEqual({
      available: false,
      reason: "Missing env: MISSING_TOKEN",
    });
  });
});

describe("tool executor", () => {
  it("creates an approval instead of executing approval-gated tools", async () => {
    const execute = vi.fn();
    const approval = {
      id: "abc123",
      channel: "telegram",
      chatId: "1",
      toolName: "external_tool",
      toolInput: { value: "x" },
      risk: "external",
      created_at: 1,
      expires_at: 2,
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "external_tool",
      description: "External tool",
      inputSchema: z.object({ value: z.string() }),
      risk: "external",
      requiresApproval: true,
      execute,
    });

    const executor = new ToolExecutor(
      registry,
      {
        fetch,
        saveMemory: async () => undefined,
        searchMemory: async () => [],
      },
      {
        approvalGate: {
          create: async () => approval,
        },
      },
    );

    await expect(
      executor.executeToolCall({
        id: "call_1",
        type: "function",
        function: {
          name: "external_tool",
          arguments: JSON.stringify({ value: "x" }),
        },
      }),
    ).resolves.toEqual({ status: "approval_required", approval });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes approval-gated tools when bypassing approval", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "external_tool",
      description: "External tool",
      inputSchema: z.object({ value: z.string() }),
      risk: "external",
      requiresApproval: true,
      execute: async (_ctx, input) => ({ echoed: (input as { value: string }).value }),
    });

    const executor = new ToolExecutor(registry, {
      fetch,
      saveMemory: async () => undefined,
      searchMemory: async () => [],
    });

    await expect(
      executor.executeStoredTool(
        "external_tool",
        { value: "approved" },
        { bypassApproval: true },
      ),
    ).resolves.toEqual({ status: "executed", result: { echoed: "approved" } });
  });

  it("caps oversized tool results before returning them to the model", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "large_tool",
      description: "Large tool",
      inputSchema: z.object({}),
      risk: "read",
      requiresApproval: false,
      maxResultChars: 12,
      execute: async () => ({ text: "abcdefghijklmnopqrstuvwxyz" }),
    });

    const executor = new ToolExecutor(registry, {
      fetch,
      saveMemory: async () => undefined,
      searchMemory: async () => [],
    });

    await expect(
      executor.executeStoredTool("large_tool", {}, { bypassApproval: true }),
    ).resolves.toEqual({
      status: "executed",
      result: {
        truncated: true,
        toolName: "large_tool",
        maxResultChars: 12,
        preview: "{\"text\":\"abc",
      },
    });
    expect(capToolResult({ name: "small_tool", maxResultChars: 100 }, { ok: true })).toEqual({
      ok: true,
    });
  });
});

describe("tool guardrails", () => {
  it("builds stable signatures for equivalent JSON inputs", () => {
    expect(stableJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(toolCallSignature("tool", { b: 2, a: 1 })).toBe(
      toolCallSignature("tool", { a: 1, b: 2 }),
    );
  });

  it("blocks repeated identical tool calls after the configured limit", () => {
    const guardrails = new ToolRunGuardrails(2);

    expect(guardrails.recordCall("search", { q: "x" })).toMatchObject({
      count: 1,
      blocked: false,
    });
    expect(guardrails.recordCall("search", { q: "x" })).toMatchObject({
      count: 2,
      warning: true,
      blocked: false,
    });
    expect(guardrails.recordCall("search", { q: "x" })).toMatchObject({
      count: 3,
      blocked: true,
    });
  });

  it("warns and then hard-stops repeated tool failures", () => {
    const recovery = new ToolLoopRecovery(2, 3);

    const first = recovery.recordFailure("fetch_url", { url: "https://x.test" }, "timeout");
    expect(first).toMatchObject({
      count: 1,
    });
    expect(first).not.toHaveProperty("warning");
    expect(first).not.toHaveProperty("hardStop");
    expect(recovery.recordFailure("fetch_url", { url: "https://x.test" }, "timeout")).toMatchObject({
      count: 2,
      warning: expect.stringContaining("repeatedly failing"),
    });
    expect(recovery.recordFailure("fetch_url", { url: "https://x.test" }, "timeout")).toMatchObject({
      count: 3,
      hardStop: expect.stringContaining("Stopping this tool loop"),
    });
  });

  it("detects repeated no-progress tool results", () => {
    const recovery = new ToolLoopRecovery(2, 3);
    const input = { query: "same" };
    const result = { items: [] };

    recovery.recordNoProgress("search_memory", input, result);
    expect(recovery.recordNoProgress("search_memory", input, result)).toMatchObject({
      count: 2,
      warning: expect.stringContaining("same result"),
    });
    expect(recovery.recordNoProgress("search_memory", input, result)).toMatchObject({
      count: 3,
      hardStop: expect.stringContaining("Stopping this tool loop"),
    });
  });
});

describe("fetch_url tool", () => {
  it("fetches and bounds text responses", async () => {
    const fetchMock = vi.fn(async () => new Response("hello"));
    const result = await fetchUrlTool.execute(
      {
        fetch: fetchMock as typeof fetch,
        saveMemory: async () => undefined,
        searchMemory: async () => [],
      },
      { url: "https://example.com" },
    );

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/", {
      headers: { "User-Agent": "agent-worker/0.1" },
    });
    expect(result).toEqual({
      url: "https://example.com/",
      status: 200,
      text: "hello",
    });
  });

  it("rejects non-http URLs", async () => {
    await expect(
      fetchUrlTool.execute(
        {
          fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { url: "file:///etc/passwd" },
      ),
    ).rejects.toThrow("Only http and https URLs are supported.");
  });

  it("uses zod schemas for input validation", () => {
    expect(fetchUrlTool.inputSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(fetchUrlTool.inputSchema.safeParse({ url: "not-a-url" }).success).toBe(false);
  });
});

describe("http_request tool", () => {
  it("performs bounded curl-like HTTP requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        statusText: "Created",
        headers: { "Content-Type": "application/json", "X-Test": "yes" },
      }),
    );

    const result = await httpRequestTool.execute(
      {
        fetch: fetchMock as typeof fetch,
        saveMemory: async () => undefined,
        searchMemory: async () => [],
      },
      {
        url: "https://api.example.com/items",
        method: "POST",
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: "{\"name\":\"demo\"}",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/items", {
      method: "POST",
      headers: expect.any(Headers),
      body: "{\"name\":\"demo\"}",
      redirect: "follow",
    });
    expect(result).toMatchObject({
      url: "https://api.example.com/items",
      method: "POST",
      status: 201,
      statusText: "Created",
      ok: true,
      contentType: "application/json",
      json: { ok: true },
      text: "{\"ok\":true}",
      truncated: false,
    });
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("rejects unsafe request shapes", async () => {
    await expect(
      httpRequestTool.execute(
        {
          fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        {
          url: "file:///etc/passwd",
          method: "GET",
          headers: [],
        },
      ),
    ).rejects.toThrow("Only http and https URLs are supported.");

    await expect(
      httpRequestTool.execute(
        {
          fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        {
          url: "https://example.com",
          method: "GET",
          headers: [{ name: "Host", value: "evil.example" }],
        },
      ),
    ).rejects.toThrow("Header is not allowed: Host");
  });
});

describe("basic tools", () => {
  it("evaluates arithmetic without code execution", async () => {
    await expect(
      calculateTool.execute(
        {
          fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { expression: "sqrt(16) + max(2, 3) * 4 - 2^3" },
      ),
    ).resolves.toEqual({
      expression: "sqrt(16) + max(2, 3) * 4 - 2^3",
      result: 8,
    });
    await expect(
      calculateTool.execute(
        {
          fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { expression: "unknown(1)" },
      ),
    ).rejects.toThrow("Unknown function");
  });

  it("formats current time for a timezone", async () => {
    const result = await currentTimeTool.execute(
      {
        fetch,
        saveMemory: async () => undefined,
        searchMemory: async () => [],
      },
      { timeZone: "UTC" },
    );

    expect(result.iso).toEqual(expect.any(String));
    expect(result.unixMs).toEqual(expect.any(Number));
    expect(result.timeZone).toBe("UTC");
    expect(result.formatted).toEqual(expect.any(String));
  });

});

describe("arxiv tool", () => {
  it("parses arXiv Atom search results with fast-xml-parser", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
        `<?xml version="1.0"?>
        <feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
          <opensearch:totalResults>12</opensearch:totalResults>
          <entry>
            <id>http://arxiv.org/abs/2401.00001v1</id>
            <updated>2024-01-02T00:00:00Z</updated>
            <published>2024-01-01T00:00:00Z</published>
            <title> Test Paper &amp; Results </title>
            <summary> A paper about useful agent tooling. </summary>
            <author><name>Alice Example</name></author>
            <author><name>Bob Example</name></author>
            <category term="cs.AI" />
            <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html" />
            <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf" />
          </entry>
        </feed>`,
        ),
    );

    await expect(
      arxivSearchTool.execute(
        {
          fetch: fetchMock as typeof fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { query: "agent tooling", maxResults: 1, sortBy: "relevance", sortOrder: "descending" },
      ),
    ).resolves.toEqual({
      query: "agent tooling",
      totalResults: 12,
      entries: [
        {
          id: "http://arxiv.org/abs/2401.00001v1",
          title: "Test Paper & Results",
          authors: ["Alice Example", "Bob Example"],
          summary: "A paper about useful agent tooling.",
          published: "2024-01-01T00:00:00Z",
          updated: "2024-01-02T00:00:00Z",
          categories: ["cs.AI"],
          pdfUrl: "http://arxiv.org/pdf/2401.00001v1",
          absUrl: "http://arxiv.org/abs/2401.00001v1",
        },
      ],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("export.arxiv.org/api/query");
  });
});

describe("github tools", () => {
  it("searches repositories through Octokit request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(requestUrl(input)).toContain("https://api.github.com/search/repositories");
      return Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [githubRepoApiResponse()],
      });
    });

    await expect(
      githubSearchRepositoriesTool.execute(
        {
          fetch: fetchMock as typeof fetch,
          env: { GITHUB_TOKEN: "token" } as never,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { query: "agent worker", maxResults: 1, sort: "stars", order: "desc" },
      ),
    ).resolves.toMatchObject({
      query: "agent worker",
      totalCount: 1,
      incompleteResults: false,
      items: [
        {
          fullName: "cloudflare/workers-sdk",
          stars: 123,
          language: "TypeScript",
        },
      ],
    });
    expect(readHeader(fetchMock.mock.calls[0]?.[1]?.headers, "authorization")).toBe("Bearer token");
  });

  it("gets repository metadata through Octokit request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://api.github.com/repos/cloudflare/workers-sdk");
      return Response.json(githubRepoApiResponse());
    });

    await expect(
      githubGetRepositoryTool.execute(
        {
          fetch: fetchMock as typeof fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { owner: "cloudflare", repo: "workers-sdk" },
      ),
    ).resolves.toMatchObject({
      fullName: "cloudflare/workers-sdk",
      htmlUrl: "https://github.com/cloudflare/workers-sdk",
      defaultBranch: "main",
    });
  });

  it("reads repository files through Octokit request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(requestUrl(input)).toBe(
        "https://api.github.com/repos/cloudflare/workers-sdk/contents/README.md",
      );
      return Response.json({
        type: "file",
        path: "README.md",
        size: 12,
        encoding: "base64",
        content: btoa("Hello README"),
        download_url: "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/README.md",
        html_url: "https://github.com/cloudflare/workers-sdk/blob/main/README.md",
      });
    });

    await expect(
      githubReadFileTool.execute(
        {
          fetch: fetchMock as typeof fetch,
          saveMemory: async () => undefined,
          searchMemory: async () => [],
        },
        { owner: "cloudflare", repo: "workers-sdk", path: "README.md" },
      ),
    ).resolves.toEqual({
      repository: "cloudflare/workers-sdk",
      path: "README.md",
      ref: undefined,
      htmlUrl: "https://github.com/cloudflare/workers-sdk/blob/main/README.md",
      downloadUrl: "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/README.md",
      size: 12,
      truncated: false,
      text: "Hello README",
    });
  });
});

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function readHeader(headers: HeadersInit | undefined, name: string) {
  if (!headers) return undefined;
  return new Headers(headers).get(name);
}

function githubRepoApiResponse() {
  return {
    full_name: "cloudflare/workers-sdk",
    name: "workers-sdk",
    owner: { login: "cloudflare" },
    description: "Cloudflare Workers SDK",
    html_url: "https://github.com/cloudflare/workers-sdk",
    stargazers_count: 123,
    forks_count: 10,
    open_issues_count: 5,
    language: "TypeScript",
    topics: ["workers"],
    license: { spdx_id: "MIT", name: "MIT License" },
    default_branch: "main",
    updated_at: "2024-01-01T00:00:00Z",
    pushed_at: "2024-01-02T00:00:00Z",
  };
}

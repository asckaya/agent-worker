import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDefaultToolRegistry } from "../src/worker/tools";
import { capToolResult, ToolExecutor } from "../src/worker/tools/executor";
import { fetchUrlTool } from "../src/worker/tools/fetch-url";
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
      "fetch_url",
      "save_memory",
      "search_memory",
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
    expect(createDefaultToolRegistry().get("save_memory")?.toolset).toBe("memory");
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

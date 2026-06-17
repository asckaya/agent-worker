import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type Tool as McpToolDefinition,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolDefinition } from "../tools/registry";
import type { McpSettings, RemoteMcpServer } from "./settings";

const MCP_CLIENT_NAME = "agent-worker";
const MCP_CLIENT_VERSION = "0.1.0";
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 100;
const MAX_MCP_RESULT_CHARS = 12_000;

export type McpTransportName = "streamable-http" | "sse";
export type McpServerStatusName = "connected" | "disabled" | "failed";

export interface McpServerStatus {
  name: string;
  url: string;
  disabled: boolean;
  status: McpServerStatusName;
  checkedAt: number;
  cached: boolean;
  headerNames: string[];
  transport?: McpTransportName;
  toolCount?: number;
  promptCount?: number;
  resourceCount?: number;
  error?: string;
}

export interface McpServerSnapshot {
  serverName: string;
  signature: string;
  refreshedAt: number;
  expiresAt: number;
  status: McpServerStatus;
  tools: McpToolDefinition[];
  prompts: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
}

interface FormattedMcpContentResult {
  text: string;
  structuredContent?: Record<string, unknown>;
  attachments: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export async function createMcpToolDefinitions(
  settings: McpSettings,
  fetcher: typeof fetch = fetch,
  snapshots?: Map<string, McpServerSnapshot>,
): Promise<ToolDefinition[]> {
  if (snapshots) return createMcpToolDefinitionsFromSnapshots(settings, snapshots);

  const generatedSnapshots = new Map<string, McpServerSnapshot>();
  await Promise.all(
    Object.entries(settings.servers).map(async ([serverName, server]) => {
      const snapshot = await inspectMcpServer(serverName, server, fetcher, {
        defaultTimeoutMs: settings.defaultTimeoutMs,
        ttlMs: 0,
      });
      generatedSnapshots.set(serverName, snapshot);
    }),
  );
  return createMcpToolDefinitionsFromSnapshots(settings, generatedSnapshots);
}

export function createMcpToolDefinitionsFromSnapshots(
  settings: McpSettings,
  snapshots: Map<string, McpServerSnapshot>,
) {
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const [serverName, server] of Object.entries(settings.servers)) {
    if (server.disabled) continue;
    const listed = snapshots.get(serverName);
    if (!listed || listed.status.status !== "connected") continue;

    for (const mcpTool of listed.tools) {
      const baseName = `mcp_${sanitizeToolName(serverName)}_${sanitizeToolName(mcpTool.name)}`;
      const name = uniqueName(baseName, usedNames);
      usedNames.add(name);
      tools.push(toToolDefinition(name, serverName, server, mcpTool, settings.defaultTimeoutMs));
    }
  }

  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export async function inspectMcpServer(
  serverName: string,
  server: RemoteMcpServer,
  fetcher: typeof fetch,
  options: { defaultTimeoutMs?: number; ttlMs: number },
): Promise<McpServerSnapshot> {
  const signature = mcpServerSignature(server, options.defaultTimeoutMs);
  const checkedAt = Date.now();
  const baseStatus = {
    name: serverName,
    url: server.url,
    disabled: server.disabled,
    checkedAt,
    cached: false,
    headerNames: Object.keys(server.headers ?? {}),
  };

  if (server.disabled) {
    const status: McpServerStatus = {
      ...baseStatus,
      status: "disabled",
      toolCount: 0,
      promptCount: 0,
      resourceCount: 0,
    };
    return emptySnapshot(serverName, signature, checkedAt, options.ttlMs, status);
  }

  try {
    return await withMcpClient(
      server,
      fetcher,
      options.defaultTimeoutMs,
      async (client, timeout, transport) => {
        const [tools, prompts, resources] = await Promise.all([
          listRemoteTools(client, timeout),
          listRemotePrompts(client, timeout),
          listRemoteResources(client, timeout),
        ]);
        const status: McpServerStatus = {
          ...baseStatus,
          status: "connected",
          transport,
          toolCount: tools.length,
          promptCount: prompts.length,
          resourceCount: resources.length,
        };
        return {
          serverName,
          signature,
          refreshedAt: checkedAt,
          expiresAt: checkedAt + options.ttlMs,
          status,
          tools,
          prompts,
          resources,
        };
      },
    );
  } catch (error) {
    const status: McpServerStatus = {
      ...baseStatus,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      toolCount: 0,
      promptCount: 0,
      resourceCount: 0,
    };
    return emptySnapshot(serverName, signature, checkedAt, options.ttlMs, status);
  }
}

export async function readMcpResource(
  server: RemoteMcpServer,
  resourceUri: string,
  fetcher: typeof fetch,
  defaultTimeoutMs?: number,
) {
  return withMcpClient(server, fetcher, defaultTimeoutMs, async (client, timeout) => {
    const result = await client.readResource({ uri: resourceUri }, { timeout });
    return summarizeMcpResult(result);
  });
}

export async function getMcpPrompt(
  server: RemoteMcpServer,
  name: string,
  args: Record<string, string> | undefined,
  fetcher: typeof fetch,
  defaultTimeoutMs?: number,
) {
  return withMcpClient(server, fetcher, defaultTimeoutMs, async (client, timeout) => {
    const result = await client.getPrompt({ name, arguments: args }, { timeout });
    return summarizeMcpResult(result);
  });
}

export function mcpServerSignature(server: RemoteMcpServer, defaultTimeoutMs?: number) {
  return JSON.stringify({
    ...server,
    defaultTimeoutMs,
  });
}

export function markMcpStatusCached(status: McpServerStatus): McpServerStatus {
  return { ...status, cached: true };
}

function toToolDefinition(
  name: string,
  serverName: string,
  server: RemoteMcpServer,
  mcpTool: McpToolDefinition,
  defaultTimeoutMs?: number,
): ToolDefinition<Record<string, unknown>, unknown> {
  return {
    name,
    description: [
      mcpTool.description || `Call MCP tool ${mcpTool.name} on ${serverName}.`,
      `Remote MCP server: ${serverName}.`,
    ].join("\n"),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    modelParameters: normalizeMcpInputSchema(mcpTool.inputSchema),
    risk: "external",
    requiresApproval: true,
    toolset: "mcp",
    maxResultChars: MAX_MCP_RESULT_CHARS,
    presentation: {
      label: `MCP ${serverName}:${mcpTool.name}`,
    },
    execute: async (ctx, input) =>
      callRemoteTool(server, mcpTool.name, input, ctx.fetch ?? fetch, defaultTimeoutMs),
  };
}

async function listRemoteTools(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.tools) return [];
  const tools: McpToolDefinition[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout });
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    if (cursors.has(result.nextCursor)) {
      throw new Error(`MCP tools/list returned duplicate cursor: ${result.nextCursor}`);
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages.`);
}

async function listRemotePrompts(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.prompts) return [];
  return paginateMcpList(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts as Array<Record<string, unknown>>,
    "prompts/list",
  );
}

async function listRemoteResources(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.resources) return [];
  return paginateMcpList(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources as Array<Record<string, unknown>>,
    "resources/list",
  );
}

async function paginateMcpList<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
  label: string,
) {
  const result: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const pageResult = await list(cursor);
    result.push(...items(pageResult));
    if (pageResult.nextCursor === undefined) return result;
    if (cursors.has(pageResult.nextCursor)) {
      throw new Error(`MCP ${label} returned duplicate cursor: ${pageResult.nextCursor}`);
    }
    cursors.add(pageResult.nextCursor);
    cursor = pageResult.nextCursor;
  }

  throw new Error(`MCP ${label} exceeded ${MAX_LIST_PAGES} pages.`);
}

async function callRemoteTool(
  server: RemoteMcpServer,
  toolName: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch,
  defaultTimeoutMs?: number,
) {
  return withMcpClient(server, fetcher, defaultTimeoutMs, async (client, timeout) => {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: input,
      },
      CallToolResultSchema,
      { timeout },
    );
    return formatMcpToolResult(toolName, result);
  });
}

async function withMcpClient<T>(
  server: RemoteMcpServer,
  fetcher: typeof fetch,
  defaultTimeoutMs: number | undefined,
  fn: (client: Client, timeout: number, transport: McpTransportName) => Promise<T>,
) {
  const timeout = server.timeoutMs ?? defaultTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  const transportFactories: Array<{
    name: McpTransportName;
    create: () => StreamableHTTPClientTransport | SSEClientTransport;
  }> = [
    {
      name: "streamable-http",
      create: () =>
        new StreamableHTTPClientTransport(url, {
          fetch: fetcher,
          requestInit,
        }),
    },
    {
      name: "sse",
      create: () =>
        new SSEClientTransport(url, {
          fetch: withDefaultHeaders(fetcher, server.headers),
          requestInit,
        }),
    },
  ];

  let lastError: unknown;
  for (const transportFactory of transportFactories) {
    const transport = transportFactory.create();
    const client = new Client(
      { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout });
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      continue;
    }

    try {
      return await fn(client, timeout, transportFactory.name);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "MCP connection failed."));
}

function withDefaultHeaders(fetcher: typeof fetch, headers: Record<string, string> | undefined) {
  if (!headers) return fetcher;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) {
      if (!merged.has(name)) merged.set(name, value);
    }
    return fetcher(input, {
      ...init,
      headers: merged,
    });
  }) as typeof fetch;
}

function normalizeMcpInputSchema(schema: McpToolDefinition["inputSchema"]): Record<string, unknown> {
  return {
    ...(schema as Record<string, unknown>),
    type: "object",
    properties:
      typeof schema.properties === "object" && schema.properties !== null
        ? schema.properties
        : {},
    additionalProperties: false,
  };
}

function formatMcpToolResult(toolName: string, result: unknown) {
  if (isLegacyToolResult(result)) {
    return {
      toolName,
      result: result.toolResult,
    };
  }

  if (!isContentToolResult(result)) {
    return {
      toolName,
      result,
    };
  }

  const formatted = summarizeMcpContentResult(result);
  if (result.isError) {
    throw new Error(formatted.text || "MCP tool returned an error.");
  }

  return {
    toolName,
    ...formatted,
  };
}

function summarizeMcpResult(result: unknown) {
  if (!isContentToolResult(result)) return result;
  return summarizeMcpContentResult(result);
}

function summarizeMcpContentResult(result: {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}): FormattedMcpContentResult {
  const textParts: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];
  for (const item of result.content) {
    if (isTextContentItem(item)) {
      textParts.push(item.text);
    } else if (isTextResourceItem(item)) {
      textParts.push(item.resource.text);
    } else {
      attachments.push(summarizeContentItem(item));
    }
  }

  return {
    text: textParts.join("\n\n"),
    structuredContent: result.structuredContent,
    attachments,
    metadata: result._meta,
  };
}

function summarizeContentItem(item: Record<string, unknown>) {
  if (item.type === "image" || item.type === "audio") {
    const data = typeof item.data === "string" ? item.data : "";
    return {
      type: item.type,
      mimeType: item.mimeType,
      dataBytes: data.length,
    };
  }
  if (item.type === "resource" && typeof item.resource === "object" && item.resource !== null) {
    const resource = item.resource as Record<string, unknown>;
    return {
      type: "resource",
      uri: resource.uri,
      mimeType: resource.mimeType,
      blobBytes: typeof resource.blob === "string" ? resource.blob.length : undefined,
    };
  }
  if (item.type === "resource_link") {
    return {
      type: "resource_link",
      uri: item.uri,
      name: item.name,
      mimeType: item.mimeType,
    };
  }
  return { type: item.type ?? "unknown" };
}

function emptySnapshot(
  serverName: string,
  signature: string,
  refreshedAt: number,
  ttlMs: number,
  status: McpServerStatus,
): McpServerSnapshot {
  return {
    serverName,
    signature,
    refreshedAt,
    expiresAt: refreshedAt + ttlMs,
    status,
    tools: [],
    prompts: [],
    resources: [],
  };
}

function isLegacyToolResult(value: unknown): value is { toolResult: unknown } {
  return typeof value === "object" && value !== null && "toolResult" in value;
}

function isContentToolResult(value: unknown): value is {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isTextContentItem(value: Record<string, unknown>): value is { type: "text"; text: string } {
  return value.type === "text" && typeof value.text === "string";
}

function isTextResourceItem(value: Record<string, unknown>): value is {
  type: "resource";
  resource: { text: string };
} {
  return (
    value.type === "resource" &&
    typeof value.resource === "object" &&
    value.resource !== null &&
    typeof (value.resource as { text?: unknown }).text === "string"
  );
}

function sanitizeToolName(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "");
  return sanitized || "server";
}

function uniqueName(baseName: string, usedNames: Set<string>) {
  if (!usedNames.has(baseName)) return baseName;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${baseName}_${index}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  return `${baseName}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

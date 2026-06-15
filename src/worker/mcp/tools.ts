import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolDefinition } from "../tools/registry";
import type { McpSettings, RemoteMcpServer } from "./settings";

const MCP_CLIENT_NAME = "agent-worker";
const MCP_CLIENT_VERSION = "0.1.0";
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 100;
const MAX_MCP_RESULT_CHARS = 12_000;

export async function createMcpToolDefinitions(
  settings: McpSettings,
  fetcher: typeof fetch = fetch,
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  await Promise.all(
    Object.entries(settings.servers).map(async ([serverName, server]) => {
      if (server.disabled) return;
      const listed = await listRemoteTools(server, fetcher).catch((error) => {
        console.warn("MCP tools/list failed", {
          server: serverName,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });

      for (const mcpTool of listed) {
        const baseName = `mcp_${sanitizeToolName(serverName)}_${sanitizeToolName(mcpTool.name)}`;
        const name = uniqueName(baseName, usedNames);
        usedNames.add(name);
        tools.push(toToolDefinition(name, serverName, server, mcpTool));
      }
    }),
  );

  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

function toToolDefinition(
  name: string,
  serverName: string,
  server: RemoteMcpServer,
  mcpTool: McpToolDefinition,
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
      callRemoteTool(server, mcpTool.name, input, ctx.fetch ?? fetch),
  };
}

async function listRemoteTools(server: RemoteMcpServer, fetcher: typeof fetch) {
  return withMcpClient(server, fetcher, async (client, timeout) => {
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
  });
}

async function callRemoteTool(
  server: RemoteMcpServer,
  toolName: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch,
) {
  return withMcpClient(server, fetcher, async (client, timeout) => {
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
  fn: (client: Client, timeout: number) => Promise<T>,
) {
  const timeout = server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: fetcher,
    requestInit: server.headers ? { headers: server.headers } : undefined,
  });
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { timeout });
    return await fn(client, timeout);
  } finally {
    await client.close().catch(() => undefined);
  }
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

  if (result.isError) {
    throw new Error(textParts.filter(Boolean).join("\n\n") || "MCP tool returned an error.");
  }

  return {
    toolName,
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

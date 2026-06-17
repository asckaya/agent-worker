import { z } from "zod";
import { contextProvider } from "../agent/context-providers";

const MAX_MCP_SERVERS = 20;
const MAX_MCP_NAME_CHARS = 64;
const MAX_MCP_HEADERS = 20;
const MAX_MCP_HEADER_VALUE_CHARS = 4_000;
const MAX_MCP_OAUTH_CHARS = 2_000;
const McpTimeoutMsSchema = z.number().int().min(1_000).max(60_000);

export const MCP_SETTINGS_KEY = "mcp";

export const McpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MCP_NAME_CHARS)
    .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, or hyphens.");

const McpOAuthConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    clientId: z.string().trim().min(1).max(MAX_MCP_OAUTH_CHARS).optional(),
    clientSecret: z.string().max(MAX_MCP_OAUTH_CHARS).optional(),
    scope: z.string().trim().min(1).max(MAX_MCP_OAUTH_CHARS).optional(),
    redirectUri: z.string().trim().url().optional(),
    clientMetadataUrl: z.string().trim().url().optional(),
  })
  .transform((config) => ({
    enabled: config.enabled,
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    ...(config.scope ? { scope: config.scope } : {}),
    ...(config.redirectUri ? { redirectUri: config.redirectUri } : {}),
    ...(config.clientMetadataUrl ? { clientMetadataUrl: config.clientMetadataUrl } : {}),
  }));

export const RemoteMcpServerSchema = z.object({
  type: z.literal("remote").default("remote"),
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    }, "Use an HTTP or HTTPS URL."),
  headers: z
    .record(z.string().trim().min(1).max(128), z.string().max(MAX_MCP_HEADER_VALUE_CHARS))
    .optional()
    .transform((headers) =>
      headers ? Object.fromEntries(Object.entries(headers).slice(0, MAX_MCP_HEADERS)) : undefined,
    ),
  oauth: z
    .union([z.literal(false), z.literal(true), McpOAuthConfigSchema])
    .optional()
    .transform((oauth) => {
      if (oauth === undefined || oauth === false) return undefined;
      if (oauth === true) return { enabled: true };
      return oauth.enabled === false ? undefined : oauth;
    }),
  disabled: z.boolean().optional().default(false),
  timeoutMs: McpTimeoutMsSchema.optional(),
});

export const McpSettingsSchema = z
  .object({
    defaultTimeoutMs: McpTimeoutMsSchema.optional(),
    servers: z.record(McpServerNameSchema, RemoteMcpServerSchema).default({}),
  })
  .transform((settings) => ({
    ...(settings.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: settings.defaultTimeoutMs } : {}),
    servers: Object.fromEntries(Object.entries(settings.servers).slice(0, MAX_MCP_SERVERS)),
  }));

export const PublicMcpServerUpdateSchema = z.object({
  name: McpServerNameSchema,
  url: RemoteMcpServerSchema.shape.url,
  headers: RemoteMcpServerSchema.shape.headers,
  oauth: RemoteMcpServerSchema.shape.oauth,
  disabled: z.boolean().optional(),
  timeoutMs: McpTimeoutMsSchema.optional(),
});

type RemoteMcpServerOutput = z.infer<typeof RemoteMcpServerSchema>;
type McpSettingsOutput = z.infer<typeof McpSettingsSchema>;

export type RemoteMcpServer = Omit<RemoteMcpServerOutput, "oauth"> & {
  oauth?: RemoteMcpServerOutput["oauth"];
};
export type McpSettings = Omit<McpSettingsOutput, "servers"> & {
  servers: Record<string, RemoteMcpServer>;
};
export type PublicMcpServerUpdate = z.infer<typeof PublicMcpServerUpdateSchema>;

export function parseMcpSettingsPayload(payload: unknown): McpSettings {
  const result = McpSettingsSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid MCP settings", result.error));
  }
  return result.data;
}

export function parsePublicMcpServerUpdatePayload(payload: unknown): PublicMcpServerUpdate {
  const result = PublicMcpServerUpdateSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid MCP server", result.error));
  }
  return result.data;
}

export function mcpServerSummary(settings: McpSettings) {
  return {
    defaultTimeoutMs: settings.defaultTimeoutMs,
    servers: Object.entries(settings.servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => ({
        name,
        type: server.type,
        url: server.url,
        disabled: server.disabled,
        timeoutMs: server.timeoutMs,
        effectiveTimeoutMs: server.timeoutMs ?? settings.defaultTimeoutMs,
        headerNames: Object.keys(server.headers ?? {}),
        oauth: server.oauth ? {
          enabled: true,
          hasClientId: Boolean(server.oauth.clientId),
          hasClientSecret: Boolean(server.oauth.clientSecret),
          scope: server.oauth.scope,
          redirectUri: server.oauth.redirectUri,
        } : undefined,
      })),
  };
}

export function mcpContextProvider(settings: McpSettings) {
  const summary = mcpServerSummary(settings);
  if (summary.servers.length === 0) return contextProvider("mcp", () => undefined);

  return contextProvider(
    "mcp",
    () => [
      "<available_mcp_servers>",
      ...summary.servers.map((server) => [
        "  <server>",
        `    <name>${escapeXml(server.name)}</name>`,
        `    <status>${server.disabled ? "disabled" : "configured"}</status>`,
        `    <url>${escapeXml(server.url)}</url>`,
        server.effectiveTimeoutMs
          ? `    <timeout_ms>${server.effectiveTimeoutMs}</timeout_ms>`
          : "",
        server.headerNames.length
          ? `    <headers>${escapeXml(server.headerNames.join(", "))}</headers>`
          : "",
        server.oauth?.enabled
          ? `    <oauth>${server.oauth.scope ? `scope=${escapeXml(server.oauth.scope)}` : "enabled"}</oauth>`
          : "",
        "  </server>",
      ].filter(Boolean).join("\n")),
      "</available_mcp_servers>",
      "MCP tools are exposed as model tools after the server catalog is refreshed. Use get_mcp_status or refresh_mcp_tools when server/tool details are needed.",
    ].join("\n"),
  );
}

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

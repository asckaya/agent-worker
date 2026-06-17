import { z } from "zod";

const MAX_MCP_SERVERS = 20;
const MAX_MCP_NAME_CHARS = 64;
const MAX_MCP_HEADERS = 20;
const MAX_MCP_HEADER_VALUE_CHARS = 4_000;
const McpTimeoutMsSchema = z.number().int().min(1_000).max(60_000);

export const MCP_SETTINGS_KEY = "mcp";

export const McpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MCP_NAME_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, underscores, or hyphens.");

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
  disabled: z.boolean().optional(),
  timeoutMs: McpTimeoutMsSchema.optional(),
});

export type RemoteMcpServer = z.infer<typeof RemoteMcpServerSchema>;
export type McpSettings = z.infer<typeof McpSettingsSchema>;
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
      })),
  };
}

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue?.message ?? "schema error"}`;
}

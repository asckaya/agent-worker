import { z } from "zod";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const MAX_OAUTH_SERVERS = 20;
const MAX_OAUTH_STRING_CHARS = 20_000;

export const MCP_OAUTH_SETTINGS_KEY = "mcp_oauth";

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const McpOAuthServerStateSchema = z.object({
  clientInformation: JsonRecordSchema.optional(),
  tokens: JsonRecordSchema.optional(),
  codeVerifier: z.string().max(MAX_OAUTH_STRING_CHARS).optional(),
  state: z.string().max(512).optional(),
  authorizationUrl: z.string().max(MAX_OAUTH_STRING_CHARS).optional(),
  discoveryState: JsonRecordSchema.optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});

export const McpOAuthSettingsSchema = z
  .object({
    servers: z.record(z.string(), McpOAuthServerStateSchema).default({}),
  })
  .transform((settings) => ({
    servers: Object.fromEntries(Object.entries(settings.servers).slice(0, MAX_OAUTH_SERVERS)),
  }));

export type McpOAuthServerState = z.infer<typeof McpOAuthServerStateSchema>;
export type McpOAuthSettings = z.infer<typeof McpOAuthSettingsSchema>;

export function parseMcpOAuthSettingsPayload(payload: unknown): McpOAuthSettings {
  const result = McpOAuthSettingsSchema.safeParse(payload);
  if (!result.success) return { servers: {} };
  return result.data;
}

export function summarizeMcpOAuthState(state: McpOAuthServerState | undefined) {
  return {
    authorized: Boolean(state?.tokens),
    hasClientInformation: Boolean(state?.clientInformation),
    hasCodeVerifier: Boolean(state?.codeVerifier),
    authorizationUrl: state?.authorizationUrl,
    updatedAt: state?.updatedAt,
  };
}

export function asOAuthTokens(value: unknown): OAuthTokens | undefined {
  return typeof value === "object" && value !== null && typeof (value as { access_token?: unknown }).access_token === "string"
    ? value as OAuthTokens
    : undefined;
}

export function asOAuthClientInformation(value: unknown): OAuthClientInformationMixed | undefined {
  return typeof value === "object" && value !== null && typeof (value as { client_id?: unknown }).client_id === "string"
    ? value as OAuthClientInformationMixed
    : undefined;
}

export function asOAuthDiscoveryState(value: unknown): OAuthDiscoveryState | undefined {
  return typeof value === "object" && value !== null && typeof (value as { authorizationServerUrl?: unknown }).authorizationServerUrl === "string"
    ? value as OAuthDiscoveryState
    : undefined;
}

import { z } from "zod";
import type { Env, LlmConfig } from "../types";

export const LLM_SETTINGS_KEY = "llm";
export const DEFAULT_LLM_API_KEY_ENV = "LLM_API_KEY";
export const LLM_PROFILES_JSON_ENV = "LLM_PROFILES_JSON";

const MAX_LLM_PROFILES = 10;
const MAX_EXTRA_HEADERS = 10;
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
]);
const profileId = z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/);
const envBindingName = z.string().trim().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/);
const nonEmptyString = z.string().trim().min(1);
const ExtraHeadersSchema = z
  .record(z.string().trim().min(1).max(128), z.string().max(1_000))
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      if (!SECRET_HEADER_NAMES.has(name.toLowerCase())) continue;
      ctx.addIssue({
        code: "custom",
        message: "Use apiKeyEnv for secret-bearing headers.",
        path: [name],
      });
    }
  });

export const LlmProfileSchema = z.object({
  id: profileId,
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().url(),
  model: nonEmptyString.max(200),
  apiKeyEnv: envBindingName.optional().default(DEFAULT_LLM_API_KEY_ENV),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(128_000).optional(),
  extraHeaders: ExtraHeadersSchema
    .optional()
    .transform((headers) =>
      headers ? Object.fromEntries(Object.entries(headers).slice(0, MAX_EXTRA_HEADERS)) : undefined,
    ),
});

export const LlmSettingsSchema = z
  .object({
    activeProfileId: profileId,
    profiles: z.array(LlmProfileSchema).min(1).max(MAX_LLM_PROFILES),
  })
  .superRefine((settings, ctx) => {
    const ids = new Set<string>();
    for (const profile of settings.profiles) {
      if (ids.has(profile.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate LLM profile id: ${profile.id}`,
          path: ["profiles"],
        });
      }
      ids.add(profile.id);
    }
    if (!ids.has(settings.activeProfileId)) {
      ctx.addIssue({
        code: "custom",
        message: "activeProfileId must match one of the configured profile ids.",
        path: ["activeProfileId"],
      });
    }
  });

export const LlmActiveProfileRequestSchema = z.object({
  profileId: profileId,
});

export type LlmProfile = z.infer<typeof LlmProfileSchema>;
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export function parseLlmSettingsPayload(payload: unknown): LlmSettings {
  const result = LlmSettingsSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid LLM settings", result.error));
  }
  return result.data;
}

export function parseLlmActiveProfilePayload(payload: unknown): { profileId: string } {
  const result = LlmActiveProfileRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid LLM profile selection", result.error));
  }
  return result.data;
}

export function createEnvLlmSettings(env: Env): LlmSettings | null {
  const profilesJson = readEnvString(env, LLM_PROFILES_JSON_ENV);
  if (profilesJson) {
    try {
      return parseLlmSettingsPayload(JSON.parse(profilesJson));
    } catch {
      // Fall through to the single-profile env vars so a bad profile JSON
      // does not fully disable an otherwise valid deployment.
    }
  }

  const baseUrl = readEnvString(env, "LLM_BASE_URL");
  const model = readEnvString(env, "LLM_MODEL");
  if (!baseUrl || !model) return null;

  return {
    activeProfileId: "env",
    profiles: [
      {
        id: "env",
        name: "Environment default",
        baseUrl,
        model,
        apiKeyEnv: DEFAULT_LLM_API_KEY_ENV,
        temperature: parseOptionalNumber(readEnvString(env, "LLM_TEMPERATURE")),
        maxTokens: parseOptionalNumber(readEnvString(env, "LLM_MAX_TOKENS")),
        extraHeaders: undefined,
      },
    ],
  };
}

export function getActiveLlmProfile(settings: LlmSettings): LlmProfile {
  return (
    settings.profiles.find((profile) => profile.id === settings.activeProfileId) ??
    settings.profiles[0]
  );
}

export function resolveLlmConfigFromSettings(settings: LlmSettings, env: Env): LlmConfig | Error {
  const profile = getActiveLlmProfile(settings);
  const apiKey = readEnvString(env, profile.apiKeyEnv);
  if (!apiKey) {
    return new Error(`${profile.apiKeyEnv} is required for LLM profile ${profile.id}.`);
  }

  return {
    baseUrl: profile.baseUrl,
    apiKey,
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    extraHeaders: profile.extraHeaders,
  };
}

export function summarizeLlmSettings(settings: LlmSettings, env: Env) {
  return {
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      hasApiKey: Boolean(readEnvString(env, profile.apiKeyEnv)),
    })),
  };
}

function readEnvString(env: Env, key: string) {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalNumber(value: string | undefined) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return prefix;
  const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue.message}`;
}

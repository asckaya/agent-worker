import { resolveLlmConfigFromSettings, type LlmSettings } from "../llm/settings";
import type { Env, LlmConfig } from "../types";
import { parseServerLlmEnv } from "../validation";
import { fetchAgentObject } from "./agent-object";

interface LlmSettingsResponse {
  settings?: LlmSettings | null;
}

export async function resolveRequiredChannelLlm(
  env: Env,
  requestUrl: string,
  explicit: LlmConfig | undefined,
  label: string,
): Promise<LlmConfig | Error> {
  if (explicit) return explicit;

  const settings = await fetchLlmSettings(env, requestUrl);
  if (settings) {
    return resolveLlmConfigFromSettings(settings, env);
  }

  return parseServerLlmEnv(env, label);
}

export async function resolveOptionalChannelLlm(
  env: Env,
  requestUrl: string,
  explicit: LlmConfig | undefined,
): Promise<LlmConfig | undefined> {
  if (explicit) return explicit;

  const settings = await fetchLlmSettings(env, requestUrl);
  if (settings) {
    const llm = resolveLlmConfigFromSettings(settings, env);
    return llm instanceof Error ? undefined : llm;
  }

  const llm = parseServerLlmEnv(env);
  return llm instanceof Error ? undefined : llm;
}

async function fetchLlmSettings(env: Env, requestUrl: string) {
  const response = await fetchAgentObject(env, requestUrl, "/settings/llm", { method: "GET" }).catch(
    () => undefined,
  );
  if (!response) return null;
  if (!response.ok) return null;

  const body = (await response.json().catch(() => ({}))) as LlmSettingsResponse;
  return body.settings ?? null;
}

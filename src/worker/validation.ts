import { z } from "zod";
import type { ChannelSource, ChatRequest, LlmConfig, LlmModality } from "./types";

const MAX_MESSAGE_CHARS = 16_000;
const MAX_HISTORY_MESSAGES = 24;
const MAX_EXTRA_HEADERS = 10;
const MAX_TASK_TITLE_CHARS = 1_200;
const MAX_SESSION_TITLE_CHARS = 200;
const MAX_MEMORY_INPUT_CHARS = 16_000;
const MAX_CHAT_ATTACHMENTS = 4;
const MAX_ATTACHMENT_DATA_CHARS = 8 * 1024 * 1024;

const nonEmptyString = z.string().trim().min(1);
const LlmModalitySchema = z.enum(["text", "image", "audio", "pdf"]);

export const ChatContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: nonEmptyString.transform((text) => text.slice(0, MAX_MESSAGE_CHARS)),
  }),
  z.object({
    type: z.literal("image"),
    data: nonEmptyString.max(MAX_ATTACHMENT_DATA_CHARS),
    mediaType: z.string().trim().min(1).max(120).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("file"),
    data: nonEmptyString.max(MAX_ATTACHMENT_DATA_CHARS),
    mediaType: nonEmptyString.max(120),
    filename: z.string().trim().min(1).max(200).optional(),
  }),
]);

export const LlmConfigSchema = z.object({
  baseUrl: nonEmptyString,
  apiKey: nonEmptyString,
  model: nonEmptyString,
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(128_000).optional(),
  extraHeaders: z
    .record(z.string(), z.string())
    .optional()
    .transform((headers) =>
      headers ? Object.fromEntries(Object.entries(headers).slice(0, MAX_EXTRA_HEADERS)) : undefined,
    ),
  modalities: z.array(LlmModalitySchema).optional().transform(normalizeModalities),
});

export const ClientChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: nonEmptyString.transform((content) => content.slice(0, MAX_MESSAGE_CHARS)),
});

export const ChatRequestSchema = z.object({
  message: nonEmptyString.transform((message) => message.slice(0, MAX_MESSAGE_CHARS)),
  attachments: z.array(ChatContentPartSchema).optional().default([]).transform((attachments) =>
    attachments.slice(0, MAX_CHAT_ATTACHMENTS),
  ),
  history: z
    .array(ClientChatMessageSchema)
    .optional()
    .default([])
    .transform((history) => history.slice(-MAX_HISTORY_MESSAGES)),
  llm: LlmConfigSchema,
  source: z
    .object({
      channel: nonEmptyString.max(32),
      chatId: nonEmptyString.max(128),
    })
    .optional(),
  sessionId: nonEmptyString.max(64).optional(),
});

export const ChannelSourceSchema = z.object({
  channel: nonEmptyString.max(32),
  chatId: nonEmptyString.max(128),
});

export const ApprovalActionRequestSchema = z.object({
  source: ChannelSourceSchema.optional(),
  llm: LlmConfigSchema.optional(),
  approvalMode: z.enum(["once", "always"]).optional().default("once"),
});

export const SessionControlRequestSchema = z.object({
  source: ChannelSourceSchema.optional(),
  resetConversation: z.boolean().optional().default(false),
});

export const ChatSessionCreateRequestSchema = z.object({
  source: ChannelSourceSchema,
  title: z.string().trim().max(MAX_SESSION_TITLE_CHARS).optional(),
});

export const ChatSessionSwitchRequestSchema = z.object({
  source: ChannelSourceSchema,
  sessionId: nonEmptyString.max(64),
});

export const MemoryCreateRequestSchema = z.object({
  content: nonEmptyString.transform((content) => content.slice(0, MAX_MEMORY_INPUT_CHARS)),
  llm: LlmConfigSchema.optional(),
});

export const TaskCreateRequestSchema = z.object({
  source: ChannelSourceSchema,
  title: nonEmptyString.transform((title) => title.slice(0, MAX_TASK_TITLE_CHARS)),
  dueAt: z.number().int().positive().optional(),
});

export const TaskActionRequestSchema = z.object({
  source: ChannelSourceSchema.optional(),
});

const TelegramUserSchema = z
  .object({
    id: z.number().int(),
    username: z.string().optional(),
    first_name: z.string().optional(),
  })
  .optional();

const TelegramDocumentSchema = z
  .object({
    file_id: z.string().min(1),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .optional();

const TelegramPhotoSizeSchema = z
  .object({
    file_id: z.string().min(1),
    file_size: z.number().int().nonnegative().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const TelegramMediaFileSchema = z
  .object({
    file_id: z.string().min(1),
    file_name: z.string().optional(),
    mime_type: z.string().optional(),
    file_size: z.number().int().nonnegative().optional(),
    duration: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .optional();

const TelegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    text: z.string().optional(),
    caption: z.string().optional(),
    document: TelegramDocumentSchema,
    photo: z.array(TelegramPhotoSizeSchema).optional(),
    audio: TelegramMediaFileSchema,
    voice: TelegramMediaFileSchema,
    video: TelegramMediaFileSchema,
    chat: z.object({
      id: z.union([z.number().int(), z.string()]).transform(String),
      type: z.string(),
    }),
    from: TelegramUserSchema,
  })
  .passthrough();

export const TelegramUpdateSchema = z
  .object({
    message: TelegramMessageSchema.optional(),
    callback_query: z
      .object({
        id: z.string().min(1),
        data: z.string().optional(),
        from: TelegramUserSchema,
        message: TelegramMessageSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const TelegramLlmEnvSchema = z.object({
  LLM_BASE_URL: nonEmptyString,
  LLM_API_KEY: nonEmptyString,
  LLM_MODEL: nonEmptyString,
  LLM_TEMPERATURE: z.string().optional().transform(parseOptionalEnvNumber),
  LLM_MAX_TOKENS: z.string().optional().transform(parseOptionalEnvNumber),
  LLM_MODALITIES: z.string().optional().transform(parseOptionalEnvModalities),
});

export function parseChatRequestPayload(payload: unknown): ChatRequest {
  const result = ChatRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid chat request", result.error));
  }
  return result.data;
}

export function parseApprovalActionPayload(payload: unknown): {
  source?: ChannelSource;
  llm?: LlmConfig;
  approvalMode: "once" | "always";
} {
  const result = ApprovalActionRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid approval request", result.error));
  }
  return result.data;
}

export function parseSessionControlPayload(payload: unknown): {
  source?: ChannelSource;
  resetConversation: boolean;
} {
  const result = SessionControlRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid session control request", result.error));
  }
  return result.data;
}

export function parseChatSessionCreatePayload(payload: unknown): {
  source: ChannelSource;
  title?: string;
} {
  const result = ChatSessionCreateRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid chat session request", result.error));
  }
  return result.data;
}

export function parseChatSessionSwitchPayload(payload: unknown): {
  source: ChannelSource;
  sessionId: string;
} {
  const result = ChatSessionSwitchRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid chat session request", result.error));
  }
  return result.data;
}

export function parseMemoryCreatePayload(payload: unknown): {
  content: string;
  llm?: LlmConfig;
} {
  const result = MemoryCreateRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid memory request", result.error));
  }
  return result.data;
}

export function parseTaskCreatePayload(payload: unknown): {
  source: ChannelSource;
  title: string;
  dueAt?: number;
} {
  const result = TaskCreateRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid task request", result.error));
  }
  return result.data;
}

export function parseTaskActionPayload(payload: unknown): {
  source?: ChannelSource;
} {
  const result = TaskActionRequestSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid task action request", result.error));
  }
  return result.data;
}

export function parseTelegramLlmEnv(env: unknown): LlmConfig | Error {
  return parseServerLlmEnv(env, "Telegram");
}

export function parseServerLlmEnv(env: unknown, label = "Channel"): LlmConfig | Error {
  const result = TelegramLlmEnvSchema.safeParse(env);
  if (!result.success) {
    return new Error(`LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required for ${label}.`);
  }

  return {
    baseUrl: result.data.LLM_BASE_URL,
    apiKey: result.data.LLM_API_KEY,
    model: result.data.LLM_MODEL,
    temperature: result.data.LLM_TEMPERATURE,
    maxTokens: result.data.LLM_MAX_TOKENS,
    ...(result.data.LLM_MODALITIES ? { modalities: result.data.LLM_MODALITIES } : {}),
  };
}

function parseOptionalEnvNumber(value: string | undefined) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseOptionalEnvModalities(value: string | undefined): LlmModality[] | undefined {
  if (!value) return undefined;
  return normalizeModalities(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(isLlmModality),
  );
}

function normalizeModalities(value: LlmModality[] | undefined) {
  if (!value?.length) return undefined;
  return [...new Set(value)];
}

function isLlmModality(value: string): value is LlmModality {
  return value === "text" || value === "image" || value === "audio" || value === "pdf";
}

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return prefix;
  const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue.message}`;
}

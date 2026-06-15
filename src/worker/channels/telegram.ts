import { parseSlashCommand, type SlashCommand } from "./commands";
import { fetchAgentObject } from "./agent-object";
import { resolveRequiredChannelLlm } from "./llm-config";
import { readServerSentEvents } from "./sse";
import type { AgentStreamEvent, ChannelAdapter, ChannelCapabilities } from "./types";
import type {
  ActiveAgentRun,
  ChatContentPart,
  Env,
  LlmConfig,
  LlmModality,
  PendingToolApproval,
  StoredMemory,
  StoredTask,
} from "../types";
import { parseTelegramLlmEnv, TelegramUpdateSchema } from "../validation";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_TELEGRAM_TEXT = 4096;
const TELEGRAM_EDIT_INTERVAL_MS = 900;
const TELEGRAM_EDIT_MAX_INTERVAL_MS = 10_000;
const TELEGRAM_EDIT_MIN_CHARS = 80;
const TELEGRAM_DRAFT_INTERVAL_MS = 650;
const TELEGRAM_DRAFT_MIN_CHARS = 40;
const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const TELEGRAM_STREAM_CURSOR = " ▌";
const TELEGRAM_FRESH_FINAL_AFTER_MS = 60_000;
const TELEGRAM_APPROVAL_CALLBACK_PREFIX = "agent-worker";
const TELEGRAM_TEXT_BATCH_DEFAULT_MS = 180;
const TELEGRAM_TEXT_BATCH_MAX_MS = 1_000;
const TELEGRAM_TEXT_BATCH_MAX_MESSAGES = 6;
const TELEGRAM_TEXT_BATCH_MAX_CHARS = 16_000;
const TELEGRAM_FILE_MAX_BYTES = 256 * 1024;
const TELEGRAM_FILE_MAX_TEXT_CHARS = 12_000;
const TELEGRAM_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
const TELEGRAM_DEFAULT_TIME_ZONE = "Asia/Shanghai";
const MUTATING_COMMANDS = new Set([
  "approve",
  "deny",
  "forget",
  "remember",
  "stop",
  "new",
  "reset",
  "llmuse",
  "remind",
  "task",
  "todo",
  "done",
]);

type TelegramStreamTransport = "auto" | "draft" | "edit" | "off";
type TelegramStreamMode = "draft" | "edit" | "off";
type TelegramParseMode = "MarkdownV2";

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhotoSize[];
  audio?: TelegramMediaFile;
  voice?: TelegramMediaFile;
  video?: TelegramMediaFile;
  chat: {
    id: string;
    type: string;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramMediaFile extends TelegramDocument {
  duration?: number;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
}

interface IncomingTelegramText {
  chatId: string;
  chatType: string;
  fromUserId?: string;
  messageId: number;
  text: string;
  attachments?: ChatContentPart[];
}

interface IncomingTelegramCallback extends IncomingTelegramText {
  callbackQueryId: string;
  action: TelegramCallbackAction;
}

interface IncomingTelegramFile {
  chatId: string;
  chatType: string;
  fromUserId?: string;
  messageId: number;
  kind: "document" | "photo" | "audio" | "voice" | "video";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
}

type TelegramCallbackAction =
  | { kind: "approval"; action: "approve" | "deny"; approvalId: string }
  | { kind: "menu"; view: "home" | "status" | "llm" | "memory" | "tasks" | "pending" | "stop" }
  | { kind: "memory_delete"; memoryId: string }
  | { kind: "task_done"; taskId: string };
interface TelegramCallbackParseResult {
  action: TelegramCallbackAction;
  text: string;
}

interface TelegramApiResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramSentMessage {
  message_id: number;
}

interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface TelegramFinishOptions {
  replyMarkup?: TelegramReplyMarkup;
  parseMode?: TelegramParseMode;
}

interface AgentStateResponse {
  memories?: StoredMemory[];
  tasks?: StoredTask[];
  pendingApprovals?: PendingToolApproval[];
  activeRuns?: ActiveAgentRun[];
  llm?: LlmSettingsResponse["summary"] & { source?: string };
}

interface LlmSettingsSummaryProfile {
  id: string;
  name?: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  hasApiKey: boolean;
  temperature?: number;
  maxTokens?: number;
  modalities?: LlmModality[];
}

interface LlmSettingsResponse {
  source?: string;
  summary?: {
    activeProfileId?: string;
    profiles?: LlmSettingsSummaryProfile[];
  };
}

interface TelegramTextBatch {
  env: Env;
  requestUrl: string;
  messages: IncomingTelegramText[];
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  flushing: boolean;
}

const telegramTextBatches = new Map<string, TelegramTextBatch>();

export const telegramCapabilities: ChannelCapabilities = {
  name: "telegram",
  typedCommandPrefix: "/",
  maxMessageLength: MAX_TELEGRAM_TEXT,
  supportsMessageEditing: true,
  supportsDraftStreaming: true,
  supportsToolApprovalCommands: true,
};

export const telegramChannel: ChannelAdapter = {
  name: "telegram",
  capabilities: telegramCapabilities,
  handleWebhook: handleTelegramWebhook,
};

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) {
  if (!isTelegramSecretValid(request, env)) {
    return Response.json({ ok: false, error: "Invalid Telegram secret token." }, { status: 401 });
  }

  const updateResult = TelegramUpdateSchema.safeParse(await request.json().catch(() => ({})));
  if (!updateResult.success) {
    return Response.json({ ok: true, ignored: "invalid_update" });
  }

  const update = updateResult.data as TelegramUpdate;
  const callback = extractTelegramCallback(update);
  const incoming = extractTelegramText(update);
  const incomingFile = extractTelegramFile(update);
  if (!callback && !incoming && !incomingFile) {
    return Response.json({ ok: true, ignored: "unsupported_update" });
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured." },
      { status: 500 },
    );
  }

  if (callback) {
    if (!isChatAllowed(callback.chatId, env)) {
      await answerTelegramCallbackQuery(env, callback.callbackQueryId, "This chat is not allowed.");
      return Response.json({ ok: true, ignored: "chat_not_allowed" });
    }

    const work = handleTelegramCallbackQuery(request.url, env, callback).catch(
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Telegram callback failed.";
        await answerTelegramCallbackQuery(env, callback.callbackQueryId, message);
      },
    );

    if (ctx) {
      ctx.waitUntil(work);
      return Response.json({ ok: true, accepted: true });
    }

    await work;
    return Response.json({ ok: true });
  }

  if (!incoming) {
    if (!incomingFile) {
      return Response.json({ ok: true, ignored: "unsupported_update" });
    }

    if (!isChatAllowed(incomingFile.chatId, env)) {
      return Response.json({ ok: true, ignored: "chat_not_allowed" });
    }

    const work = handleAllowedTelegramFile(request.url, env, incomingFile).catch(
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Telegram file request failed.";
        await sendTelegramMessage(env, incomingFile.chatId, `Error: ${message}`, incomingFile.messageId);
      },
    );

    if (ctx) {
      ctx.waitUntil(work);
      return Response.json({ ok: true, accepted: true });
    }

    await work;
    return Response.json({ ok: true });
  }

  const command = parseSlashCommand(incoming.text);
  if (command?.name === "id") {
    await sendTelegramMessage(env, incoming.chatId, `chat id: ${incoming.chatId}`, incoming.messageId);
    return Response.json({ ok: true });
  }

  if (!isChatAllowed(incoming.chatId, env)) {
    if (command?.name === "start") {
      await sendTelegramMessage(
        env,
        incoming.chatId,
        `This chat is not allowed. Add ${incoming.chatId} to TELEGRAM_ALLOWED_CHAT_IDS.`,
        incoming.messageId,
      );
    }
    return Response.json({ ok: true, ignored: "chat_not_allowed" });
  }

  const work = handleAllowedTelegramMessage(request.url, env, incoming, command).catch(
    async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Telegram request failed.";
      await sendTelegramMessage(env, incoming.chatId, `Error: ${message}`, incoming.messageId);
    },
  );

  if (ctx) {
    ctx.waitUntil(work);
    return Response.json({ ok: true, accepted: true });
  }

  await work;
  return Response.json({ ok: true });
}

export function isTelegramSecretValid(request: Request, env: Env) {
  const expected = env.TELEGRAM_SECRET_TOKEN?.trim();
  if (!expected) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === expected;
}

export function isChatAllowed(chatId: string, env: Env) {
  if (env.TELEGRAM_ALLOW_ALL_CHATS === "true") return true;
  return parseAllowedChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS).has(chatId);
}

export function parseAllowedChatIds(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function parseTelegramAdminUserIds(value: string | undefined) {
  return parseAllowedChatIds(value);
}

export function canRunTelegramCommand(
  command: SlashCommand | null,
  incoming: Pick<IncomingTelegramText, "fromUserId">,
  env: Env,
) {
  if (!command || !MUTATING_COMMANDS.has(command.name)) return true;

  const adminUserIds = parseTelegramAdminUserIds(env.TELEGRAM_ADMIN_USER_IDS);
  if (adminUserIds.size === 0) return true;

  return typeof incoming.fromUserId === "string" && adminUserIds.has(incoming.fromUserId);
}

export function buildTelegramLlmConfig(env: Env): LlmConfig | Error {
  return parseTelegramLlmEnv(env);
}

async function handleTelegramCallbackQuery(
  requestUrl: string,
  env: Env,
  callback: IncomingTelegramCallback,
) {
  const command = parseSlashCommand(callback.text);
  if (!canRunTelegramCommand(command, callback, env)) {
    await answerTelegramCallbackQuery(
      env,
      callback.callbackQueryId,
      "This action requires a Telegram admin user.",
      true,
    );
    return;
  }

  if (callback.action.kind === "approval") {
    await handleApprovalCallback(requestUrl, env, callback, command);
    return;
  }

  if (callback.action.kind === "menu") {
    await handleMenuCallback(requestUrl, env, callback);
    return;
  }

  if (callback.action.kind === "memory_delete") {
    await deleteMemoryById(env, requestUrl, callback.action.memoryId);
    await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Memory deleted.");
    await editTelegramMessage(
      env,
      callback.chatId,
      callback.messageId,
      await memoryText(env, requestUrl),
      { replyMarkup: await memoryReplyMarkup(env, requestUrl) },
    );
    return;
  }

  await completeTaskById(env, requestUrl, callback.chatId, callback.action.taskId);
  await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Task done.");
  await editTelegramMessage(
    env,
    callback.chatId,
    callback.messageId,
    await tasksText(env, requestUrl, callback.chatId),
    { replyMarkup: await tasksReplyMarkup(env, requestUrl, callback.chatId) },
  );
}

async function handleApprovalCallback(
  requestUrl: string,
  env: Env,
  callback: IncomingTelegramCallback,
  command: SlashCommand | null,
) {
  if (callback.action.kind !== "approval") return;
  const approvalAction = callback.action;

  if (approvalAction.action === "deny") {
    try {
      await denyApproval(env, requestUrl, callback.chatId, approvalAction.approvalId);
      await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Denied.");
      await editTelegramMessage(
        env,
        callback.chatId,
        callback.messageId,
        `Denied approval: ${approvalAction.approvalId}`,
        { replyMarkup: emptyTelegramInlineKeyboard() },
      );
    } catch (error) {
      await answerTelegramCallbackQuery(
        env,
        callback.callbackQueryId,
        callbackErrorMessage(error),
        true,
      );
      await editTelegramMessage(
        env,
        callback.chatId,
        callback.messageId,
        `Approval failed: ${callbackErrorMessage(error)}`,
        { replyMarkup: emptyTelegramInlineKeyboard() },
      ).catch(() => undefined);
    }
    return;
  }

  await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Approved. Running tool...");
  await editTelegramMessage(
    env,
    callback.chatId,
    callback.messageId,
    `Approved: ${approvalAction.approvalId}\nRunning tool...`,
    { replyMarkup: emptyTelegramInlineKeyboard() },
  );
  try {
    await handleApproveCommand(env, requestUrl, callback, command ?? {
      name: "approve",
      args: approvalAction.approvalId,
      raw: callback.text,
      botName: undefined,
    });
  } catch (error) {
    await editTelegramMessage(
      env,
      callback.chatId,
      callback.messageId,
      `Approval failed: ${callbackErrorMessage(error)}`,
      { replyMarkup: emptyTelegramInlineKeyboard() },
    ).catch(() => undefined);
  }
}

async function handleMenuCallback(
  requestUrl: string,
  env: Env,
  callback: IncomingTelegramCallback,
) {
  if (callback.action.kind !== "menu") return;
  const view = callback.action.view;

  if (view === "stop") {
    const response = await stopTelegramRun(env, requestUrl, callback.chatId);
    await answerTelegramCallbackQuery(
      env,
      callback.callbackQueryId,
      response.stopped ? "Stopped." : "No active response.",
    );
    await editTelegramMessage(
      env,
      callback.chatId,
      callback.messageId,
      response.stopped ? "Stopped active response." : "No active response in this chat.",
      { replyMarkup: telegramMenuReplyMarkup() },
    );
    return;
  }

  await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Updated.");
  await editTelegramMessage(
    env,
    callback.chatId,
    callback.messageId,
    await menuViewText(env, requestUrl, callback.chatId, view),
    { replyMarkup: await menuViewReplyMarkup(env, requestUrl, callback.chatId, view) },
  );
}

async function handleAllowedTelegramMessage(
  requestUrl: string,
  env: Env,
  incoming: IncomingTelegramText,
  command: SlashCommand | null,
) {
  if (!canRunTelegramCommand(command, incoming, env)) {
    await sendTelegramMessage(
      env,
      incoming.chatId,
      "This command requires a Telegram admin user.",
      incoming.messageId,
    );
    return;
  }

  switch (command?.name) {
    case "start":
    case "help":
      await sendTelegramMessage(env, incoming.chatId, helpText(), incoming.messageId);
      return;
    case "menu":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        menuHomeText(),
        incoming.messageId,
        { replyMarkup: telegramMenuReplyMarkup() },
      );
      return;
    case "status":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        await statusText(env, requestUrl),
        incoming.messageId,
      );
      return;
    case "memory":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        await memoryText(env, requestUrl),
        incoming.messageId,
        { replyMarkup: await memoryReplyMarkup(env, requestUrl) },
      );
      return;
    case "remember":
      await handleRememberCommand(env, requestUrl, incoming, command);
      return;
    case "task":
    case "todo":
      await handleTaskCommand(env, requestUrl, incoming, command);
      return;
    case "remind":
      await handleRemindCommand(env, requestUrl, incoming, command);
      return;
    case "tasks":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        await tasksText(env, requestUrl, incoming.chatId),
        incoming.messageId,
        { replyMarkup: await tasksReplyMarkup(env, requestUrl, incoming.chatId) },
      );
      return;
    case "done":
      await handleDoneCommand(env, requestUrl, incoming, command);
      return;
    case "llm":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        await llmSettingsText(env, requestUrl),
        incoming.messageId,
      );
      return;
    case "llmuse":
      await handleLlmUseCommand(env, requestUrl, incoming, command);
      return;
    case "llmtest":
      await handleLlmTestCommand(env, requestUrl, incoming);
      return;
    case "forget":
      await handleForgetCommand(env, requestUrl, incoming, command);
      return;
    case "pending":
      await sendTelegramMessage(
        env,
        incoming.chatId,
        await pendingApprovalsText(env, requestUrl, incoming.chatId),
        incoming.messageId,
      );
      return;
    case "stop":
    case "new":
    case "reset":
      await handleStopCommand(env, requestUrl, incoming, command.name);
      return;
    case "approve":
      await handleApproveCommand(env, requestUrl, incoming, command);
      return;
    case "deny":
      await handleDenyCommand(env, requestUrl, incoming, command);
      return;
    default:
      if (command) {
        await sendTelegramMessage(env, incoming.chatId, `Unknown command: /${command.name}`, incoming.messageId);
        return;
      }
      await enqueueTelegramAgentMessage(env, requestUrl, incoming);
  }
}

function helpText() {
  return [
    "Agent Worker is connected.",
    "",
    "Commands:",
    "/menu - show inline action menu",
    "/status - show runtime status",
    "/memory - list saved memories",
    "/remember <text> - save a memory",
    "/task <text> - add a task",
    "/remind <when> <text> - add a reminder",
    "/tasks - list pending tasks",
    "/done <task_id> - mark a task done",
    "/llm - show LLM profiles",
    "/llmuse <profile_id> - switch active LLM profile",
    "/llmtest - test the active LLM profile",
    "/forget <memory_id> - delete a memory",
    "/pending - list pending tool approvals",
    "/approve <id> - approve a pending tool call",
    "/deny <id> - deny a pending tool call",
    "/stop - cancel the active response in this chat",
    "/new or /reset - stop the active response; no chat history is persisted",
    "/id - show this Telegram chat id",
    "",
    "Normal messages are not stored as chat history. Only bounded memory is persisted.",
  ].join("\n");
}

async function statusText(env: Env, requestUrl: string) {
  const state = await fetchAgentState(env, requestUrl);
  const activeLlm = activeLlmProfileLabel(state.llm);
  const queuedFollowUps =
    state.activeRuns?.reduce((total, run) => total + run.queuedMessageCount, 0) ?? 0;
  return [
    "Status: ok",
    `Model: ${activeLlm}`,
    `Memories: ${state.memories?.length ?? 0}`,
    `Tasks: ${state.tasks?.filter((task) => task.status === "pending").length ?? 0}`,
    `Pending approvals: ${state.pendingApprovals?.length ?? 0}`,
    `Active runs: ${state.activeRuns?.length ?? 0}`,
    `Queued follow-ups: ${queuedFollowUps}`,
  ].join("\n");
}

function menuHomeText() {
  return "Agent menu";
}

async function menuViewText(
  env: Env,
  requestUrl: string,
  chatId: string,
  view: Extract<TelegramCallbackAction, { kind: "menu" }>["view"],
) {
  switch (view) {
    case "status":
      return statusText(env, requestUrl);
    case "llm":
      return llmSettingsText(env, requestUrl);
    case "memory":
      return memoryText(env, requestUrl);
    case "tasks":
      return tasksText(env, requestUrl, chatId);
    case "pending":
      return pendingApprovalsText(env, requestUrl, chatId);
    case "home":
    case "stop":
      return menuHomeText();
  }
}

async function menuViewReplyMarkup(
  env: Env,
  requestUrl: string,
  chatId: string,
  view: Extract<TelegramCallbackAction, { kind: "menu" }>["view"],
) {
  if (view === "memory") return memoryReplyMarkup(env, requestUrl);
  if (view === "tasks") return tasksReplyMarkup(env, requestUrl, chatId);
  return telegramMenuReplyMarkup();
}

function telegramMenuReplyMarkup(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        telegramButton("Status", "menu:status"),
        telegramButton("LLM", "menu:llm"),
      ],
      [
        telegramButton("Memory", "menu:memory"),
        telegramButton("Tasks", "menu:tasks"),
      ],
      [
        telegramButton("Pending", "menu:pending"),
        telegramButton("Stop", "menu:stop"),
      ],
    ],
  };
}

async function memoryText(env: Env, requestUrl: string) {
  const state = await fetchAgentState(env, requestUrl);
  const memories = state.memories ?? [];
  if (memories.length === 0) return "No saved memories.";

  return memories
    .slice(0, 12)
    .map((memory) => `${memory.id}: ${memory.content}`)
    .join("\n\n");
}

async function memoryReplyMarkup(env: Env, requestUrl: string) {
  const state = await fetchAgentState(env, requestUrl);
  const memories = (state.memories ?? []).slice(0, 10);
  if (memories.length === 0) return telegramMenuReplyMarkup();
  return {
    inline_keyboard: [
      ...memories.map((memory) => [
        telegramButton(`Delete ${shortId(memory.id)}`, `memdel:${memory.id}`),
      ]),
      [telegramButton("Back", "menu:home")],
    ],
  };
}

async function handleRememberCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const content = command.args.trim();
  if (!content) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /remember <text>", incoming.messageId);
    return;
  }

  const response = await fetchAgentObject(env, requestUrl, "/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    memory?: StoredMemory;
    error?: string;
  };
  if (!response.ok || body.error) {
    throw new Error(body.error || `Memory save failed: ${response.status}`);
  }

  await sendTelegramMessage(
    env,
    incoming.chatId,
    `Saved memory: ${body.memory?.id ?? "ok"}`,
    incoming.messageId,
  );
}

async function llmSettingsText(env: Env, requestUrl: string) {
  const settings = await fetchLlmSettings(env, requestUrl);
  const summary = settings.summary;
  const profiles = summary?.profiles ?? [];
  if (profiles.length === 0) {
    return "No LLM profiles are configured.";
  }

  return [
    `LLM settings: ${settings.source ?? "unknown"}`,
    `Active: ${summary?.activeProfileId ?? "unknown"}`,
    "",
    ...profiles.map((profile) => {
      const active = profile.id === summary?.activeProfileId ? "active" : "available";
      const key = profile.hasApiKey ? "key configured" : `missing ${profile.apiKeyEnv}`;
      const limits = [
        typeof profile.temperature === "number" ? `temperature=${profile.temperature}` : "",
        typeof profile.maxTokens === "number" ? `maxTokens=${profile.maxTokens}` : "",
      ].filter(Boolean);
      return [
        `${profile.id} (${active})`,
        profile.name ? `name: ${profile.name}` : "",
        `model: ${profile.model}`,
        `baseUrl: ${profile.baseUrl}`,
        `modalities: ${profile.modalities?.join(", ") || "text"}`,
        `secret: ${profile.apiKeyEnv} (${key})`,
        limits.join(", "),
      ].filter(Boolean).join("\n");
    }),
    "",
    "Use /llmuse <profile_id> to switch profiles.",
  ].join("\n");
}

async function handleLlmUseCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const profileId = firstArg(command.args);
  if (!profileId) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /llmuse <profile_id>", incoming.messageId);
    return;
  }

  const response = await fetchAgentObject(env, requestUrl, "/settings/llm/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error || `LLM profile switch failed: ${response.status}`);
  }

  await sendTelegramMessage(env, incoming.chatId, `Active LLM profile: ${profileId}`, incoming.messageId);
}

async function handleLlmTestCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
) {
  const response = await fetchAgentObject(env, requestUrl, "/settings/llm/test", {
    method: "POST",
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    profileId?: string;
    model?: string;
    content?: string;
    error?: string;
  };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `LLM test failed: ${response.status}`);
  }

  await sendTelegramMessage(
    env,
    incoming.chatId,
    [`LLM test ok: ${body.profileId ?? "unknown"}`, `Model: ${body.model ?? "unknown"}`, body.content ?? ""]
      .filter(Boolean)
      .join("\n"),
    incoming.messageId,
  );
}

async function pendingApprovalsText(env: Env, requestUrl: string, chatId: string) {
  const approvals = await fetchPendingApprovals(env, requestUrl, chatId);
  if (approvals.length === 0) return "No pending approvals.";

  return approvals.map(formatPendingApproval).join("\n\n");
}

async function tasksText(env: Env, requestUrl: string, chatId: string) {
  const tasks = await fetchTasks(env, requestUrl, chatId, "pending");
  if (tasks.length === 0) return "No pending tasks.";

  return tasks
    .slice(0, 20)
    .map((task) => formatTask(task, env.TELEGRAM_TIME_ZONE))
    .join("\n\n");
}

async function tasksReplyMarkup(env: Env, requestUrl: string, chatId: string) {
  const tasks = await fetchTasks(env, requestUrl, chatId, "pending");
  if (tasks.length === 0) return telegramMenuReplyMarkup();
  return {
    inline_keyboard: [
      ...tasks.slice(0, 10).map((task) => [
        telegramButton(`Done ${shortId(task.id)}`, `tdone:${task.id}`),
      ]),
      [telegramButton("Back", "menu:home")],
    ],
  };
}

async function handleTaskCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const title = command.args.trim();
  if (!title) {
    await sendTelegramMessage(env, incoming.chatId, `Usage: /${command.name} <text>`, incoming.messageId);
    return;
  }

  const task = await createTask(env, requestUrl, incoming.chatId, title);
  await sendTelegramMessage(
    env,
    incoming.chatId,
    `Task added: ${task.id}`,
    incoming.messageId,
    { replyMarkup: await tasksReplyMarkup(env, requestUrl, incoming.chatId) },
  );
}

async function handleRemindCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const parsed = parseTelegramReminderArgs(
    command.args,
    Date.now(),
    env.TELEGRAM_TIME_ZONE || TELEGRAM_DEFAULT_TIME_ZONE,
  );
  if (parsed instanceof Error) {
    await sendTelegramMessage(env, incoming.chatId, parsed.message, incoming.messageId);
    return;
  }

  const task = await createTask(env, requestUrl, incoming.chatId, parsed.title, parsed.dueAt);
  await sendTelegramMessage(
    env,
    incoming.chatId,
    [
      `Reminder added: ${task.id}`,
      `Due: ${formatTimestamp(task.due_at, env.TELEGRAM_TIME_ZONE)}`,
    ].join("\n"),
    incoming.messageId,
  );
}

async function handleDoneCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const taskId = firstArg(command.args);
  if (!taskId) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /done <task_id>", incoming.messageId);
    return;
  }

  await completeTaskById(env, requestUrl, incoming.chatId, taskId);
  await sendTelegramMessage(env, incoming.chatId, `Task done: ${taskId}`, incoming.messageId);
}

async function handleForgetCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const memoryId = firstArg(command.args);
  if (!memoryId) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /forget <memory_id>", incoming.messageId);
    return;
  }

  await deleteMemoryById(env, requestUrl, memoryId);

  await sendTelegramMessage(env, incoming.chatId, `Deleted memory: ${memoryId}`, incoming.messageId);
}

async function handleApproveCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const approvalId = firstArg(command.args);
  if (!approvalId) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /approve <id>", incoming.messageId);
    return;
  }

  const llm = await resolveRequiredChannelLlm(env, requestUrl, undefined, "Telegram");
  await streamAgentEndpointToTelegram(
    env,
    requestUrl,
    incoming,
    `/approvals/${encodeURIComponent(approvalId)}/approve-stream`,
    {
      source: { channel: "telegram", chatId: incoming.chatId },
      ...(llm instanceof Error ? {} : { llm }),
    },
    "Approving...",
  );
}

async function handleStopCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  commandName: string,
) {
  const body = await stopTelegramRun(env, requestUrl, incoming.chatId);
  const label = commandName === "stop" ? "Stopped active response." : "Started a fresh turn.";
  await sendTelegramMessage(
    env,
    incoming.chatId,
    body.stopped ? label : "No active response in this chat.",
    incoming.messageId,
  );
}

async function stopTelegramRun(env: Env, requestUrl: string, chatId: string) {
  const response = await fetchAgentObject(env, requestUrl, "/sessions/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { channel: "telegram", chatId },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    stopped?: boolean;
    error?: string;
  };
  if (!response.ok || body.error) {
    throw new Error(body.error || `Stop failed: ${response.status}`);
  }

  return body;
}

async function handleDenyCommand(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  command: SlashCommand,
) {
  const approvalId = firstArg(command.args);
  if (!approvalId) {
    await sendTelegramMessage(env, incoming.chatId, "Usage: /deny <id>", incoming.messageId);
    return;
  }

  await denyApproval(env, requestUrl, incoming.chatId, approvalId);

  await sendTelegramMessage(env, incoming.chatId, `Denied approval: ${approvalId}`, incoming.messageId);
}

async function denyApproval(
  env: Env,
  requestUrl: string,
  chatId: string,
  approvalId: string,
) {
  const response = await fetchAgentObject(
    env,
    requestUrl,
    `/approvals/${encodeURIComponent(approvalId)}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { channel: "telegram", chatId },
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error || `Deny failed: ${response.status}`);
  }
}

async function enqueueTelegramAgentMessage(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
) {
  const delayMs = resolveTelegramTextBatchDelayMs(env.TELEGRAM_TEXT_BATCH_MS);
  if (delayMs <= 0) {
    await handleAgentMessage(env, requestUrl, incoming);
    return;
  }

  const key = telegramTextBatchKey(incoming);
  let batch = telegramTextBatches.get(key);
  if (!batch || batch.flushing) {
    batch = createTelegramTextBatch(env, requestUrl);
    telegramTextBatches.set(key, batch);
  }

  batch.env = env;
  batch.requestUrl = requestUrl;
  batch.messages.push(incoming);

  if (shouldFlushTelegramTextBatch(batch)) {
    scheduleTelegramTextBatchFlush(key, 0);
  } else {
    scheduleTelegramTextBatchFlush(key, delayMs);
  }

  await batch.promise;
}

function createTelegramTextBatch(env: Env, requestUrl: string): TelegramTextBatch {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    env,
    requestUrl,
    messages: [],
    promise,
    resolve,
    reject,
    flushing: false,
  };
}

function scheduleTelegramTextBatchFlush(key: string, delayMs: number) {
  const batch = telegramTextBatches.get(key);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    void flushTelegramTextBatch(key);
  }, delayMs);
}

async function flushTelegramTextBatch(key: string) {
  const batch = telegramTextBatches.get(key);
  if (!batch || batch.flushing) return;

  batch.flushing = true;
  if (batch.timer) clearTimeout(batch.timer);
  telegramTextBatches.delete(key);

  try {
    await handleAgentMessage(
      batch.env,
      batch.requestUrl,
      mergeTelegramTextBatchMessages(batch.messages),
    );
    batch.resolve();
  } catch (error) {
    batch.reject(error);
  }
}

async function handleAgentMessage(env: Env, requestUrl: string, incoming: IncomingTelegramText) {
  const llm = await resolveRequiredChannelLlm(env, requestUrl, undefined, "Telegram");
  if (llm instanceof Error) {
    await sendTelegramMessage(env, incoming.chatId, llm.message, incoming.messageId);
    return;
  }

  await streamAgentEndpointToTelegram(
    env,
    requestUrl,
    incoming,
    "/chat",
    {
      message: incoming.text,
      ...(incoming.attachments?.length ? { attachments: incoming.attachments } : {}),
      llm,
      source: { channel: "telegram", chatId: incoming.chatId },
    },
    "Thinking...",
  );
}

async function handleAllowedTelegramFile(
  requestUrl: string,
  env: Env,
  incoming: IncomingTelegramFile,
) {
  const classification = classifyTelegramFile(incoming);
  if (classification instanceof Error) {
    await sendTelegramMessage(env, incoming.chatId, classification.message, incoming.messageId);
    return;
  }

  const llm = await resolveRequiredChannelLlm(env, requestUrl, undefined, "Telegram");
  if (llm instanceof Error) {
    await sendTelegramMessage(env, incoming.chatId, llm.message, incoming.messageId);
    return;
  }

  if (classification.kind !== "text" && !llmSupportsModality(llm, classification.modality)) {
    await sendTelegramMessage(
      env,
      incoming.chatId,
      unsupportedModalityMessage(classification.modality, llm),
      incoming.messageId,
    );
    return;
  }

  const downloaded = await downloadTelegramFileBytes(env, incoming, classification.maxBytes);
  if (classification.kind === "text") {
    const fileText = new TextDecoder("utf-8", { fatal: false }).decode(downloaded.bytes);
    const message = formatTelegramFilePrompt(incoming, fileText);
    await streamAgentEndpointToTelegram(
      env,
      requestUrl,
      {
        chatId: incoming.chatId,
        chatType: incoming.chatType,
        fromUserId: incoming.fromUserId,
        messageId: incoming.messageId,
        text: message,
      },
      "/chat",
      {
        message,
        llm,
        source: { channel: "telegram", chatId: incoming.chatId },
      },
      "Reading file...",
    );
    return;
  }

  const attachment = telegramFileAttachment(incoming, classification, downloaded.bytes);
  const message = formatTelegramMediaPrompt(incoming, classification);
  await streamAgentEndpointToTelegram(
    env,
    requestUrl,
    {
      chatId: incoming.chatId,
      chatType: incoming.chatType,
      fromUserId: incoming.fromUserId,
      messageId: incoming.messageId,
      text: message,
      attachments: [attachment],
    },
    "/chat",
    {
      message,
      attachments: [attachment],
      llm,
      source: { channel: "telegram", chatId: incoming.chatId },
    },
    "Reading file...",
  );
}

async function streamAgentEndpointToTelegram(
  env: Env,
  requestUrl: string,
  incoming: IncomingTelegramText,
  pathname: string,
  payload: unknown,
  placeholderText: string,
) {
  const typing = startTelegramTypingLoop(env, incoming.chatId);
  const stream = await TelegramStreamingResponder.create(env, incoming, placeholderText);

  try {
    const response = await fetchAgentObject(env, requestUrl, pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Agent stream failed: ${response.status} ${text}`.trim());
    }

    let doneContent: string | undefined;
    let finishOptions: TelegramFinishOptions = {};
    for await (const event of readServerSentEvents(response)) {
      const next = await applyAgentStreamEventToTelegram(stream, event, doneContent);
      doneContent = next.doneContent;
      finishOptions = {
        ...finishOptions,
        ...next.finishOptions,
      };
    }

    await stream.finish(doneContent, withFinalTelegramFormatting(finishOptions));
  } finally {
    typing.stop();
  }
}

async function applyAgentStreamEventToTelegram(
  stream: TelegramStreamingResponder,
  event: AgentStreamEvent,
  doneContent: string | undefined,
): Promise<{ doneContent: string | undefined; finishOptions?: TelegramFinishOptions }> {
  switch (event.event) {
    case "message_delta":
      await stream.append(event.data.delta);
      return { doneContent };
    case "approval_required":
      await stream.appendParagraph(event.data.message ?? "");
      return {
        doneContent,
        finishOptions: telegramApprovalFinishOptions(event.data.approval),
      };
    case "message_stop":
      return { doneContent: event.data.content ?? doneContent };
    case "done":
      return {
        doneContent: typeof event.data.content === "string" ? event.data.content : doneContent,
      };
    case "error":
      throw new Error(event.data.message);
    default:
      return { doneContent };
  }
}

class TelegramStreamingResponder {
  private content = "";
  private editStream: TelegramEditStream | undefined;
  private readonly draftStream: TelegramDraftStream | undefined;

  private constructor(
    private readonly env: Env,
    private readonly incoming: IncomingTelegramText,
    private readonly placeholderText: string,
    private mode: TelegramStreamMode,
  ) {
    this.draftStream =
      mode === "draft"
        ? new TelegramDraftStream(env, incoming.chatId, createDraftId(incoming))
        : undefined;
  }

  static async create(env: Env, incoming: IncomingTelegramText, placeholderText: string) {
    const mode = resolveTelegramStreamMode(env, incoming);
    const responder = new TelegramStreamingResponder(env, incoming, placeholderText, mode);

    if (mode === "edit") {
      await responder.ensureEditStream();
    }

    return responder;
  }

  async append(delta: string) {
    if (!delta) return;
    this.content += delta;
    await this.flush(false);
  }

  async appendParagraph(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.content = this.content.trim()
      ? `${this.content.trim()}\n\n${trimmed}`
      : trimmed;
    await this.flush(true);
  }

  async finish(finalContent: string | undefined, options: TelegramFinishOptions = {}) {
    if (finalContent?.trim()) {
      this.content = finalContent.trim();
    }
    if (!this.content.trim()) {
      this.content = "No response.";
    }

    if (this.mode === "draft" && this.draftStream) {
      try {
        await this.draftStream.flush(this.content, true);
        await sendTelegramMessageChunks(
          this.env,
          this.incoming.chatId,
          this.content,
          this.incoming.messageId,
          0,
          options,
        );
        return;
      } catch {
        await this.fallbackToEdit();
      }
    }

    if (this.mode === "off") {
      await sendTelegramMessageChunks(
        this.env,
        this.incoming.chatId,
        this.content,
        this.incoming.messageId,
        0,
        options,
      );
      return;
    }

    await this.ensureEditStream();
    await this.editStream?.finish(this.content, options);
  }

  private async flush(force: boolean) {
    if (this.mode === "draft" && this.draftStream) {
      try {
        await this.draftStream.flush(this.content, force);
        return;
      } catch {
        await this.fallbackToEdit();
      }
    }

    if (this.mode === "off") return;

    await this.ensureEditStream();
    await this.editStream?.replace(this.content, force);
  }

  private async fallbackToEdit() {
    this.mode = "edit";
    await this.ensureEditStream();
    await this.editStream?.replace(this.content, true);
  }

  private async ensureEditStream() {
    if (this.editStream) return;
    const placeholder = await sendTelegramMessage(
      this.env,
      this.incoming.chatId,
      this.placeholderText,
      this.incoming.messageId,
    );
    this.editStream = new TelegramEditStream(
      this.env,
      this.incoming.chatId,
      placeholder.message_id,
      this.incoming.messageId,
    );
  }
}

class TelegramEditStream {
  private content = "";
  private lastEditText = "";
  private lastEditAt = 0;
  private editIntervalMs = TELEGRAM_EDIT_INTERVAL_MS;
  private floodStrikeCount = 0;
  private editDisabled = false;
  private readonly createdAt = Date.now();

  constructor(
    private readonly env: Env,
    private readonly chatId: string,
    private readonly messageId: number,
    private readonly replyToMessageId?: number,
  ) {}

  async append(token: string) {
    if (!token) return;
    this.content += token;
    await this.flush(false);
  }

  async replace(content: string, force: boolean) {
    this.content = content;
    await this.flush(force);
  }

  async appendParagraph(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.content = this.content.trim()
      ? `${this.content.trim()}\n\n${trimmed}`
      : trimmed;
    await this.flush(true);
  }

  async finish(finalContent: string | undefined, options: TelegramFinishOptions = {}) {
    if (finalContent?.trim()) {
      this.content = finalContent.trim();
    }
    if (!this.content.trim()) {
      this.content = "No response.";
    }

    if (this.editDisabled || this.shouldUseFreshFinal()) {
      await sendTelegramMessageChunks(
        this.env,
        this.chatId,
        this.content,
        this.replyToMessageId,
        0,
        options,
      );
      await deleteTelegramMessage(this.env, this.chatId, this.messageId).catch(() => undefined);
      return;
    }

    try {
      await this.flush(true, options);
      await sendTelegramMessageChunks(this.env, this.chatId, this.content, undefined, 1, options);
    } catch (error) {
      if (!isTelegramFloodControlError(error)) throw error;
      await sendTelegramMessageChunks(
        this.env,
        this.chatId,
        this.content,
        this.replyToMessageId,
        0,
        options,
      );
      await deleteTelegramMessage(this.env, this.chatId, this.messageId).catch(() => undefined);
    }
  }

  private async flush(force: boolean, options: TelegramFinishOptions = {}) {
    const now = Date.now();
    const text = firstTelegramChunk(formatTelegramStreamPreview(this.content, !force));
    if (!force && this.editDisabled) return;
    if (!force) {
      const editedRecently = now - this.lastEditAt < this.editIntervalMs;
      const smallDelta = Math.abs(text.length - this.lastEditText.length) < TELEGRAM_EDIT_MIN_CHARS;
      if (editedRecently || smallDelta) return;
    }
    if (text === this.lastEditText && !options.replyMarkup) return;

    try {
      await editTelegramMessage(this.env, this.chatId, this.messageId, text, options);
      this.lastEditText = text;
      this.lastEditAt = now;
      this.floodStrikeCount = 0;
      this.editIntervalMs = TELEGRAM_EDIT_INTERVAL_MS;
    } catch (error) {
      if (!isTelegramFloodControlError(error)) throw error;
      this.recordFloodControl(error);
      if (force) throw error;
    }
  }

  private recordFloodControl(error: unknown) {
    this.floodStrikeCount += 1;
    const retryAfterMs =
      error instanceof TelegramApiError && error.retryAfter
        ? error.retryAfter * 1_000
        : this.editIntervalMs * 2;
    this.editIntervalMs = Math.min(
      TELEGRAM_EDIT_MAX_INTERVAL_MS,
      Math.max(this.editIntervalMs * 2, retryAfterMs),
    );
    this.lastEditAt = Date.now();
    if (this.floodStrikeCount >= 3) {
      this.editDisabled = true;
    }
  }

  private shouldUseFreshFinal() {
    return Date.now() - this.createdAt >= TELEGRAM_FRESH_FINAL_AFTER_MS;
  }
}

class TelegramDraftStream {
  private lastDraftText = "";
  private lastDraftAt = 0;

  constructor(
    private readonly env: Env,
    private readonly chatId: string,
    private readonly draftId: string,
  ) {}

  async flush(content: string, force: boolean) {
    const now = Date.now();
    const text = firstTelegramChunk(formatTelegramStreamPreview(content, !force));
    if (!force) {
      const updatedRecently = now - this.lastDraftAt < TELEGRAM_DRAFT_INTERVAL_MS;
      const smallDelta = Math.abs(text.length - this.lastDraftText.length) < TELEGRAM_DRAFT_MIN_CHARS;
      if (updatedRecently || smallDelta) return;
    }
    if (text === this.lastDraftText) return;

    await sendTelegramDraft(this.env, this.chatId, this.draftId, text);
    this.lastDraftText = text;
    this.lastDraftAt = now;
  }
}

function extractTelegramText(update: TelegramUpdate): IncomingTelegramText | null {
  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text) return null;

  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromUserId: typeof message.from?.id === "number" ? String(message.from.id) : undefined,
    messageId: message.message_id,
    text,
  };
}

function extractTelegramFile(update: TelegramUpdate): IncomingTelegramFile | null {
  const message = update.message;
  if (!message) return null;

  const base = {
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromUserId: typeof message.from?.id === "number" ? String(message.from.id) : undefined,
    messageId: message.message_id,
    caption: message.caption,
  };

  const photo = bestTelegramPhoto(message.photo);
  if (photo) {
    return {
      ...base,
      kind: "photo",
      fileId: photo.file_id,
      fileName: "telegram-photo.jpg",
      mimeType: "image/jpeg",
      fileSize: photo.file_size,
    };
  }

  if (message.audio?.file_id) {
    return telegramMediaToIncomingFile(base, "audio", message.audio);
  }

  if (message.voice?.file_id) {
    return telegramMediaToIncomingFile(base, "voice", message.voice);
  }

  if (message.video?.file_id) {
    return telegramMediaToIncomingFile(base, "video", message.video);
  }

  const document = message.document;
  if (!document?.file_id) return null;

  return {
    ...base,
    kind: "document",
    fileId: document.file_id,
    fileName: document.file_name,
    mimeType: document.mime_type,
    fileSize: document.file_size,
  };
}

function bestTelegramPhoto(photo: TelegramPhotoSize[] | undefined) {
  if (!photo?.length) return null;
  return photo
    .slice()
    .sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0];
}

function telegramMediaToIncomingFile(
  base: Omit<IncomingTelegramFile, "kind" | "fileId">,
  kind: IncomingTelegramFile["kind"],
  file: TelegramMediaFile,
): IncomingTelegramFile {
  return {
    ...base,
    kind,
    fileId: file.file_id,
    fileName: file.file_name,
    mimeType: file.mime_type,
    fileSize: file.file_size,
  };
}

function extractTelegramCallback(update: TelegramUpdate): IncomingTelegramCallback | null {
  const callbackQuery = update.callback_query;
  const data = callbackQuery?.data?.trim();
  const message = callbackQuery?.message;
  if (!callbackQuery || !data || !message) return null;

  const parsed = parseTelegramCallbackData(data);
  if (!parsed) return null;

  return {
    callbackQueryId: callbackQuery.id,
    action: parsed.action,
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromUserId: typeof callbackQuery.from?.id === "number" ? String(callbackQuery.from.id) : undefined,
    messageId: message.message_id,
    text: parsed.text,
  };
}

function parseTelegramCallbackData(data: string): TelegramCallbackParseResult | null {
  const [prefix, action, value] = data.split(":");
  if (prefix !== TELEGRAM_APPROVAL_CALLBACK_PREFIX) return null;
  if ((action === "approve" || action === "deny") && value) {
    return {
      action: { kind: "approval", action, approvalId: value },
      text: `/${action} ${value}`,
    };
  }
  if (action === "menu" && isTelegramMenuView(value)) {
    const commandName = value === "stop" ? "stop" : "menu";
    return {
      action: { kind: "menu", view: value },
      text: `/${commandName}`,
    };
  }
  if (action === "memdel" && value) {
    return {
      action: { kind: "memory_delete", memoryId: value },
      text: `/forget ${value}`,
    };
  }
  if (action === "tdone" && value) {
    return {
      action: { kind: "task_done", taskId: value },
      text: `/done ${value}`,
    };
  }
  return null;
}

function isTelegramMenuView(
  value: string | undefined,
): value is Extract<TelegramCallbackAction, { kind: "menu" }>["view"] {
  return (
    value === "home" ||
    value === "status" ||
    value === "llm" ||
    value === "memory" ||
    value === "tasks" ||
    value === "pending" ||
    value === "stop"
  );
}

export function resolveTelegramTextBatchDelayMs(value: string | undefined) {
  if (value === undefined || !value.trim()) return TELEGRAM_TEXT_BATCH_DEFAULT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return TELEGRAM_TEXT_BATCH_DEFAULT_MS;
  return Math.min(Math.max(0, Math.round(parsed)), TELEGRAM_TEXT_BATCH_MAX_MS);
}

function mergeTelegramTextBatchMessages(
  messages: IncomingTelegramText[],
): IncomingTelegramText {
  if (messages.length === 0) {
    throw new Error("Cannot merge an empty Telegram text batch.");
  }

  const last = messages[messages.length - 1];
  return {
    ...last,
    text: messages
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, TELEGRAM_TEXT_BATCH_MAX_CHARS),
  };
}

function telegramTextBatchKey(incoming: Pick<IncomingTelegramText, "chatId">) {
  return incoming.chatId;
}

function shouldFlushTelegramTextBatch(batch: Pick<TelegramTextBatch, "messages">) {
  return (
    batch.messages.length >= TELEGRAM_TEXT_BATCH_MAX_MESSAGES ||
    batch.messages.reduce((total, message) => total + message.text.length, 0) >=
      TELEGRAM_TEXT_BATCH_MAX_CHARS
  );
}

function withFinalTelegramFormatting(options: TelegramFinishOptions): TelegramFinishOptions {
  return {
    ...options,
    parseMode: options.parseMode ?? "MarkdownV2",
  };
}

function formatTelegramStreamPreview(content: string, showCursor: boolean) {
  const text = content.trim() || "Working...";
  return showCursor ? `${text}${TELEGRAM_STREAM_CURSOR}` : text;
}

export function resolveTelegramStreamTransport(value: string | undefined): TelegramStreamTransport {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "draft" ||
    normalized === "edit" ||
    normalized === "off"
  ) {
    return normalized;
  }
  return "auto";
}

export function resolveTelegramStreamMode(
  env: Pick<Env, "TELEGRAM_STREAM_TRANSPORT">,
  incoming: Pick<IncomingTelegramText, "chatType">,
): TelegramStreamMode {
  const transport = resolveTelegramStreamTransport(env.TELEGRAM_STREAM_TRANSPORT);
  if (transport === "off") return "off";
  if (transport === "edit") return "edit";
  if (incoming.chatType === "private") return "draft";
  return "edit";
}

async function fetchAgentState(env: Env, requestUrl: string): Promise<AgentStateResponse> {
  const response = await fetchAgentObject(env, requestUrl, "/state", { method: "GET" });
  if (!response.ok) return {};
  return (await response.json().catch(() => ({}))) as AgentStateResponse;
}

async function fetchLlmSettings(env: Env, requestUrl: string): Promise<LlmSettingsResponse> {
  const response = await fetchAgentObject(env, requestUrl, "/settings/llm", { method: "GET" });
  if (!response.ok) return {};
  return (await response.json().catch(() => ({}))) as LlmSettingsResponse;
}

function activeLlmProfileLabel(summary: AgentStateResponse["llm"]) {
  const active = summary?.profiles?.find((profile) => profile.id === summary.activeProfileId);
  if (!active) return "not configured";
  const keyState = active.hasApiKey ? "" : ` (${active.apiKeyEnv} missing)`;
  return `${active.model} [${active.id}]${keyState}`;
}

async function fetchPendingApprovals(env: Env, requestUrl: string, chatId: string) {
  const response = await fetchAgentObject(
    env,
    requestUrl,
    `/approvals?channel=telegram&chatId=${encodeURIComponent(chatId)}`,
    { method: "GET" },
  );
  if (!response.ok) return [];
  const body = (await response.json().catch(() => ({}))) as {
    approvals?: PendingToolApproval[];
  };
  return body.approvals ?? [];
}

async function fetchTasks(
  env: Env,
  requestUrl: string,
  chatId: string,
  status?: "pending" | "done",
) {
  const params = new URLSearchParams({ channel: "telegram", chatId });
  if (status) params.set("status", status);
  const response = await fetchAgentObject(env, requestUrl, `/tasks?${params.toString()}`, {
    method: "GET",
  });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => ({}))) as { tasks?: StoredTask[] };
  return body.tasks ?? [];
}

async function createTask(
  env: Env,
  requestUrl: string,
  chatId: string,
  title: string,
  dueAt?: number,
) {
  const response = await fetchAgentObject(env, requestUrl, "/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { channel: "telegram", chatId },
      title,
      ...(dueAt ? { dueAt } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    task?: StoredTask;
    error?: string;
  };
  if (!response.ok || body.error || !body.task) {
    throw new Error(body.error || `Task create failed: ${response.status}`);
  }
  return body.task;
}

async function completeTaskById(env: Env, requestUrl: string, chatId: string, taskId: string) {
  const response = await fetchAgentObject(
    env,
    requestUrl,
    `/tasks/${encodeURIComponent(taskId)}/done`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { channel: "telegram", chatId },
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error || `Task update failed: ${response.status}`);
  }
}

async function deleteMemoryById(env: Env, requestUrl: string, memoryId: string) {
  const response = await fetchAgentObject(env, requestUrl, `/memories/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Memory delete failed: ${response.status}`);
  }
}

async function sendTelegramMessage(
  env: Env,
  chatId: string,
  text: string,
  replyToMessageId?: number,
  options: TelegramFinishOptions = {},
) {
  const payload = {
    chat_id: chatId,
    text: firstTelegramChunk(text),
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true,
    reply_markup: options.replyMarkup,
    parse_mode: options.parseMode,
  };
  const result = await telegramApiWithPlainFallback<TelegramSentMessage>(
    env,
    "sendMessage",
    payload,
    Boolean(options.parseMode),
  );

  return result ?? { message_id: 0 };
}

async function sendTelegramMessageChunks(
  env: Env,
  chatId: string,
  text: string,
  replyToMessageId?: number,
  startIndex = 0,
  options: TelegramFinishOptions = {},
) {
  const chunks = chunkText(text, MAX_TELEGRAM_TEXT);
  for (let index = startIndex; index < chunks.length; index += 1) {
    await sendTelegramMessage(
      env,
      chatId,
      chunks[index],
      index === 0 ? replyToMessageId : undefined,
      {
        parseMode: options.parseMode,
        replyMarkup: index === 0 ? options.replyMarkup : undefined,
      },
    );
  }
}

async function editTelegramMessage(
  env: Env,
  chatId: string,
  messageId: number,
  text: string,
  options: TelegramFinishOptions = {},
) {
  if (!messageId) return;
  try {
    await telegramApiWithPlainFallback(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: firstTelegramChunk(text),
      reply_markup: options.replyMarkup,
      parse_mode: options.parseMode,
    }, Boolean(options.parseMode));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.toLowerCase().includes("message is not modified")) {
      throw error;
    }
  }
}

async function deleteTelegramMessage(env: Env, chatId: string, messageId: number) {
  if (!messageId) return;
  await telegramApi(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function sendTelegramChatAction(env: Env, chatId: string, action: "typing") {
  await telegramApi(env, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

function startTelegramTypingLoop(env: Env, chatId: string) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await sendTelegramChatAction(env, chatId, "typing");
    } catch {
      // Typing indicators are best-effort and should not fail the user request.
    }
    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, TELEGRAM_TYPING_INTERVAL_MS);
    }
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function answerTelegramCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
  showAlert = false,
) {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 180),
    show_alert: showAlert,
  });
}

async function sendTelegramDraft(env: Env, chatId: string, draftId: string, text: string) {
  await telegramApi(env, "sendMessageDraft", {
    chat_id: chatId,
    draft_id: draftId,
    text: firstTelegramChunk(text),
  });
}

type TelegramFileClassification =
  | {
      kind: "text";
      maxBytes: number;
      mediaType: string;
    }
  | {
      kind: "image" | "audio" | "pdf";
      modality: LlmModality;
      maxBytes: number;
      mediaType: string;
    };

function classifyTelegramFile(file: IncomingTelegramFile): TelegramFileClassification | Error {
  if (file.kind === "video") {
    return new Error(
      "Video input is not supported by the current OpenAI-compatible adapter yet. Send an image, PDF, MP3, WAV, or text file.",
    );
  }

  if (isSupportedTelegramTextFile(file)) {
    return { kind: "text", maxBytes: TELEGRAM_FILE_MAX_BYTES, mediaType: file.mimeType ?? "text/plain" };
  }

  if (isTelegramImage(file)) {
    return {
      kind: "image",
      modality: "image",
      maxBytes: TELEGRAM_MEDIA_MAX_BYTES,
      mediaType: file.mimeType ?? "image/jpeg",
    };
  }

  if (isTelegramPdf(file)) {
    return {
      kind: "pdf",
      modality: "pdf",
      maxBytes: TELEGRAM_MEDIA_MAX_BYTES,
      mediaType: "application/pdf",
    };
  }

  if (isTelegramSupportedAudio(file)) {
    return {
      kind: "audio",
      modality: "audio",
      maxBytes: TELEGRAM_MEDIA_MAX_BYTES,
      mediaType: normalizeAudioMimeType(file.mimeType),
    };
  }

  if (file.kind === "voice") {
    return new Error("Telegram voice messages are usually OGG/Opus. Send MP3 or WAV audio for model input.");
  }

  return new Error("Unsupported file type. Supported: text, image, PDF, MP3, and WAV.");
}

function isSupportedTelegramTextFile(file: Pick<IncomingTelegramFile, "fileName" | "mimeType">) {
  const mime = file.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/toml",
    ].includes(mime)
  ) {
    return true;
  }

  const name = file.fileName?.toLowerCase() ?? "";
  return /\.(txt|md|markdown|json|jsonl|csv|tsv|yaml|yml|xml|toml|log)$/i.test(name);
}

function isTelegramImage(file: Pick<IncomingTelegramFile, "kind" | "fileName" | "mimeType">) {
  const mime = file.mimeType?.toLowerCase() ?? "";
  const name = file.fileName?.toLowerCase() ?? "";
  return file.kind === "photo" || mime.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif)$/i.test(name);
}

function isTelegramPdf(file: Pick<IncomingTelegramFile, "fileName" | "mimeType">) {
  const mime = file.mimeType?.toLowerCase() ?? "";
  const name = file.fileName?.toLowerCase() ?? "";
  return mime === "application/pdf" || name.endsWith(".pdf");
}

function isTelegramSupportedAudio(file: Pick<IncomingTelegramFile, "kind" | "fileName" | "mimeType">) {
  if (file.kind !== "audio" && file.kind !== "document") return false;
  const mime = file.mimeType?.toLowerCase() ?? "";
  const name = file.fileName?.toLowerCase() ?? "";
  return (
    mime === "audio/mpeg" ||
    mime === "audio/mp3" ||
    mime === "audio/wav" ||
    mime === "audio/x-wav" ||
    /\.(mp3|wav)$/i.test(name)
  );
}

function normalizeAudioMimeType(value: string | undefined) {
  const mime = value?.toLowerCase();
  if (mime === "audio/wav" || mime === "audio/x-wav") return "audio/wav";
  return "audio/mpeg";
}

async function downloadTelegramFileBytes(env: Env, file: IncomingTelegramFile, maxBytes: number) {
  if (typeof file.fileSize === "number" && file.fileSize > maxBytes) {
    throw new Error(`Files of this type must be ${formatBytes(maxBytes)} or smaller.`);
  }

  const info = await telegramApi<{ file_path?: string; file_size?: number }>(env, "getFile", {
    file_id: file.fileId,
  });
  if (!info?.file_path) {
    throw new Error("Telegram did not return a file path.");
  }
  if (typeof info.file_size === "number" && info.file_size > maxBytes) {
    throw new Error(`Files of this type must be ${formatBytes(maxBytes)} or smaller.`);
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`${TELEGRAM_API_BASE}/file/bot${token}/${info.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Files of this type must be ${formatBytes(maxBytes)} or smaller.`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Files of this type must be ${formatBytes(maxBytes)} or smaller.`);
  }
  return { bytes };
}

function telegramFileAttachment(
  file: IncomingTelegramFile,
  classification: Exclude<TelegramFileClassification, { kind: "text" }>,
  bytes: ArrayBuffer,
): ChatContentPart {
  const data = dataUrl(classification.mediaType, bytes);
  if (classification.kind === "image") {
    return {
      type: "image",
      data,
      mediaType: classification.mediaType,
      filename: file.fileName,
    };
  }

  return {
    type: "file",
    data,
    mediaType: classification.mediaType,
    filename: file.fileName ?? defaultAttachmentFilename(classification),
  };
}

function dataUrl(mediaType: string, bytes: ArrayBuffer) {
  return `data:${mediaType};base64,${arrayBufferToBase64(bytes)}`;
}

function arrayBufferToBase64(bytes: ArrayBuffer) {
  let binary = "";
  const view = new Uint8Array(bytes);
  const chunkSize = 0x8000;
  for (let index = 0; index < view.length; index += chunkSize) {
    binary += String.fromCharCode(...view.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function defaultAttachmentFilename(classification: Exclude<TelegramFileClassification, { kind: "text" }>) {
  if (classification.kind === "pdf") return "document.pdf";
  if (classification.mediaType === "audio/wav") return "audio.wav";
  return "audio.mp3";
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)}MB`
    : `${Math.round(bytes / 1024)}KB`;
}

function llmSupportsModality(llm: LlmConfig, modality: LlmModality) {
  return llm.modalities?.includes(modality) ?? false;
}

function unsupportedModalityMessage(modality: LlmModality, llm: LlmConfig) {
  const declared = llm.modalities?.join(", ") || "text";
  return [
    `The active model profile does not declare ${modality} support.`,
    `Model: ${llm.model}`,
    `Declared modalities: ${declared}`,
    `Add "modalities": ["text", "${modality}"] to the active LLM profile after confirming the model supports it.`,
  ].join("\n");
}

function formatTelegramFilePrompt(file: IncomingTelegramFile, content: string) {
  const trimmed = content.replace(/\u0000/g, "").slice(0, TELEGRAM_FILE_MAX_TEXT_CHARS);
  const instruction = file.caption?.trim() || "Summarize this file and call out important action items.";
  return [
    `User instruction: ${instruction}`,
    "",
    `File: ${file.fileName ?? "telegram-file"}`,
    file.mimeType ? `MIME: ${file.mimeType}` : "",
    typeof file.fileSize === "number" ? `Size: ${file.fileSize} bytes` : "",
    "",
    "File content:",
    trimmed,
    content.length > trimmed.length ? "\n[truncated]" : "",
  ].filter((line) => line !== "").join("\n");
}

function formatTelegramMediaPrompt(
  file: IncomingTelegramFile,
  classification: Exclude<TelegramFileClassification, { kind: "text" }>,
) {
  const instruction = file.caption?.trim() || defaultMediaInstruction(classification.kind);
  return [
    `User instruction: ${instruction}`,
    "",
    `Attachment: ${file.fileName ?? file.kind}`,
    `Type: ${classification.kind}`,
    `MIME: ${classification.mediaType}`,
    typeof file.fileSize === "number" ? `Size: ${file.fileSize} bytes` : "",
  ].filter((line) => line !== "").join("\n");
}

function defaultMediaInstruction(kind: Exclude<TelegramFileClassification, { kind: "text" }>["kind"]) {
  if (kind === "image") return "Describe this image and answer any visible question.";
  if (kind === "audio") return "Analyze this audio and summarize the important content.";
  return "Analyze this PDF and summarize the important content.";
}

async function telegramApi<T>(env: Env, method: string, payload: Record<string, unknown>) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(compactTelegramPayload(payload)),
  });

  const body = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;
  if (!response.ok || body.ok === false) {
    throw new TelegramApiError(
      response.status,
      body.description,
      body.parameters?.retry_after,
    );
  }

  return body.result;
}

async function telegramApiWithPlainFallback<T>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
  canFallback: boolean,
) {
  try {
    return await telegramApi<T>(env, method, payload);
  } catch (error) {
    if (!canFallback || !isTelegramParseError(error)) throw error;
    const { parse_mode: _parseMode, ...plainPayload } = payload;
    return telegramApi<T>(env, method, plainPayload);
  }
}

function compactTelegramPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description = "",
    readonly retryAfter?: number,
  ) {
    super(`Telegram API failed: ${status} ${description}`.trim());
  }
}

function isTelegramFloodControlError(error: unknown) {
  if (!(error instanceof TelegramApiError)) return false;
  const description = error.description.toLowerCase();
  return (
    error.status === 429 ||
    description.includes("too many requests") ||
    typeof error.retryAfter === "number"
  );
}

function isTelegramParseError(error: unknown) {
  if (!(error instanceof TelegramApiError)) return false;
  const description = error.description.toLowerCase();
  return (
    error.status === 400 &&
    (description.includes("can't parse entities") ||
      description.includes("can't find end") ||
      description.includes("entity") ||
      description.includes("parse"))
  );
}

function telegramApprovalFinishOptions(approval: unknown): TelegramFinishOptions {
  if (!isPendingToolApproval(approval)) return {};
  return {
    replyMarkup: telegramApprovalReplyMarkup(approval.id),
  };
}

function telegramApprovalReplyMarkup(approvalId: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "Approve",
          callback_data: `${TELEGRAM_APPROVAL_CALLBACK_PREFIX}:approve:${approvalId}`,
        },
        {
          text: "Deny",
          callback_data: `${TELEGRAM_APPROVAL_CALLBACK_PREFIX}:deny:${approvalId}`,
        },
      ],
    ],
  };
}

function emptyTelegramInlineKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [] };
}

function isPendingToolApproval(value: unknown): value is PendingToolApproval {
  if (typeof value !== "object" || value === null) return false;
  const approval = value as Partial<PendingToolApproval>;
  return (
    typeof approval.id === "string" &&
    typeof approval.toolName === "string" &&
    typeof approval.chatId === "string" &&
    typeof approval.channel === "string"
  );
}

function callbackErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Approval request failed.";
}

function formatPendingApproval(approval: PendingToolApproval) {
  return [
    `${approval.id}: ${approval.toolName}`,
    `Risk: ${approval.risk}`,
    `Input: ${stringifyShort(approval.toolInput, 500)}`,
    `/approve ${approval.id}`,
    `/deny ${approval.id}`,
  ].join("\n");
}

function formatTask(task: StoredTask, timeZone: string | undefined) {
  return [
    `${task.id}: ${task.title}`,
    task.due_at ? `Due: ${formatTimestamp(task.due_at, timeZone)}` : "Due: none",
  ].join("\n");
}

export function parseTelegramReminderArgs(
  args: string,
  now = Date.now(),
  timeZone = TELEGRAM_DEFAULT_TIME_ZONE,
): { dueAt: number; title: string } | Error {
  const text = args.trim();
  if (!text) return new Error("Usage: /remind <when> <text>");

  const relative = /^(\d+)\s*(m|min|minute|minutes|分钟|分|h|hr|hour|hours|小时|时|d|day|days|天)(?:后)?\s+([\s\S]+)$/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier =
      unit === "m" || unit === "min" || unit.startsWith("minute") || unit === "分钟" || unit === "分"
        ? 60_000
        : unit === "h" || unit === "hr" || unit.startsWith("hour") || unit === "小时" || unit === "时"
          ? 60 * 60_000
          : 24 * 60 * 60_000;
    return normalizeReminderResult(now + amount * multiplier, relative[3]);
  }

  const dayTime = /^(today|tomorrow|今天|明天)\s*(\d{1,2})[:：](\d{2})\s*([\s\S]+)$/i.exec(text);
  if (dayTime) {
    const dayOffset = dayTime[1].toLowerCase() === "tomorrow" || dayTime[1] === "明天" ? 1 : 0;
    const dueAt = zonedDayTimeToEpoch(now, dayOffset, Number(dayTime[2]), Number(dayTime[3]), timeZone);
    return normalizeReminderResult(dueAt, dayTime[4], now);
  }

  const isoDateTime = /^(\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\s+([\s\S]+)$/i.exec(text);
  if (isoDateTime) {
    const dueAt = Date.parse(isoDateTime[1].replace(" ", "T"));
    return normalizeReminderResult(dueAt, isoDateTime[2], now);
  }

  return new Error("Usage: /remind 10m <text>, /remind tomorrow 09:00 <text>, or /remind 2026-06-15T09:00 <text>");
}

function normalizeReminderResult(dueAt: number, title: string, now = Date.now()) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return new Error("Reminder text is required.");
  if (!Number.isFinite(dueAt)) return new Error("Could not parse reminder time.");
  if (dueAt <= now) return new Error("Reminder time must be in the future.");
  return { dueAt: Math.round(dueAt), title: normalizedTitle };
}

function zonedDayTimeToEpoch(
  now: number,
  dayOffset: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return Number.NaN;
  const parts = zonedDateParts(now, timeZone);
  const targetDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return zonedDateTimeToEpoch(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth() + 1,
    targetDate.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}

function zonedDateTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedDateParts(guess, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    guess += desiredAsUtc - actualAsUtc;
  }
  return guess;
}

function zonedDateParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
  };
}

function formatTimestamp(timestamp: number | null, timeZone: string | undefined) {
  if (!timestamp) return "none";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timeZone || TELEGRAM_DEFAULT_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function telegramButton(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return {
    text,
    callback_data: `${TELEGRAM_APPROVAL_CALLBACK_PREFIX}:${callbackData}`.slice(0, 64),
  };
}

function shortId(id: string) {
  return id.length <= 10 ? id : id.slice(0, 8);
}

function firstArg(args: string) {
  return args.split(/\s+/).map((arg) => arg.trim()).filter(Boolean)[0];
}

function createDraftId(incoming: Pick<IncomingTelegramText, "chatId" | "messageId">) {
  return `agent-worker:${incoming.chatId}:${incoming.messageId}`;
}

function firstTelegramChunk(text: string) {
  return chunkText(text, MAX_TELEGRAM_TEXT)[0] || "";
}

function chunkText(text: string, maxLength: number) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks.length > 0 ? chunks : [""];
}

function stringifyShort(value: unknown, maxChars: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

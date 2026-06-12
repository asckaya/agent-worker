import { parseSlashCommand, type SlashCommand } from "./commands";
import { fetchAgentObject } from "./agent-object";
import { readServerSentEvents } from "./sse";
import type { AgentStreamEvent, ChannelAdapter, ChannelCapabilities } from "./types";
import type { ActiveAgentRun, Env, LlmConfig, PendingToolApproval, StoredMemory } from "../types";
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
const MUTATING_COMMANDS = new Set(["approve", "deny", "forget", "stop", "new", "reset"]);

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
}

interface IncomingTelegramCallback extends IncomingTelegramText {
  callbackQueryId: string;
  action: "approve" | "deny";
  approvalId: string;
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
  pendingApprovals?: PendingToolApproval[];
  activeRuns?: ActiveAgentRun[];
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
  if (!callback && !incoming) {
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
    return Response.json({ ok: true, ignored: "unsupported_update" });
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

  if (callback.action === "deny") {
    try {
      await denyApproval(env, requestUrl, callback.chatId, callback.approvalId);
      await answerTelegramCallbackQuery(env, callback.callbackQueryId, "Denied.");
      await editTelegramMessage(
        env,
        callback.chatId,
        callback.messageId,
        `Denied approval: ${callback.approvalId}`,
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
    `Approved: ${callback.approvalId}\nRunning tool...`,
    { replyMarkup: emptyTelegramInlineKeyboard() },
  );
  try {
    await handleApproveCommand(env, requestUrl, callback, command ?? {
      name: "approve",
      args: callback.approvalId,
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
      );
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
    "/status - show runtime status",
    "/memory - list saved memories",
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
  const llm = buildTelegramLlmConfig(env);
  const queuedFollowUps =
    state.activeRuns?.reduce((total, run) => total + run.queuedMessageCount, 0) ?? 0;
  return [
    "Status: ok",
    `Model: ${llm instanceof Error ? "not configured" : llm.model}`,
    `Memories: ${state.memories?.length ?? 0}`,
    `Pending approvals: ${state.pendingApprovals?.length ?? 0}`,
    `Active runs: ${state.activeRuns?.length ?? 0}`,
    `Queued follow-ups: ${queuedFollowUps}`,
  ].join("\n");
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

async function pendingApprovalsText(env: Env, requestUrl: string, chatId: string) {
  const approvals = await fetchPendingApprovals(env, requestUrl, chatId);
  if (approvals.length === 0) return "No pending approvals.";

  return approvals.map(formatPendingApproval).join("\n\n");
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

  const response = await fetchAgentObject(env, requestUrl, `/memories/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Memory delete failed: ${response.status}`);
  }

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

  const llm = buildTelegramLlmConfig(env);
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
  const response = await fetchAgentObject(env, requestUrl, "/sessions/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { channel: "telegram", chatId: incoming.chatId },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    stopped?: boolean;
    error?: string;
  };
  if (!response.ok || body.error) {
    throw new Error(body.error || `Stop failed: ${response.status}`);
  }

  const label = commandName === "stop" ? "Stopped active response." : "Started a fresh turn.";
  await sendTelegramMessage(
    env,
    incoming.chatId,
    body.stopped ? label : "No active response in this chat.",
    incoming.messageId,
  );
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
  const llm = buildTelegramLlmConfig(env);
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
      llm,
      source: { channel: "telegram", chatId: incoming.chatId },
    },
    "Thinking...",
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

function extractTelegramCallback(update: TelegramUpdate): IncomingTelegramCallback | null {
  const callbackQuery = update.callback_query;
  const data = callbackQuery?.data?.trim();
  const message = callbackQuery?.message;
  if (!callbackQuery || !data || !message) return null;

  const parsed = parseApprovalCallbackData(data);
  if (!parsed) return null;

  return {
    callbackQueryId: callbackQuery.id,
    action: parsed.action,
    approvalId: parsed.approvalId,
    chatId: message.chat.id,
    chatType: message.chat.type,
    fromUserId: typeof callbackQuery.from?.id === "number" ? String(callbackQuery.from.id) : undefined,
    messageId: message.message_id,
    text: `/${parsed.action} ${parsed.approvalId}`,
  };
}

function parseApprovalCallbackData(
  data: string,
): { action: "approve" | "deny"; approvalId: string } | null {
  const [prefix, action, approvalId] = data.split(":");
  if (prefix !== TELEGRAM_APPROVAL_CALLBACK_PREFIX) return null;
  if (action !== "approve" && action !== "deny") return null;
  if (!approvalId) return null;
  return { action, approvalId };
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

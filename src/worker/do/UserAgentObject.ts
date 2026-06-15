import { buildClientHistoryMessages, buildModelMessages } from "../agent/context";
import {
  writeAgentStreamEvent,
} from "../channels/sse";
import type { AgentStreamEvent, AgentStreamEventName } from "../channels/types";
import {
  DurableObjectMemoryProvider,
} from "../memory/provider";
import {
  createEnvLlmSettings,
  getActiveLlmProfile,
  LLM_SETTINGS_KEY,
  parseLlmActiveProfilePayload,
  parseLlmSettingsPayload,
  resolveLlmConfigFromSettings,
  summarizeLlmSettings,
  type LlmSettings,
} from "../llm/settings";
import { streamChatCompletion } from "../model/openai-compatible";
import { createDefaultToolRegistry } from "../tools";
import { DEFAULT_TOOL_TIMEOUT_MS, ToolExecutor } from "../tools/executor";
import {
  stableJsonStringify,
  ToolLoopRecovery,
  type ToolRecoveryResult,
  ToolRunGuardrails,
} from "../tools/guardrails";
import type { ToolContext, ToolDefinition } from "../tools/registry";
import type {
  ActiveAgentRun,
  ChannelSource,
  ChatMessage,
  ClientChatMessage,
  ChatRequest,
  Env,
  LlmConfig,
  PendingToolApproval,
  StoredChatSession,
  StoredMemory,
  StoredTask,
  ToolCall,
} from "../types";
import {
  parseApprovalActionPayload,
  parseChatSessionCreatePayload,
  parseChatSessionSwitchPayload,
  parseChatRequestPayload,
  parseMemoryCreatePayload,
  parseSessionControlPayload,
  parseTaskActionPayload,
  parseTaskCreatePayload,
} from "../validation";

const MAX_TOOL_STEPS = 4;
const MAX_MEMORY_ITEMS = 200;
const MAX_MEMORY_CHARS = 1_200;
const MAX_RELEVANT_MEMORIES = 8;
const APPROVAL_TTL_MS = 15 * 60_000;
const MAX_PENDING_APPROVALS = 50;
const MAX_TOOL_INPUT_JSON_CHARS = 8_000;
const MAX_TOOL_RESULT_SUMMARY_CHARS = 12_000;
const MAX_ACTIVE_RUN_FOLLOW_UPS = 3;
const MAX_TASKS = 200;
const MAX_SESSION_TITLE_CHARS = 80;
const TASK_ALARM_RETRY_DELAY_MS = 60_000;

interface AgentCallbacks {
  onMeta?: (data: Record<string, unknown>) => Promise<void>;
  onToken?: (token: string) => Promise<void>;
  onToolCall?: (data: Record<string, unknown>) => Promise<void>;
  onToolResult?: (data: Record<string, unknown>) => Promise<void>;
  onApprovalRequired?: (data: Record<string, unknown>) => Promise<void>;
}

interface PendingApprovalRow {
  id: string;
  channel: string;
  chat_id: string;
  session_id?: string | null;
  tool_name: string;
  tool_input_json: string;
  risk: string;
  created_at: number;
  expires_at: number;
}

interface RuntimeSettingRow {
  key: string;
  value_json: string;
  updated_at: number;
}

interface TaskRow {
  id: string;
  channel: string;
  chat_id: string;
  title: string;
  status: "pending" | "done";
  due_at: number | null;
  created_at: number;
  completed_at: number | null;
  notified_at: number | null;
}

interface ChatSessionRow {
  id: string;
  channel: string;
  chat_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface ActiveChatSessionRow {
  channel: string;
  chat_id: string;
  session_id: string;
  updated_at: number;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  channel: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  sequence: number;
  created_at: number;
}

interface ActiveRunRecord extends Omit<ActiveAgentRun, "queuedMessageCount"> {
  key: string;
  abortController: AbortController;
  pendingFollowUps: ChatRequest[];
  interruptRequested: boolean;
  stopRequested: boolean;
}

interface PausedApprovalSession {
  approvalId: string;
  source?: ChannelSource;
  sessionId?: string;
  llm: LlmConfig;
  modelMessages: ChatMessage[];
  toolCallId: string;
  toolName: string;
  nextStep: number;
  expiresAt: number;
  pendingFollowUps: ChatRequest[];
}

interface AgentLoopOptions {
  runId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  consumePendingFollowUps?: () => ChatRequest[];
}

interface ToolRecoveryDecision {
  result?: unknown;
  content?: string;
}

export class UserAgentObject {
  private readonly memoryProvider: DurableObjectMemoryProvider;
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private readonly pausedApprovals = new Map<string, PausedApprovalSession>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.memoryProvider = new DurableObjectMemoryProvider(this.ctx.storage.sql, {
      maxItems: MAX_MEMORY_ITEMS,
      maxChars: MAX_MEMORY_CHARS,
      maxRelevantItems: MAX_RELEVANT_MEMORIES,
    });
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({
        memories: this.getMemories(),
        tasks: this.getTasks(),
        pendingApprovals: this.getPendingApprovals(),
        activeRuns: this.getActiveRuns(),
        llm: this.getLlmSettingsSummary(),
        limits: {
          maxMemoryItems: MAX_MEMORY_ITEMS,
          maxMemoryChars: MAX_MEMORY_CHARS,
          maxPendingApprovals: MAX_PENDING_APPROVALS,
          approvalTtlMs: APPROVAL_TTL_MS,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/memories") {
      return this.handleCreateMemory(request);
    }

    if (request.method === "POST" && url.pathname === "/memories/curate") {
      return this.handleCreateCuratedMemory(request);
    }

    if (request.method === "GET" && url.pathname === "/chat-sessions") {
      return this.handleListChatSessions(url);
    }

    if (request.method === "POST" && url.pathname === "/chat-sessions") {
      return this.handleCreateChatSession(request);
    }

    if (request.method === "POST" && url.pathname === "/chat-sessions/active") {
      return this.handleSwitchChatSession(request);
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      return Response.json({
        ok: true,
        tasks: this.getTasks({
          channel: url.searchParams.get("channel") ?? undefined,
          chatId: url.searchParams.get("chatId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
        }),
      });
    }

    if (request.method === "POST" && url.pathname === "/tasks") {
      return this.handleCreateTask(request);
    }

    const taskDoneMatch = /^\/tasks\/([^/]+)\/done$/.exec(url.pathname);
    if (request.method === "POST" && taskDoneMatch) {
      return this.handleCompleteTask(request, decodeURIComponent(taskDoneMatch[1]));
    }

    const taskDeleteMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && taskDeleteMatch) {
      return this.handleDeleteTask(request, decodeURIComponent(taskDeleteMatch[1]));
    }

    if (request.method === "GET" && url.pathname === "/settings/llm") {
      return Response.json({ ok: true, ...this.getLlmSettingsResponse() });
    }

    if (request.method === "PUT" && url.pathname === "/settings/llm") {
      return this.handleUpdateLlmSettings(request);
    }

    if (request.method === "DELETE" && url.pathname === "/settings/llm") {
      this.deleteRuntimeSetting(LLM_SETTINGS_KEY);
      return Response.json({ ok: true, ...this.getLlmSettingsResponse() });
    }

    if (request.method === "POST" && url.pathname === "/settings/llm/active") {
      return this.handleActivateLlmProfile(request);
    }

    if (request.method === "POST" && url.pathname === "/settings/llm/test") {
      return this.handleTestLlmSettings();
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/memories/")) {
      const id = decodeURIComponent(url.pathname.slice("/memories/".length));
      this.deleteMemory(id);
      return Response.json({ ok: true, memories: this.getMemories() });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      return this.handleChat(request);
    }

    if (request.method === "POST" && url.pathname === "/respond") {
      return this.handleRespond(request);
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      return Response.json({ activeRuns: this.getActiveRuns() });
    }

    if (request.method === "POST" && url.pathname === "/sessions/stop") {
      return this.handleStopSession(request);
    }

    if (request.method === "GET" && url.pathname === "/approvals") {
      return Response.json({
        approvals: this.getPendingApprovals({
          channel: url.searchParams.get("channel") ?? undefined,
          chatId: url.searchParams.get("chatId") ?? undefined,
        }),
      });
    }

    const approveStreamMatch = /^\/approvals\/([^/]+)\/approve-stream$/.exec(url.pathname);
    if (request.method === "POST" && approveStreamMatch) {
      return this.handleApproveStream(request, decodeURIComponent(approveStreamMatch[1]));
    }

    const approvalActionMatch = /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
    if (request.method === "POST" && approvalActionMatch) {
      const id = decodeURIComponent(approvalActionMatch[1]);
      const action = approvalActionMatch[2];
      return action === "approve"
        ? this.handleApprove(request, id)
        : this.handleDeny(request, id);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async alarm() {
    const now = Date.now();
    let shouldRetrySoon = false;

    try {
      const dueTasks = this.query<TaskRow>(
        `
          SELECT id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at
          FROM tasks
          WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?
          ORDER BY due_at ASC
          LIMIT ?
        `,
        now,
        20,
      ).map(rowToTask);

      for (const task of dueTasks) {
        try {
          await this.notifyDueTask(task);
          this.markTaskNotified(task.id);
        } catch (error) {
          console.warn("Task notification failed", {
            taskId: task.id,
            channel: task.channel,
            error: error instanceof Error ? error.message : String(error),
          });
          shouldRetrySoon = true;
        }
      }
    } catch (error) {
      console.warn("Task alarm failed", error instanceof Error ? error.message : String(error));
      shouldRetrySoon = true;
    } finally {
      await this.scheduleNextTaskAlarm(
        shouldRetrySoon ? Date.now() + TASK_ALARM_RETRY_DELAY_MS : undefined,
      );
    }
  }

  private async handleCreateMemory(request: Request) {
    try {
      const payload = parseMemoryCreatePayload(await request.json().catch(() => ({})));
      const memory = this.saveMemory(payload.content);
      return Response.json({ ok: true, memory, memories: this.getMemories() });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleCreateCuratedMemory(request: Request) {
    try {
      const payload = parseMemoryCreatePayload(await request.json().catch(() => ({})));
      if (!payload.llm) {
        throw new HttpError("LLM config is required to curate memory.", 400);
      }
      const curated = await this.curateMemory(payload.content, payload.llm);
      const memory = this.saveMemory(curated);
      return Response.json({
        ok: true,
        memory,
        memories: this.getMemories(),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private handleListChatSessions(url: URL) {
    try {
      const source = {
        channel: url.searchParams.get("channel")?.trim() || "api",
        chatId: url.searchParams.get("chatId")?.trim() || "default",
      };
      return Response.json({
        ok: true,
        activeSessionId: this.getActiveChatSession(source)?.id,
        sessions: this.getChatSessions(source),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleCreateChatSession(request: Request) {
    try {
      const payload = parseChatSessionCreatePayload(await request.json().catch(() => ({})));
      const session = this.createChatSession(payload.source, payload.title);
      return Response.json({
        ok: true,
        session,
        activeSessionId: session.id,
        sessions: this.getChatSessions(payload.source),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleSwitchChatSession(request: Request) {
    try {
      const payload = parseChatSessionSwitchPayload(await request.json().catch(() => ({})));
      const session = this.switchChatSession(payload.source, payload.sessionId);
      return Response.json({
        ok: true,
        session,
        activeSessionId: session.id,
        sessions: this.getChatSessions(payload.source),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleCreateTask(request: Request) {
    try {
      const payload = parseTaskCreatePayload(await request.json().catch(() => ({})));
      const task = this.saveTask({
        channel: payload.source.channel,
        chatId: payload.source.chatId,
        title: payload.title,
        dueAt: payload.dueAt ?? null,
      });
      await this.scheduleNextTaskAlarm();
      return Response.json({
        ok: true,
        task,
        tasks: this.getTasks({
          channel: payload.source.channel,
          chatId: payload.source.chatId,
        }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleCompleteTask(request: Request, taskId: string) {
    try {
      const payload = parseTaskActionPayload(await request.json().catch(() => ({})));
      const task = this.getTask(taskId);
      if (!task) throw new HttpError("Task not found.", 404);
      this.assertTaskSource(task, payload.source);
      const completed = this.completeTask(task.id);
      await this.scheduleNextTaskAlarm();
      return Response.json({ ok: true, task: completed });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleDeleteTask(request: Request, taskId: string) {
    try {
      const payload = parseTaskActionPayload(await request.json().catch(() => ({})));
      const task = this.getTask(taskId);
      if (!task) throw new HttpError("Task not found.", 404);
      this.assertTaskSource(task, payload.source);
      this.deleteTask(task.id);
      await this.scheduleNextTaskAlarm();
      return Response.json({ ok: true, deleted: task });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleUpdateLlmSettings(request: Request) {
    try {
      const settings = parseLlmSettingsPayload(await request.json().catch(() => ({})));
      this.saveRuntimeSetting(LLM_SETTINGS_KEY, settings);
      return Response.json({ ok: true, ...this.getLlmSettingsResponse() });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleActivateLlmProfile(request: Request) {
    try {
      const { profileId } = parseLlmActiveProfilePayload(await request.json().catch(() => ({})));
      const current = this.getEffectiveLlmSettings();
      if (!current.settings) {
        throw new HttpError("No LLM profiles are configured.", 404);
      }
      if (!current.settings.profiles.some((profile) => profile.id === profileId)) {
        throw new HttpError(`Unknown LLM profile: ${profileId}`, 404);
      }

      const settings = {
        ...current.settings,
        activeProfileId: profileId,
      };
      this.saveRuntimeSetting(LLM_SETTINGS_KEY, settings);
      return Response.json({ ok: true, ...this.getLlmSettingsResponse() });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async handleTestLlmSettings() {
    const current = this.getEffectiveLlmSettings();
    if (!current.settings) {
      return Response.json(
        { ok: false, error: "No LLM profiles are configured." },
        { status: 400 },
      );
    }

    const config = resolveLlmConfigFromSettings(current.settings, this.env);
    if (config instanceof Error) {
      return Response.json({ ok: false, error: config.message }, { status: 400 });
    }

    const profile = getActiveLlmProfile(current.settings);
    try {
      const result = await streamChatCompletion({
        config,
        messages: [
          {
            role: "user",
            content: "Reply with a concise OK if this LLM profile is configured correctly.",
          },
        ],
        onToken: async () => undefined,
      });

      return Response.json({
        ok: true,
        source: current.source,
        profileId: profile.id,
        model: profile.model,
        baseUrl: profile.baseUrl,
        content: result.content,
      });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          profileId: profile.id,
          error: error instanceof Error ? error.message : "LLM test failed.",
        },
        { status: 502 },
      );
    }
  }

  private async handleChat(request: Request) {
    let payload: ChatRequest;
    try {
      payload = await readChatRequest(request);
    } catch (error) {
      return errorResponse(error);
    }

    let session: StoredChatSession;
    try {
      session = this.resolveChatSession(payload);
    } catch (error) {
      return errorResponse(error);
    }

    const pausedApproval = this.getPausedApprovalForSession(payload.source, session.id);
    if (pausedApproval) {
      const queued = this.enqueuePausedApprovalFollowUp(pausedApproval, {
        ...payload,
        sessionId: session.id,
      });
      return this.immediateSseDone({
        content: formatPausedApprovalMessage(pausedApproval, queued),
        queued,
        pendingApprovalId: pausedApproval.approvalId,
      });
    }

    const existingRun = this.getActiveRun(payload.source);
    if (existingRun) {
      const queued = this.enqueueFollowUp(existingRun, { ...payload, sessionId: session.id });
      return this.immediateSseDone({
        content: formatActiveRunMessage(existingRun, queued),
        activeRun: activeRunToStatus(existingRun),
        queued,
      });
    }

    const activeRun = this.startActiveRun(payload.source);
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    this.ctx.waitUntil(
      this.runChat({ ...payload, sessionId: session.id }, session, writer, activeRun)
        .catch(async (error: unknown) => {
          if (activeRun.stopRequested) {
            await writeSse(writer, "done", {
              content: "Stopped.",
              activeRun: activeRunToStatus(activeRun),
            });
          } else {
            await writeSse(writer, "error", {
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        })
        .finally(async () => {
          this.finishActiveRun(activeRun);
          await writer.close();
        }),
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async runChat(
    payload: ChatRequest,
    session: StoredChatSession,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    activeRun: ActiveRunRecord,
  ) {
    const callbacks: AgentCallbacks = {
      onMeta: async (data) => writeSse(writer, "meta", data),
      onToken: async (token) => writeSse(writer, "message_delta", { delta: token }),
      onToolCall: async (data) => writeSse(writer, "tool_call", data),
      onToolResult: async (data) => writeSse(writer, "tool_result", data),
      onApprovalRequired: async (data) => writeSse(writer, "approval_required", data),
    };
    let currentPayload = this.withConversationHistory(payload, session);
    let combinedContent = "";
    let ephemeralHistory = currentPayload.history ?? [];
    let result: Awaited<ReturnType<UserAgentObject["runAgent"]>> | undefined;
    let firstTurn = true;

    while (true) {
      try {
        this.appendChatMessage(session, "user", currentPayload.message);
        result = await this.runAgent(currentPayload, callbacks, {
          runId: firstTurn ? activeRun.runId : undefined,
          sessionId: session.id,
          signal: activeRun.abortController.signal,
          consumePendingFollowUps: () => this.consumeFollowUps(activeRun),
        });
      } catch (error) {
        if (!this.consumeInterrupt(activeRun)) throw error;

        ephemeralHistory = appendEphemeralUser(ephemeralHistory, currentPayload.message);
        const interruptedFollowUp = this.dequeueFollowUp(activeRun);
        if (!interruptedFollowUp) {
          combinedContent = appendParagraph(combinedContent, "Interrupted by a new message.");
          break;
        }

        await writeSse(writer, "message_delta", {
          delta: formatInterruptStreamBoundary(interruptedFollowUp.message),
        });
        currentPayload = {
          ...interruptedFollowUp,
          history: ephemeralHistory,
        };
        firstTurn = false;
        continue;
      }

      combinedContent = firstTurn
        ? appendParagraph(combinedContent, result.content)
        : appendParagraph(
            combinedContent,
            `Follow-up:\n${result.content.trim() || "No response."}`,
          );
      ephemeralHistory = appendEphemeralTurn(
        ephemeralHistory,
        currentPayload.message,
        result.content,
      );
      this.appendChatMessage(session, "assistant", result.content);

      if (result.pendingApproval) {
        if (result.pausedFollowUpCount > 0) {
          combinedContent = appendParagraph(
            combinedContent,
            formatApprovalPausedFollowUpsMessage(result.pausedFollowUpCount),
          );
        }
        break;
      }

      const followUp = this.dequeueFollowUp(activeRun);
      if (!followUp) break;

      await writeSse(writer, "message_delta", {
        delta: formatFollowUpStreamBoundary(followUp.message),
      });
      currentPayload = {
        ...followUp,
        history: ephemeralHistory,
      };
      firstTurn = false;
    }

    await writeSse(writer, "done", {
      ...(result ?? {}),
      content: combinedContent,
      queuedMessageCount: activeRun.pendingFollowUps.length,
    });
  }

  private async handleRespond(request: Request) {
    const rawPayload = await readChatRequest(request);
    const session = this.resolveChatSession(rawPayload);
    const payload = this.withConversationHistory(rawPayload, session);
    this.appendChatMessage(session, "user", payload.message);
    const result = await this.runAgent(payload, {}, { sessionId: session.id });
    this.appendChatMessage(session, "assistant", result.content);
    return Response.json({ ok: true, ...result });
  }

  private async handleStopSession(request: Request) {
    try {
      const payload = parseSessionControlPayload(await request.json().catch(() => ({})));
      const stoppedRuns = this.stopActiveRuns(payload.source);
      if (payload.resetConversation) {
        this.resetConversation(payload.source);
      }
      return Response.json({
        ok: true,
        stopped: stoppedRuns.length > 0,
        activeRuns: stoppedRuns,
        conversationReset: payload.resetConversation,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private immediateSseDone(data: Extract<AgentStreamEvent, { event: "done" }>["data"]) {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    this.ctx.waitUntil(
      (async () => {
        await writeSse(writer, "done", data);
        await writer.close();
      })(),
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async runAgent(
    payload: ChatRequest,
    callbacks: AgentCallbacks,
    options: AgentLoopOptions = {},
  ) {
    const runId = options.runId ?? crypto.randomUUID();
    const relevantMemories = await this.searchMemory(payload.message);
    const modelMessages = buildModelMessages(
      [
        ...buildClientHistoryMessages(payload.history ?? []),
        { role: "user", content: buildUserContent(payload.message, payload.attachments) },
      ],
      relevantMemories,
    );

    await callbacks.onMeta?.({
      runId,
      memoryCount: this.getMemoryCount(),
      relevantMemoryCount: relevantMemories.length,
    });

    return this.runAgentWithMessages({
      llm: payload.llm,
      source: payload.source,
      sessionId: options.sessionId ?? payload.sessionId,
      modelMessages,
      callbacks,
      signal: options.signal,
      consumePendingFollowUps: options.consumePendingFollowUps,
    });
  }

  private async runAgentWithMessages(options: {
    llm: LlmConfig;
    source?: ChannelSource;
    sessionId?: string;
    modelMessages: ChatMessage[];
    callbacks: AgentCallbacks;
    signal?: AbortSignal;
    startStep?: number;
    consumePendingFollowUps?: () => ChatRequest[];
  }) {
    const registry = createDefaultToolRegistry(this.env);
    const modelTools = registry.listModelTools();
    const toolGuardrails = new ToolRunGuardrails();
    const toolRecovery = new ToolLoopRecovery();
    const toolExecutor = new ToolExecutor(registry, this.createToolContext(), {
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      approvalGate: {
        create: async ({ tool, input }) =>
          this.createPendingApproval(options.source, options.sessionId, tool, input),
      },
    });
    let finalContent = "";

    for (let step = options.startStep ?? 0; step <= MAX_TOOL_STEPS; step += 1) {
      throwIfAborted(options.signal);
      const result = await streamChatCompletion({
        config: options.llm,
        messages: options.modelMessages,
        tools: modelTools,
        signal: options.signal,
        onToken: async (token) => {
          throwIfAborted(options.signal);
          await options.callbacks.onToken?.(token);
        },
      });

      finalContent += result.content;

      if (result.toolCalls.length === 0) {
        options.modelMessages.push({
          role: "assistant",
          content: result.content,
        });
        return {
          content: finalContent,
          memoryCount: this.getMemoryCount(),
        };
      }

      if (step === MAX_TOOL_STEPS) {
        throw new Error(`Stopped after ${MAX_TOOL_STEPS} tool steps.`);
      }

      options.modelMessages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        throwIfAborted(options.signal);
        const parsedArgs = parseToolCallJson(toolCall.function.arguments);
        const toolInputForSignature =
          parsedArgs instanceof Error ? toolCall.function.arguments : parsedArgs;
        const guardrail = toolGuardrails.recordCall(toolCall.function.name, toolInputForSignature);
        await options.callbacks.onToolCall?.({
          id: toolCall.id,
          name: toolCall.function.name,
          repeatedCallCount: guardrail.count,
          warning: guardrail.warning,
        });

        const preExecutionRecovery = this.preflightToolCall(
          registry,
          modelTools.map((tool) => tool.function.name),
          toolCall,
          parsedArgs,
          toolRecovery,
        );
        if (preExecutionRecovery) {
          const hardStop = await this.applyToolRecoveryDecision(
            options.modelMessages,
            options.callbacks,
            toolCall,
            preExecutionRecovery,
          );
          if (hardStop) {
            return {
              content: hardStop,
              memoryCount: this.getMemoryCount(),
              guardrail: "tool_recovery_hard_stop",
            };
          }
          continue;
        }

        if (guardrail.blocked) {
          const toolResult = {
            error: `Repeated tool call blocked: ${toolCall.function.name}`,
            guardrail: "repeated_tool_call",
          };
          options.modelMessages.push({
            role: "tool",
            content: JSON.stringify(toolResult),
            name: toolCall.function.name,
            tool_call_id: toolCall.id,
          });
          await options.callbacks.onToolResult?.({
            id: toolCall.id,
            name: toolCall.function.name,
            result: toolResult,
            memoryCount: this.getMemoryCount(),
          });
          continue;
        }

        const toolExecution = await toolExecutor.executeToolCall(toolCall);
        if (toolExecution.status === "approval_required") {
          const pausedFollowUps = options.consumePendingFollowUps?.() ?? [];
          this.savePausedApprovalSession(toolExecution.approval, {
            source: options.source,
            sessionId: options.sessionId,
            llm: options.llm,
            modelMessages: options.modelMessages,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            nextStep: step + 1,
            pendingFollowUps: pausedFollowUps,
          });
          const message = formatApprovalRequiredMessage(toolExecution.approval);
          await options.callbacks.onApprovalRequired?.({
            approval: toolExecution.approval,
            message,
          });

          return {
            content: appendParagraph(finalContent, message),
            memoryCount: this.getMemoryCount(),
            pendingApproval: toolExecution.approval,
            pausedFollowUpCount: pausedFollowUps.length,
          };
        }

        const toolResult = toolExecution.result;
        const recoveryDecision = this.recoverFromToolResult(
          toolCall.function.name,
          parsedArgs instanceof Error ? toolCall.function.arguments : parsedArgs,
          toolResult,
          toolRecovery,
        );
        const effectiveToolResult = recoveryDecision.result ?? toolResult;
        options.modelMessages.push({
          role: "tool",
          content: JSON.stringify(effectiveToolResult),
          name: toolCall.function.name,
          tool_call_id: toolCall.id,
        });

        await options.callbacks.onToolResult?.({
          id: toolCall.id,
          name: toolCall.function.name,
          result: effectiveToolResult,
          memoryCount: this.getMemoryCount(),
        });

        if (recoveryDecision.content) {
          return {
            content: recoveryDecision.content,
            memoryCount: this.getMemoryCount(),
            guardrail: "tool_recovery_hard_stop",
          };
        }
      }
    }

    throw new Error("Agent loop stopped unexpectedly.");
  }

  private preflightToolCall(
    registry: ReturnType<typeof createDefaultToolRegistry>,
    availableToolNames: string[],
    toolCall: ToolCall,
    parsedArgs: unknown | Error,
    toolRecovery: ToolLoopRecovery,
  ): ToolRecoveryDecision | null {
    if (!registry.get(toolCall.function.name)) {
      const result = {
        error: `Unknown tool: ${toolCall.function.name}`,
        recovery: "invalid_tool_name",
        availableTools: availableToolNames,
      };
      const recovery = toolRecovery.recordFailure(
        toolCall.function.name,
        toolCall.function.arguments,
        result.error,
      );
      return decorateRecoveryResult(result, recovery);
    }

    if (parsedArgs instanceof Error) {
      const result = {
        error: "Invalid tool arguments JSON.",
        recovery: "invalid_tool_arguments_json",
        hint: "Call the same tool again with valid JSON arguments that match its schema.",
      };
      const recovery = toolRecovery.recordFailure(
        toolCall.function.name,
        toolCall.function.arguments,
        result.error,
      );
      return decorateRecoveryResult(result, recovery);
    }

    return null;
  }

  private async applyToolRecoveryDecision(
    modelMessages: ChatMessage[],
    callbacks: AgentCallbacks,
    toolCall: ToolCall,
    decision: ToolRecoveryDecision,
  ) {
    const result = decision.result ?? { error: decision.content ?? "Tool recovery stopped." };
    modelMessages.push({
      role: "tool",
      content: JSON.stringify(result),
      name: toolCall.function.name,
      tool_call_id: toolCall.id,
    });
    await callbacks.onToolResult?.({
      id: toolCall.id,
      name: toolCall.function.name,
      result,
      memoryCount: this.getMemoryCount(),
    });
    return decision.content;
  }

  private recoverFromToolResult(
    toolName: string,
    toolInput: unknown,
    toolResult: unknown,
    toolRecovery: ToolLoopRecovery,
  ): ToolRecoveryDecision {
    const error = extractToolError(toolResult);
    const recovery = error
      ? toolRecovery.recordFailure(toolName, toolInput, error)
      : toolRecovery.recordNoProgress(toolName, toolInput, toolResult);

    return decorateRecoveryResult(toolResult, recovery);
  }

  private async notifyDueTask(task: StoredTask) {
    if (task.channel !== "telegram") return;
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: task.chatId,
        text: `Reminder:\n${task.title}`,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!response.ok || body.ok === false) {
      throw new Error(
        `Telegram reminder failed: ${response.status} ${body.description ?? ""}`.trim(),
      );
    }
  }

  private ensureSchema() {
    this.memoryProvider.ensureSchema();
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL,
        tool_input_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE pending_approvals ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
      );
    } catch {
      // Existing deployments already have this column.
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS pending_approvals_chat_idx
      ON pending_approvals (channel, chat_id, session_id, created_at)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS chat_sessions_source_idx
      ON chat_sessions (channel, chat_id, updated_at)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_chat_sessions (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS chat_messages_session_sequence_idx
      ON chat_messages (session_id, sequence)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        notified_at INTEGER
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS tasks_chat_status_idx
      ON tasks (channel, chat_id, status, created_at)
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS tasks_due_idx
      ON tasks (status, due_at)
    `);
  }

  private getMemories() {
    return this.memoryProvider.list();
  }

  private getTasks(filter: { channel?: string; chatId?: string; status?: string } = {}) {
    const normalizedStatus = filter.status === "pending" || filter.status === "done"
      ? filter.status
      : undefined;

    if (filter.channel && filter.chatId && normalizedStatus) {
      return this.query<TaskRow>(
        `
          SELECT id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at
          FROM tasks
          WHERE channel = ? AND chat_id = ? AND status = ?
          ORDER BY
            CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
            due_at ASC,
            created_at DESC
          LIMIT ?
        `,
        filter.channel,
        filter.chatId,
        normalizedStatus,
        MAX_TASKS,
      ).map(rowToTask);
    }

    if (filter.channel && filter.chatId) {
      return this.query<TaskRow>(
        `
          SELECT id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at
          FROM tasks
          WHERE channel = ? AND chat_id = ?
          ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
            CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
            due_at ASC,
            created_at DESC
          LIMIT ?
        `,
        filter.channel,
        filter.chatId,
        MAX_TASKS,
      ).map(rowToTask);
    }

    return this.query<TaskRow>(
      `
        SELECT id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at
        FROM tasks
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
          CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
          due_at ASC,
          created_at DESC
        LIMIT ?
      `,
      MAX_TASKS,
    ).map(rowToTask);
  }

  private getTask(id: string) {
    if (!id) return null;
    const row = this.query<TaskRow>(
      `
        SELECT id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at
        FROM tasks
        WHERE id = ?
        LIMIT 1
      `,
      id,
    )[0];
    return row ? rowToTask(row) : null;
  }

  private saveTask(input: {
    channel: string;
    chatId: string;
    title: string;
    dueAt: number | null;
  }) {
    const now = Date.now();
    const task: StoredTask = {
      id: this.createTaskId(),
      channel: input.channel,
      chatId: input.chatId,
      title: input.title.trim().replace(/\s+/g, " ").slice(0, MAX_MEMORY_CHARS),
      status: "pending",
      due_at: input.dueAt,
      created_at: now,
      completed_at: null,
      notified_at: null,
    };

    if (!task.title) {
      throw new HttpError("Task title is required.", 400);
    }

    this.ctx.storage.sql.exec(
      `
        INSERT INTO tasks
          (id, channel, chat_id, title, status, due_at, created_at, completed_at, notified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      task.id,
      task.channel,
      task.chatId,
      task.title,
      task.status,
      task.due_at,
      task.created_at,
      task.completed_at,
      task.notified_at,
    );
    this.pruneTasks();
    return task;
  }

  private completeTask(id: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `
        UPDATE tasks
        SET status = 'done',
          completed_at = COALESCE(completed_at, ?)
        WHERE id = ?
      `,
      now,
      id,
    );
    const task = this.getTask(id);
    if (!task) throw new HttpError("Task not found.", 404);
    return task;
  }

  private markTaskNotified(id: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `
        UPDATE tasks
        SET status = 'done',
          notified_at = COALESCE(notified_at, ?),
          completed_at = COALESCE(completed_at, ?)
        WHERE id = ?
      `,
      now,
      now,
      id,
    );
  }

  private deleteTask(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM tasks WHERE id = ?", id);
  }

  private pruneTasks() {
    const overflow = this.query<{ id: string }>(
      "SELECT id FROM tasks ORDER BY created_at DESC",
    ).slice(MAX_TASKS);

    for (const row of overflow) {
      this.deleteTask(row.id);
    }
  }

  private assertTaskSource(task: StoredTask, source: ChannelSource | undefined) {
    if (!source) return;
    if (task.channel !== source.channel || task.chatId !== source.chatId) {
      throw new HttpError("Task not found for this channel.", 404);
    }
  }

  private async scheduleNextTaskAlarm(fallbackAt?: number) {
    const next = this.query<{ due_at: number | null }>(
      `
        SELECT MIN(due_at) AS due_at
        FROM tasks
        WHERE status = 'pending' AND due_at IS NOT NULL
      `,
    )[0]?.due_at;

    if (typeof next === "number" && Number.isFinite(next)) {
      await this.ctx.storage.setAlarm(
        fallbackAt ? Math.min(next, fallbackAt) : Math.max(next, Date.now()),
      );
      return;
    }

    if (fallbackAt) {
      await this.ctx.storage.setAlarm(fallbackAt);
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }

  private getActiveRuns(): ActiveAgentRun[] {
    return [...this.activeRuns.values()].map(activeRunToStatus);
  }

  private getStoredLlmSettings(): LlmSettings | null {
    const row = this.query<RuntimeSettingRow>(
      "SELECT key, value_json, updated_at FROM runtime_settings WHERE key = ? LIMIT 1",
      LLM_SETTINGS_KEY,
    )[0];
    if (!row) return null;

    try {
      return parseLlmSettingsPayload(JSON.parse(row.value_json));
    } catch {
      return null;
    }
  }

  private getEffectiveLlmSettings() {
    const stored = this.getStoredLlmSettings();
    if (stored) return { source: "stored" as const, settings: stored };
    const envSettings = createEnvLlmSettings(this.env);
    return envSettings
      ? { source: "env" as const, settings: envSettings }
      : { source: "none" as const, settings: null };
  }

  private getLlmSettingsSummary() {
    const current = this.getEffectiveLlmSettings();
    return current.settings
      ? {
          source: current.source,
          ...summarizeLlmSettings(current.settings, this.env),
        }
      : { source: "none" as const, activeProfileId: undefined, profiles: [] };
  }

  private getLlmSettingsResponse() {
    return {
      source: this.getEffectiveLlmSettings().source,
      settings: this.getEffectiveLlmSettings().settings,
      summary: this.getLlmSettingsSummary(),
    };
  }

  private saveRuntimeSetting(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO runtime_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      key,
      JSON.stringify(value),
      Date.now(),
    );
  }

  private deleteRuntimeSetting(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM runtime_settings WHERE key = ?", key);
  }

  private getActiveRun(source: ChannelSource | undefined) {
    return this.activeRuns.get(sourceToActiveRunKey(source));
  }

  private startActiveRun(source: ChannelSource | undefined): ActiveRunRecord {
    const normalizedSource = normalizeSource(source);
    const activeRun: ActiveRunRecord = {
      ...normalizedSource,
      key: sourceToActiveRunKey(normalizedSource),
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      status: "running",
      abortController: new AbortController(),
      pendingFollowUps: [],
      interruptRequested: false,
      stopRequested: false,
    };
    this.activeRuns.set(activeRun.key, activeRun);
    return activeRun;
  }

  private enqueueFollowUp(activeRun: ActiveRunRecord, payload: ChatRequest) {
    if (activeRun.stopRequested) {
      return false;
    }

    if (activeRun.pendingFollowUps.length >= MAX_ACTIVE_RUN_FOLLOW_UPS) {
      activeRun.pendingFollowUps[activeRun.pendingFollowUps.length - 1] = payload;
      this.interruptActiveRun(activeRun);
      return false;
    }

    activeRun.pendingFollowUps.push(payload);
    this.interruptActiveRun(activeRun);
    return true;
  }

  private dequeueFollowUp(activeRun: ActiveRunRecord) {
    return activeRun.pendingFollowUps.shift();
  }

  private consumeFollowUps(activeRun: ActiveRunRecord) {
    const followUps = activeRun.pendingFollowUps;
    activeRun.pendingFollowUps = [];
    return followUps;
  }

  private dequeueApprovalContinuationFollowUp(
    pendingFollowUps: ChatRequest[],
    activeRun: ActiveRunRecord,
  ) {
    return pendingFollowUps.shift() ?? this.dequeueFollowUp(activeRun);
  }

  private consumeApprovalContinuationFollowUps(
    pendingFollowUps: ChatRequest[],
    activeRun: ActiveRunRecord,
  ) {
    const followUps = pendingFollowUps.splice(0);
    followUps.push(...this.consumeFollowUps(activeRun));
    return followUps;
  }

  private interruptActiveRun(activeRun: ActiveRunRecord) {
    if (activeRun.stopRequested || activeRun.abortController.signal.aborted) return;
    activeRun.interruptRequested = true;
    activeRun.abortController.abort("Interrupted by a follow-up message.");
  }

  private consumeInterrupt(activeRun: ActiveRunRecord) {
    if (!activeRun.interruptRequested || activeRun.stopRequested) return false;
    activeRun.interruptRequested = false;
    activeRun.abortController = new AbortController();
    return true;
  }

  private finishActiveRun(activeRun: ActiveRunRecord) {
    if (this.activeRuns.get(activeRun.key)?.runId === activeRun.runId) {
      this.activeRuns.delete(activeRun.key);
    }
  }

  private stopActiveRuns(source: ChannelSource | undefined) {
    const runs = source
      ? [this.activeRuns.get(sourceToActiveRunKey(source))].filter(isActiveRunRecord)
      : [...this.activeRuns.values()];

    for (const run of runs) {
      run.status = "stopping";
      run.stopRequested = true;
      run.abortController.abort("Stopped by user.");
    }

    return runs.map(activeRunToStatus);
  }

  private withConversationHistory(payload: ChatRequest, session: StoredChatSession): ChatRequest {
    return {
      ...payload,
      sessionId: session.id,
      history: mergeClientHistories(
        this.getChatSessionHistory(session.id),
        payload.history ?? [],
      ),
    };
  }

  private resolveChatSession(payload: Pick<ChatRequest, "source" | "sessionId" | "message">) {
    const source = normalizeSource(payload.source);
    if (payload.sessionId) {
      const session = this.getChatSession(payload.sessionId);
      if (!session || session.channel !== source.channel || session.chatId !== source.chatId) {
        throw new HttpError("Chat session not found for this source.", 404);
      }
      this.setActiveChatSession(source, session.id);
      return session;
    }

    return this.getOrCreateActiveChatSession(source, payload.message);
  }

  private getOrCreateActiveChatSession(source: ChannelSource, titleSeed?: string) {
    const active = this.getActiveChatSession(source);
    if (active) return active;
    return this.createChatSession(source, titleSeed);
  }

  private getActiveChatSession(source: ChannelSource | undefined) {
    const normalizedSource = normalizeSource(source);
    const row = this.query<ActiveChatSessionRow>(
      `
        SELECT channel, chat_id, session_id, updated_at
        FROM active_chat_sessions
        WHERE channel = ? AND chat_id = ?
        LIMIT 1
      `,
      normalizedSource.channel,
      normalizedSource.chatId,
    )[0];
    if (!row) return null;

    const session = this.getChatSession(row.session_id);
    if (!session) {
      this.ctx.storage.sql.exec(
        "DELETE FROM active_chat_sessions WHERE channel = ? AND chat_id = ?",
        normalizedSource.channel,
        normalizedSource.chatId,
      );
      return null;
    }
    return session;
  }

  private getChatSession(sessionId: string) {
    const row = this.query<ChatSessionRow>(
      `
        SELECT id, channel, chat_id, title, created_at, updated_at
        FROM chat_sessions
        WHERE id = ?
        LIMIT 1
      `,
      sessionId,
    )[0];
    return row ? rowToChatSession(row) : null;
  }

  private getChatSessions(source: ChannelSource | undefined) {
    const normalizedSource = normalizeSource(source);
    const activeSessionId = this.getActiveChatSession(normalizedSource)?.id;
    return this.query<ChatSessionRow>(
      `
        SELECT id, channel, chat_id, title, created_at, updated_at
        FROM chat_sessions
        WHERE channel = ? AND chat_id = ?
        ORDER BY updated_at DESC, created_at DESC
      `,
      normalizedSource.channel,
      normalizedSource.chatId,
    ).map((row) => ({
      ...rowToChatSession(row),
      active: row.id === activeSessionId,
    }));
  }

  private createChatSession(source: ChannelSource | undefined, titleSeed?: string) {
    const normalizedSource = normalizeSource(source);
    const now = Date.now();
    const session: StoredChatSession = {
      id: this.generateSessionId(),
      channel: normalizedSource.channel,
      chatId: normalizedSource.chatId,
      title: normalizeSessionTitle(titleSeed),
      created_at: now,
      updated_at: now,
      active: true,
    };
    this.ctx.storage.sql.exec(
      `
        INSERT INTO chat_sessions (id, channel, chat_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      session.id,
      session.channel,
      session.chatId,
      session.title,
      session.created_at,
      session.updated_at,
    );
    this.setActiveChatSession(normalizedSource, session.id);
    return session;
  }

  private switchChatSession(source: ChannelSource | undefined, sessionId: string) {
    const normalizedSource = normalizeSource(source);
    const session = this.getChatSession(sessionId);
    if (!session || session.channel !== normalizedSource.channel || session.chatId !== normalizedSource.chatId) {
      throw new HttpError("Chat session not found for this source.", 404);
    }
    this.setActiveChatSession(normalizedSource, session.id);
    return { ...session, active: true };
  }

  private setActiveChatSession(source: ChannelSource | undefined, sessionId: string) {
    const normalizedSource = normalizeSource(source);
    this.ctx.storage.sql.exec(
      `
        INSERT INTO active_chat_sessions (channel, chat_id, session_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel, chat_id) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `,
      normalizedSource.channel,
      normalizedSource.chatId,
      sessionId,
      Date.now(),
    );
  }

  private getChatSessionHistory(sessionId: string): ClientChatMessage[] {
    return this.query<ChatMessageRow>(
      `
        SELECT id, session_id, channel, chat_id, role, content, sequence, created_at
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY sequence ASC
      `,
      sessionId,
    )
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({ role: row.role, content: row.content }));
  }

  private appendChatMessage(
    session: StoredChatSession,
    role: "user" | "assistant",
    content: string,
  ) {
    const trimmed = content.trim();
    if (!trimmed) return;
    const nextSequence =
      (this.query<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM chat_messages WHERE session_id = ?",
        session.id,
      )[0]?.sequence ?? 0) + 1;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `
        INSERT INTO chat_messages
          (id, session_id, channel, chat_id, role, content, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      this.generateMessageId(),
      session.id,
      session.channel,
      session.chatId,
      role,
      content,
      nextSequence,
      now,
    );
    this.touchChatSession(session.id, now);
  }

  private replacePendingApprovalAssistantMessage(
    sessionId: string | undefined,
    approval: PendingToolApproval,
    content: string,
  ) {
    const session = sessionId ? this.getChatSession(sessionId) : null;
    if (!session) return;
    const rows = this.query<Pick<ChatMessageRow, "id" | "content">>(
      `
        SELECT id, content
        FROM chat_messages
        WHERE session_id = ? AND role = 'assistant'
        ORDER BY sequence DESC
      `,
      session.id,
    );
    const existing = rows.find((row) => isPendingApprovalAssistant(row.content, approval));
    if (!existing) {
      this.appendChatMessage(session, "assistant", content);
      return;
    }
    this.ctx.storage.sql.exec("UPDATE chat_messages SET content = ? WHERE id = ?", content, existing.id);
    this.touchChatSession(session.id);
  }

  private touchChatSession(sessionId: string, updatedAt = Date.now()) {
    this.ctx.storage.sql.exec(
      "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
      updatedAt,
      sessionId,
    );
  }

  private resetConversation(source: ChannelSource | undefined) {
    if (!source) return null;
    return this.createChatSession(source, "New chat");
  }

  private getMemoryCount() {
    return this.memoryProvider.count();
  }

  private saveMemory(content: string) {
    return this.memoryProvider.save(content);
  }

  private deleteMemory(id: string) {
    this.memoryProvider.delete(id);
  }

  private async handleApprove(request: Request, approvalId: string) {
    try {
      const payload = parseApprovalActionPayload(await request.json().catch(() => ({})));
      const result = await this.approvePendingTool(approvalId, payload, {});
      return Response.json({ ok: true, ...result });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private handleApproveStream(request: Request, approvalId: string) {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    this.ctx.waitUntil(
      (async () => {
        try {
          const payload = parseApprovalActionPayload(await request.json().catch(() => ({})));
          const result = await this.approvePendingTool(approvalId, payload, {
            onMeta: async (data) => writeSse(writer, "meta", data),
            onToken: async (token) => writeSse(writer, "message_delta", { delta: token }),
            onToolResult: async (data) => writeSse(writer, "tool_result", data),
          });
          await writeSse(writer, "done", result);
        } catch (error) {
          await writeSse(writer, "error", {
            message: error instanceof Error ? error.message : "Approval failed.",
          });
        } finally {
          await writer.close();
        }
      })(),
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async handleDeny(request: Request, approvalId: string) {
    try {
      const payload = parseApprovalActionPayload(await request.json().catch(() => ({})));
      const approval = this.getPendingApproval(approvalId);
      if (!approval) {
        throw new HttpError("Approval not found.", 404);
      }
      this.assertApprovalSource(approval, payload.source);
      this.deletePendingApproval(approval.id);
      this.deletePausedApprovalSession(approval.id);
      return Response.json({ ok: true, denied: approval });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private createPendingApproval(
    source: ChannelSource | undefined,
    sessionId: string | undefined,
    tool: ToolDefinition,
    input: unknown,
  ) {
    this.pruneApprovals();

    const toolInputJson = stableJsonStringify(input);
    if (toolInputJson.length > MAX_TOOL_INPUT_JSON_CHARS) {
      throw new Error(`Tool input is too large to approve: ${tool.name}`);
    }

    const channel = source?.channel ?? "api";
    const chatId = source?.chatId ?? "default";
    const normalizedSessionId = sessionId ?? "";
    const existing = this.query<PendingApprovalRow>(
      `
        SELECT id, channel, chat_id, session_id, tool_name, tool_input_json, risk, created_at, expires_at
        FROM pending_approvals
        WHERE channel = ?
          AND chat_id = ?
          AND session_id = ?
          AND tool_name = ?
          AND tool_input_json = ?
          AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      channel,
      chatId,
      normalizedSessionId,
      tool.name,
      toolInputJson,
      Date.now(),
    )[0];
    if (existing) return rowToApproval(existing);

    const now = Date.now();
    const approval: PendingToolApproval = {
      id: this.createApprovalId(),
      channel,
      chatId,
      sessionId,
      toolName: tool.name,
      toolInput: input,
      risk: tool.risk,
      created_at: now,
      expires_at: now + APPROVAL_TTL_MS,
    };

    this.ctx.storage.sql.exec(
      `
        INSERT INTO pending_approvals
          (id, channel, chat_id, session_id, tool_name, tool_input_json, risk, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      approval.id,
      approval.channel,
      approval.chatId,
      normalizedSessionId,
      approval.toolName,
      toolInputJson,
      approval.risk,
      approval.created_at,
      approval.expires_at,
    );
    this.pruneApprovals();
    return approval;
  }

  private savePausedApprovalSession(
    approval: PendingToolApproval,
    paused: Omit<PausedApprovalSession, "approvalId" | "expiresAt">,
  ) {
    this.prunePausedApprovalSessions();
    this.pausedApprovals.set(approval.id, {
      ...paused,
      approvalId: approval.id,
      modelMessages: cloneChatMessages(paused.modelMessages),
      pendingFollowUps: cloneChatRequests(paused.pendingFollowUps),
      expiresAt: approval.expires_at,
    });
  }

  private takePausedApprovalSession(approvalId: string) {
    this.prunePausedApprovalSessions();
    const paused = this.pausedApprovals.get(approvalId);
    this.pausedApprovals.delete(approvalId);
    return paused;
  }

  private getPausedApprovalForSession(source: ChannelSource | undefined, sessionId: string) {
    this.prunePausedApprovalSessions();
    const normalizedSource = normalizeSource(source);
    return [...this.pausedApprovals.values()]
      .filter((paused) => {
        const pausedSource = normalizeSource(paused.source);
        return (
          pausedSource.channel === normalizedSource.channel &&
          pausedSource.chatId === normalizedSource.chatId &&
          paused.sessionId === sessionId
        );
      })
      .sort((left, right) => right.expiresAt - left.expiresAt)[0];
  }

  private enqueuePausedApprovalFollowUp(
    paused: PausedApprovalSession,
    payload: ChatRequest,
  ) {
    if (paused.pendingFollowUps.length >= MAX_ACTIVE_RUN_FOLLOW_UPS) {
      paused.pendingFollowUps[paused.pendingFollowUps.length - 1] = payload;
      return false;
    }

    paused.pendingFollowUps.push(payload);
    return true;
  }

  private deletePausedApprovalSession(approvalId: string) {
    this.pausedApprovals.delete(approvalId);
  }

  private prunePausedApprovalSessions() {
    const now = Date.now();
    for (const [approvalId, paused] of this.pausedApprovals) {
      if (paused.expiresAt <= now || !this.getPendingApproval(approvalId)) {
        this.pausedApprovals.delete(approvalId);
      }
    }
  }

  private async approvePendingTool(
    approvalId: string,
    payload: { source?: ChannelSource; llm?: LlmConfig },
    callbacks: AgentCallbacks,
  ) {
    const approval = this.getPendingApproval(approvalId);
    if (!approval) {
      throw new HttpError("Approval not found.", 404);
    }
    this.assertApprovalSource(approval, payload.source);
    if (approval.expires_at <= Date.now()) {
      this.deletePendingApproval(approval.id);
      throw new HttpError("Approval expired.", 410);
    }

    const runSource = payload.source ?? {
      channel: approval.channel,
      chatId: approval.chatId,
    };
    const existingRun = this.getActiveRun(runSource);
    if (existingRun) {
      throw new HttpError("A response is already running for this approval source.", 409);
    }

    const activeRun = this.startActiveRun(runSource);
    try {
      return await this.runApprovedTool(approval, payload, callbacks, activeRun);
    } catch (error) {
      if (activeRun.stopRequested) {
        return {
          approval,
          content: "Stopped.",
          stopped: true,
          memoryCount: this.getMemoryCount(),
        };
      }
      throw error;
    } finally {
      this.finishActiveRun(activeRun);
    }
  }

  private async runApprovedTool(
    approval: PendingToolApproval,
    payload: { source?: ChannelSource; llm?: LlmConfig },
    callbacks: AgentCallbacks,
    activeRun: ActiveRunRecord,
  ) {
    const paused = this.takePausedApprovalSession(approval.id);
    this.deletePendingApproval(approval.id);
    await callbacks.onMeta?.({ approval });
    throwIfAborted(activeRun.abortController.signal);

    const registry = createDefaultToolRegistry(this.env);
    const toolExecutor = new ToolExecutor(registry, this.createToolContext(), {
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
    const execution = await toolExecutor.executeStoredTool(approval.toolName, approval.toolInput, {
      bypassApproval: true,
    });
    const toolResult =
      execution.status === "executed"
        ? execution.result
        : { error: `Unexpected approval gate for ${approval.toolName}.` };
    throwIfAborted(activeRun.abortController.signal);

    await callbacks.onToolResult?.({
      id: approval.id,
      name: approval.toolName,
      result: toolResult,
      memoryCount: this.getMemoryCount(),
    });

    if (paused) {
      const resumed = await this.resumePausedApprovalSession(
        paused,
        approval,
        toolResult,
        payload.llm ?? paused.llm,
        callbacks,
        activeRun,
      );
      return {
        approval,
        toolResult,
        ...resumed,
        memoryCount: this.getMemoryCount(),
      };
    }

    const content = payload.llm
      ? await this.summarizeApprovedTool(
          approval,
          toolResult,
          payload.llm,
          callbacks,
          activeRun.abortController.signal,
        )
      : formatApprovedToolResult(approval, toolResult);
    if (approval.sessionId) {
      this.replacePendingApprovalAssistantMessage(approval.sessionId, approval, content);
    }

    return {
      approval,
      toolResult,
      content,
      memoryCount: this.getMemoryCount(),
    };
  }

  private async resumePausedApprovalSession(
    paused: PausedApprovalSession,
    approval: PendingToolApproval,
    toolResult: unknown,
    llm: LlmConfig,
    callbacks: AgentCallbacks,
    activeRun: ActiveRunRecord,
  ) {
    const modelMessages = cloneChatMessages(paused.modelMessages);
    modelMessages.push({
      role: "tool",
      content: JSON.stringify(toolResult),
      name: paused.toolName,
      tool_call_id: paused.toolCallId,
    });

    const pendingFollowUps = cloneChatRequests(paused.pendingFollowUps);
    const source = paused.source ?? { channel: approval.channel, chatId: approval.chatId };
    const sessionId = paused.sessionId ?? approval.sessionId;
    let currentLlm = llm;
    let nextStep: number | undefined = paused.nextStep;
    let combinedContent = "";
    let firstTurn = true;
    let currentFollowUp: ChatRequest | undefined;

    while (true) {
      let result: Awaited<ReturnType<UserAgentObject["runAgentWithMessages"]>>;
      try {
        result = await this.runAgentWithMessages({
          llm: currentLlm,
          source,
          sessionId,
          modelMessages,
          callbacks,
          signal: activeRun.abortController.signal,
          startStep: nextStep,
          consumePendingFollowUps: () =>
            this.consumeApprovalContinuationFollowUps(pendingFollowUps, activeRun),
        });
      } catch (error) {
        if (!this.consumeInterrupt(activeRun)) throw error;

        const interruptedFollowUp = this.dequeueApprovalContinuationFollowUp(
          pendingFollowUps,
          activeRun,
        );
        if (!interruptedFollowUp) {
          combinedContent = appendParagraph(combinedContent, "Interrupted by a new message.");
          break;
        }

        await callbacks.onToken?.(formatInterruptStreamBoundary(interruptedFollowUp.message));
        modelMessages.push({
          role: "user",
          content: interruptedFollowUp.message,
        });
        currentLlm = interruptedFollowUp.llm ?? currentLlm;
        nextStep = undefined;
        currentFollowUp = interruptedFollowUp;
        firstTurn = false;
        continue;
      }

      combinedContent = firstTurn
        ? appendParagraph(combinedContent, result.content)
        : appendParagraph(
            combinedContent,
            `Follow-up:\n${result.content.trim() || "No response."}`,
          );
      if (currentFollowUp && sessionId) {
        const session = this.getChatSession(sessionId);
        if (session) {
          this.appendChatMessage(session, "user", currentFollowUp.message);
          this.appendChatMessage(session, "assistant", result.content);
        }
      } else if (sessionId) {
        this.replacePendingApprovalAssistantMessage(sessionId, approval, result.content);
      }
      nextStep = undefined;
      firstTurn = false;
      currentFollowUp = undefined;

      if (result.pendingApproval) {
        if (result.pausedFollowUpCount > 0) {
          combinedContent = appendParagraph(
            combinedContent,
            formatApprovalPausedFollowUpsMessage(result.pausedFollowUpCount),
          );
        }
        return {
          content: combinedContent,
          pendingApproval: result.pendingApproval,
          resumed: true,
        };
      }

      const followUp = this.dequeueApprovalContinuationFollowUp(pendingFollowUps, activeRun);
      if (!followUp) break;

      await callbacks.onToken?.(formatFollowUpStreamBoundary(followUp.message));
      modelMessages.push({
        role: "user",
        content: followUp.message,
      });
      currentLlm = followUp.llm ?? currentLlm;
      currentFollowUp = followUp;
    }

    return {
      content: combinedContent,
      resumed: true,
    };
  }

  private async summarizeApprovedTool(
    approval: PendingToolApproval,
    toolResult: unknown,
    llm: LlmConfig,
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ) {
    const resultText = stringifyForPrompt(toolResult, MAX_TOOL_RESULT_SUMMARY_CHARS);
    const response = await streamChatCompletion({
      config: llm,
      messages: [
        {
          role: "system",
          content:
            "You summarize approved tool results for a personal assistant. Be concise, practical, and do not invent details.",
        },
        {
          role: "user",
          content: [
            "The user approved this tool call.",
            `Tool: ${approval.toolName}`,
            `Input JSON: ${stringifyForPrompt(approval.toolInput, 2_000)}`,
            `Result JSON: ${resultText}`,
            "Summarize the useful result and mention any obvious next step.",
          ].join("\n"),
        },
      ],
      signal,
      onToken: async (token) => {
        throwIfAborted(signal);
        await callbacks.onToken?.(token);
      },
    });

    return response.content.trim() || formatApprovedToolResult(approval, toolResult);
  }

  private async curateMemory(content: string, llm: LlmConfig) {
    const response = await streamChatCompletion({
      config: llm,
      messages: [
        {
          role: "system",
          content: [
            "You curate durable memory for a personal assistant.",
            "Rewrite the user's note into one concise memory item that will be useful in future conversations.",
            "Keep stable preferences, personal facts, project context, and recurring instructions.",
            "Do not store transient chat wording, task reminders, secrets, API keys, passwords, or raw credentials.",
            "Do not invent details. Use the same language as the user's note when practical.",
            "Return only the memory item, without bullets, labels, quotes, or explanation.",
          ].join(" "),
        },
        {
          role: "user",
          content,
        },
      ],
      onToken: async () => undefined,
    });

    const curated = response.content.trim().replace(/\s+/g, " ");
    if (!curated) {
      throw new HttpError("The model did not return a memory item.", 502);
    }
    return curated;
  }

  private getPendingApprovals(filter: { channel?: string; chatId?: string } = {}) {
    this.pruneApprovals();

    if (filter.channel && filter.chatId) {
      return this.query<PendingApprovalRow>(
        `
          SELECT id, channel, chat_id, session_id, tool_name, tool_input_json, risk, created_at, expires_at
          FROM pending_approvals
          WHERE channel = ? AND chat_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        filter.channel,
        filter.chatId,
        MAX_PENDING_APPROVALS,
      ).map(rowToApproval);
    }

    return this.query<PendingApprovalRow>(
      `
        SELECT id, channel, chat_id, session_id, tool_name, tool_input_json, risk, created_at, expires_at
        FROM pending_approvals
        ORDER BY created_at DESC
        LIMIT ?
      `,
      MAX_PENDING_APPROVALS,
    ).map(rowToApproval);
  }

  private getPendingApproval(id: string) {
    if (!id) return null;
    this.pruneApprovals();
    const row = this.query<PendingApprovalRow>(
      `
        SELECT id, channel, chat_id, session_id, tool_name, tool_input_json, risk, created_at, expires_at
        FROM pending_approvals
        WHERE id = ?
        LIMIT 1
      `,
      id,
    )[0];

    return row ? rowToApproval(row) : null;
  }

  private deletePendingApproval(id: string) {
    this.ctx.storage.sql.exec("DELETE FROM pending_approvals WHERE id = ?", id);
  }

  private pruneApprovals() {
    this.ctx.storage.sql.exec("DELETE FROM pending_approvals WHERE expires_at <= ?", Date.now());

    const overflow = this.query<{ id: string }>(
      "SELECT id FROM pending_approvals ORDER BY created_at DESC",
    ).slice(MAX_PENDING_APPROVALS);

    for (const row of overflow) {
      this.deletePendingApproval(row.id);
    }
  }

  private assertApprovalSource(approval: PendingToolApproval, source: ChannelSource | undefined) {
    if (!source) return;
    if (approval.channel !== source.channel || approval.chatId !== source.chatId) {
      throw new HttpError("Approval not found for this channel.", 404);
    }
  }

  private createApprovalId() {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!this.getPendingApproval(id)) return id;
    }

    return crypto.randomUUID();
  }

  private createTaskId() {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const id = `t_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (!this.getTask(id)) return id;
    }

    return `t_${crypto.randomUUID().slice(0, 8)}`;
  }

  private generateSessionId() {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      const id = `s_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (!this.getChatSession(id)) return id;
    }

    return `s_${crypto.randomUUID()}`;
  }

  private generateMessageId() {
    return `m_${crypto.randomUUID()}`;
  }

  private createToolContext(): ToolContext {
    return {
      fetch: (input, init) => fetch(input, init),
      saveMemory: async (content) => {
        this.saveMemory(content);
      },
      searchMemory: async (query) => this.searchMemory(query),
    };
  }

  private async searchMemory(query: string) {
    return this.memoryProvider.search(query);
  }

  private query<T>(sql: string, ...bindings: Array<string | number | null>) {
    return [...this.ctx.storage.sql.exec(sql, ...bindings)] as T[];
  }
}

async function readChatRequest(request: Request): Promise<ChatRequest> {
  return parseChatRequestPayload(await request.json().catch(() => ({})));
}

async function writeSse<EventName extends AgentStreamEventName>(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: EventName,
  data: Extract<AgentStreamEvent, { event: EventName }>["data"],
) {
  await writeAgentStreamEvent(writer, { event, data } as AgentStreamEvent);
}

function rowToApproval(row: PendingApprovalRow): PendingToolApproval {
  return {
    id: row.id,
    channel: row.channel,
    chatId: row.chat_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    toolName: row.tool_name,
    toolInput: parseStoredJson(row.tool_input_json),
    risk: row.risk,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function rowToTask(row: TaskRow): StoredTask {
  return {
    id: row.id,
    channel: row.channel,
    chatId: row.chat_id,
    title: row.title,
    status: row.status,
    due_at: row.due_at,
    created_at: row.created_at,
    completed_at: row.completed_at,
    notified_at: row.notified_at,
  };
}

function rowToChatSession(row: ChatSessionRow): StoredChatSession {
  return {
    id: row.id,
    channel: row.channel,
    chatId: row.chat_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseStoredJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function formatApprovalRequiredMessage(approval: PendingToolApproval) {
  return [
    `Tool approval required: ${approval.toolName}`,
    `Risk: ${approval.risk}`,
    `Input: ${stringifyForPrompt(approval.toolInput, 700)}`,
    `Approve: /approve ${approval.id}`,
    `Deny: /deny ${approval.id}`,
  ].join("\n");
}

function formatApprovedToolResult(approval: PendingToolApproval, toolResult: unknown) {
  return [
    `Approved tool executed: ${approval.toolName}`,
    stringifyForPrompt(toolResult, 3_500),
  ].join("\n\n");
}

function appendParagraph(content: string, paragraph: string) {
  const trimmedContent = content.trim();
  const trimmedParagraph = paragraph.trim();
  if (!trimmedContent) return trimmedParagraph;
  if (!trimmedParagraph) return trimmedContent;
  return `${trimmedContent}\n\n${trimmedParagraph}`;
}

function normalizeSessionTitle(seed: string | undefined) {
  const title = (seed ?? "").trim().replace(/\s+/g, " ");
  return (title || "New chat").slice(0, MAX_SESSION_TITLE_CHARS);
}

function mergeClientHistories(
  storedHistory: ClientChatMessage[],
  requestHistory: ClientChatMessage[],
) {
  const stored = clampConversationHistory(storedHistory);
  const requested = clampConversationHistory(requestHistory);
  if (requested.length === 0) return stored;
  if (stored.length === 0) return requested;

  const overlap = longestHistoryOverlap(stored, requested);
  return clampConversationHistory([...stored, ...requested.slice(overlap)]);
}

function longestHistoryOverlap(left: ClientChatMessage[], right: ClientChatMessage[]) {
  const maxOverlap = Math.min(left.length, right.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const leftTail = left.slice(left.length - size);
    const rightHead = right.slice(0, size);
    if (leftTail.every((message, index) => isSameClientMessage(message, rightHead[index]))) {
      return size;
    }
  }

  return 0;
}

function isSameClientMessage(left: ClientChatMessage, right: ClientChatMessage) {
  return left.role === right.role && left.content === right.content;
}

function isPendingApprovalAssistant(content: string, approval: PendingToolApproval) {
  return (
    content.includes(`Tool approval required: ${approval.toolName}`) &&
    content.includes(`/approve ${approval.id}`)
  );
}

function clampConversationHistory(history: ClientChatMessage[]) {
  return history
    .filter(
      (message): message is ClientChatMessage =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function normalizeSource(source: ChannelSource | undefined): ChannelSource {
  return {
    channel: source?.channel ?? "api",
    chatId: source?.chatId ?? "default",
  };
}

function sourceToActiveRunKey(source: ChannelSource | undefined) {
  const normalizedSource = normalizeSource(source);
  return `${normalizedSource.channel}:${normalizedSource.chatId}`;
}

function activeRunToStatus(run: ActiveRunRecord): ActiveAgentRun {
  return {
    runId: run.runId,
    channel: run.channel,
    chatId: run.chatId,
    startedAt: run.startedAt,
    status: run.status,
    queuedMessageCount: run.pendingFollowUps.length,
  };
}

function isActiveRunRecord(run: ActiveRunRecord | undefined): run is ActiveRunRecord {
  return Boolean(run);
}

function formatActiveRunMessage(run: ActiveRunRecord, queued: boolean) {
  const seconds = Math.max(1, Math.round((Date.now() - run.startedAt) / 1000));
  const queueState = queued
    ? "Queued your message and interrupted the current response."
    : "Follow-up queue is full, so the newest message replaced the last queued turn and interrupted the current response.";
  return `${queueState}\n\nA response is already running in this chat (${seconds}s). Send /stop to cancel it.`;
}

function formatPausedApprovalMessage(paused: PausedApprovalSession, queued: boolean) {
  const queueState = queued
    ? "Added your message to the pending approval context."
    : "Pending approval context is full, so your newest message replaced the last queued note.";
  return `${queueState}\n\nApprove or deny the pending tool call to continue: ${paused.approvalId}`;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new Error("Run stopped.");
}

function appendEphemeralTurn(
  history: ChatRequest["history"],
  user: string,
  assistant: string,
) {
  return [
    ...(history ?? []),
    { role: "user" as const, content: user },
    { role: "assistant" as const, content: assistant || "No response." },
  ];
}

function appendEphemeralUser(
  history: ChatRequest["history"],
  user: string,
) {
  return [
    ...(history ?? []),
    { role: "user" as const, content: user },
  ];
}

function buildUserContent(message: string, attachments: ChatRequest["attachments"]) {
  if (!attachments?.length) return message;
  return [
    { type: "text" as const, text: message },
    ...attachments,
  ];
}

function formatFollowUpStreamBoundary(message: string) {
  const preview = message.trim().replace(/\s+/g, " ").slice(0, 120);
  return `\n\nFollow-up${preview ? `: ${preview}` : ""}\n`;
}

function formatInterruptStreamBoundary(message: string) {
  const preview = message.trim().replace(/\s+/g, " ").slice(0, 120);
  return `\n\nInterrupted by new message${preview ? `: ${preview}` : ""}\n`;
}

function formatApprovalPausedFollowUpsMessage(count: number) {
  const noun = count === 1 ? "follow-up was" : "follow-ups were";
  return `${count} queued ${noun} paused for tool approval and will continue after the tool is approved.`;
}

function parseToolCallJson(rawArguments: string) {
  const trimmed = rawArguments.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return new Error("Invalid tool arguments JSON.");
  }
}

function extractToolError(result: unknown) {
  if (typeof result !== "object" || result === null || !("error" in result)) return null;
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function decorateRecoveryResult(
  result: unknown,
  recovery: ToolRecoveryResult,
): ToolRecoveryDecision {
  if (recovery.hardStop) {
    return {
      result: {
        ...toRecordResult(result),
        recoveryHardStop: recovery.hardStop,
        recoveryCount: recovery.count,
      },
      content: recovery.hardStop,
    };
  }

  if (recovery.warning) {
    return {
      result: {
        ...toRecordResult(result),
        recoveryWarning: recovery.warning,
        recoveryCount: recovery.count,
      },
    };
  }

  return { result };
}

function toRecordResult(result: unknown) {
  return typeof result === "object" && result !== null
    ? (result as Record<string, unknown>)
    : { result };
}

function cloneChatMessages(messages: ChatMessage[]) {
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function cloneChatRequests(requests: ChatRequest[]) {
  return JSON.parse(JSON.stringify(requests)) as ChatRequest[];
}

function stringifyForPrompt(value: unknown, maxChars: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

function errorResponse(error: unknown) {
  const status = error instanceof HttpError ? error.status : 400;
  return Response.json(
    {
      ok: false,
      error: error instanceof Error ? error.message : "Request failed.",
    },
    { status },
  );
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

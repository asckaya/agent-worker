import { afterEach, describe, expect, it, vi } from "vitest";
import { readServerSentEvents } from "../src/worker/channels/sse";
import { UserAgentObject } from "../src/worker/do/UserAgentObject";
import type { AgentStreamEvent } from "../src/worker/channels/types";
import type { ChatRequest, Env, LlmConfig, StoredMemory } from "../src/worker/types";

describe("UserAgentObject run state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("collects messages while waiting for approval and resumes them after approval", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const llmResponses: MockLlmResponse[] = [
      openAiToolCallResponse("fetch_url", { url: "https://example.com" }),
      openAiTextResponse("Approved summary"),
      openAiTextResponse("Queued follow-up answer"),
    ];
    vi.stubGlobal("fetch", createFetchMock(llmResponses));

    const firstEvents = await readEvents(
      await object.fetch(chatRequest("fetch this page")),
    );
    const approval = approvalFromEvents(firstEvents);
    expect(approval.toolName).toBe("fetch_url");
    expect(sql.pendingApprovals).toHaveLength(1);

    const queuedEvents = await readEvents(
      await object.fetch(chatRequest("also mention why it matters")),
    );
    expect(doneContent(queuedEvents)).toContain("Added your message to the pending approval context.");

    const approvedEvents = await readEvents(
      await object.fetch(approveRequest(approval.id)),
    );
    const content = doneContent(approvedEvents);
    expect(content).toContain("Approved summary");
    expect(content).toContain("Follow-up:\nQueued follow-up answer");
    expect(sql.pendingApprovals).toHaveLength(0);
    expect(sql.memories).toHaveLength(0);
  });

  it("treats approval continuation as an active interruptible run", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const delayed = delayedOpenAiTextResponse("Old response");
    const llmResponses: MockLlmResponse[] = [
      openAiToolCallResponse("fetch_url", { url: "https://example.com" }),
      delayed.response,
      openAiTextResponse("Interrupt follow-up answer"),
    ];
    vi.stubGlobal("fetch", createFetchMock(llmResponses));

    const firstEvents = await readEvents(
      await object.fetch(chatRequest("fetch this page")),
    );
    const approval = approvalFromEvents(firstEvents);

    const approveResponse = await object.fetch(approveRequest(approval.id));
    const approveEventsPromise = readEvents(approveResponse);
    await delayed.started;

    const stateWhileApproving = await object.fetch(new Request("https://agent.test/state"));
    await expect(stateWhileApproving.json()).resolves.toMatchObject({
      activeRuns: [
        {
          channel: "telegram",
          chatId: "123",
          queuedMessageCount: 0,
          status: "running",
        },
      ],
    });

    const interruptEvents = await readEvents(
      await object.fetch(chatRequest("use this newer instruction")),
    );
    expect(doneContent(interruptEvents)).toContain("Queued your message and interrupted the current response.");

    delayed.finish();
    const approvedEvents = await approveEventsPromise;
    expect(doneContent(approvedEvents)).toContain("Follow-up:\nInterrupt follow-up answer");

    const finalState = await object.fetch(new Request("https://agent.test/state"));
    await expect(finalState.json()).resolves.toMatchObject({ activeRuns: [] });
  });

  it("stores bounded non-secret LLM profiles and resolves key availability from env", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql, { OPENROUTER_API_KEY: "secret-key" } as Partial<Env>);

    const update = await object.fetch(
      jsonRequest(
        "/settings/llm",
        {
          activeProfileId: "openrouter",
          profiles: [
            {
              id: "openrouter",
              name: "OpenRouter",
              baseUrl: "https://openrouter.ai/api/v1",
              model: "google/gemma-4-31b-it:free",
              apiKeyEnv: "OPENROUTER_API_KEY",
              maxTokens: 8192,
            },
          ],
        },
        "PUT",
      ),
    );

    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      ok: true,
      source: "stored",
      summary: {
        activeProfileId: "openrouter",
        profiles: [
          {
            id: "openrouter",
            apiKeyEnv: "OPENROUTER_API_KEY",
            hasApiKey: true,
          },
        ],
      },
    });
    expect(sql.runtimeSettings[0]?.value_json).toContain("OPENROUTER_API_KEY");
    expect(sql.runtimeSettings[0]?.value_json).not.toContain("secret-key");

    const state = await object.fetch(new Request("https://agent.test/state"));
    await expect(state.json()).resolves.toMatchObject({
      llm: {
        source: "stored",
        activeProfileId: "openrouter",
        profiles: [{ id: "openrouter", hasApiKey: true }],
      },
    });
  });

  it("reads non-secret LLM profiles from LLM_PROFILES_JSON env", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql, {
      LLM_PROFILES_JSON: JSON.stringify({
        activeProfileId: "openrouter",
        profiles: [
          {
            id: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "google/gemma-4-31b-it:free",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
        ],
      }),
      OPENROUTER_API_KEY: "secret-key",
    } as Partial<Env>);

    const response = await object.fetch(new Request("https://agent.test/settings/llm"));

    expect(sql.runtimeSettings).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      source: "env",
      summary: {
        activeProfileId: "openrouter",
        profiles: [{ id: "openrouter", hasApiKey: true }],
      },
    });
  });

  it("stores tasks and reschedules reminder alarms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const dueAt = Date.now() + 60_000;

    const create = await object.fetch(
      jsonRequest("/tasks", {
        source: { channel: "telegram", chatId: "123" },
        title: "pay the bill",
        dueAt,
      }),
    );

    expect(create.status).toBe(200);
    const created = (await create.json()) as { task: { id: string } };
    expect(sql.tasks).toHaveLength(1);
    expect(sql.alarm).toBe(dueAt);

    const list = await object.fetch(
      new Request("https://agent.test/tasks?channel=telegram&chatId=123&status=pending"),
    );
    await expect(list.json()).resolves.toMatchObject({
      ok: true,
      tasks: [{ id: created.task.id, title: "pay the bill", status: "pending" }],
    });

    const done = await object.fetch(
      jsonRequest(`/tasks/${created.task.id}/done`, {
        source: { channel: "telegram", chatId: "123" },
      }),
    );

    expect(done.status).toBe(200);
    expect(sql.tasks[0]?.status).toBe("done");
    expect(sql.alarm).toBeNull();
  });

  it("sends due Telegram reminders from Durable Object alarms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
    const sql = new FakeSqlStorage();
    const object = createObject(sql, { TELEGRAM_BOT_TOKEN: "bot-token" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));

    await object.fetch(
      jsonRequest("/tasks", {
        source: { channel: "telegram", chatId: "123" },
        title: "stand up",
        dueAt: Date.now() - 1,
      }),
    );
    await object.alarm();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Reminder:\nstand up",
        }),
      }),
    );
    expect(sql.tasks[0]?.status).toBe("done");
    expect(sql.tasks[0]?.notified_at).toBe(Date.now());
  });

  it("resolves AI Gateway LLM profile metadata into a base URL", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql, { OPENROUTER_API_KEY: "secret-key" } as Partial<Env>);

    const update = await object.fetch(
      jsonRequest(
        "/settings/llm",
        {
          activeProfileId: "gateway",
          profiles: [
            {
              id: "gateway",
              aiGateway: {
                accountId: "account123",
                gatewayId: "my-gateway",
                provider: "openrouter",
              },
              model: "openai/gpt-5-mini",
              apiKeyEnv: "OPENROUTER_API_KEY",
            },
          ],
        },
        "PUT",
      ),
    );

    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      ok: true,
      summary: {
        activeProfileId: "gateway",
        profiles: [
          {
            id: "gateway",
            baseUrl: "https://gateway.ai.cloudflare.com/v1/account123/my-gateway/openrouter",
            hasApiKey: true,
          },
        ],
      },
    });
    expect(sql.runtimeSettings[0]?.value_json).not.toContain("secret-key");
  });

  it("rejects secret-bearing LLM extra headers", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);

    const response = await object.fetch(
      jsonRequest(
        "/settings/llm",
        {
          activeProfileId: "bad",
          profiles: [
            {
              id: "bad",
              baseUrl: "https://api.example.test/v1",
              model: "example-model",
              apiKeyEnv: "LLM_API_KEY",
              extraHeaders: {
                Authorization: "Bearer should-not-be-stored",
              },
            },
          ],
        },
        "PUT",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Use apiKeyEnv for secret-bearing headers."),
    });
    expect(sql.runtimeSettings).toHaveLength(0);
  });
});

function createObject(sql: FakeSqlStorage, env: Partial<Env> = {}) {
  const ctx = {
    storage: {
      sql,
      setAlarm: async (timestamp: number) => {
        sql.alarm = timestamp;
      },
      deleteAlarm: async () => {
        sql.alarm = null;
      },
    },
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
  } as unknown as DurableObjectState;

  return new UserAgentObject(ctx, env as Env);
}

function chatRequest(message: string) {
  const payload: ChatRequest = {
    message,
    llm: llmConfig(),
    source: { channel: "telegram", chatId: "123" },
  };
  return jsonRequest("/chat", payload);
}

function approveRequest(approvalId: string) {
  return jsonRequest(`/approvals/${encodeURIComponent(approvalId)}/approve-stream`, {
    source: { channel: "telegram", chatId: "123" },
    llm: llmConfig(),
  });
}

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function llmConfig(): LlmConfig {
  return {
    baseUrl: "https://llm.test/v1",
    apiKey: "key",
    model: "gpt-test",
  };
}

async function readEvents(response: Response) {
  const events: AgentStreamEvent[] = [];
  for await (const event of readServerSentEvents(response)) {
    events.push(event);
  }
  return events;
}

function approvalFromEvents(events: AgentStreamEvent[]) {
  const event = events.find((item) => item.event === "approval_required");
  expect(event).toBeDefined();
  const approval = (event as Extract<AgentStreamEvent, { event: "approval_required" }>).data
    .approval as { id: string; toolName: string };
  expect(approval.id).toEqual(expect.any(String));
  return approval;
}

function doneContent(events: AgentStreamEvent[]) {
  const done = [...events].reverse().find((event) => event.event === "done");
  expect(done).toBeDefined();
  const content = (done as Extract<AgentStreamEvent, { event: "done" }>).data.content;
  expect(typeof content).toBe("string");
  return content as string;
}

type MockLlmResponse = Response | (() => Response);

function createFetchMock(llmResponses: MockLlmResponse[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://llm.test/")) {
      const response = llmResponses.shift();
      if (!response) throw new Error("Unexpected LLM request.");
      return typeof response === "function" ? response() : response;
    }

    if (url === "https://example.com/") {
      return new Response("Example page body", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function openAiTextResponse(text: string) {
  return openAiSse([{ choices: [{ delta: { content: text } }] }, "[DONE]"]);
}

function delayedOpenAiTextResponse(text: string) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  return {
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            resolveStarted();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    started,
    finish() {
      controller?.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
      );
      controller?.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller?.close();
    },
  };
}

function openAiToolCallResponse(toolName: string, input: unknown) {
  const args = JSON.stringify(input);
  const midpoint = Math.ceil(args.length / 2);
  return openAiSse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: toolName, arguments: args.slice(0, midpoint) },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: { arguments: args.slice(midpoint) },
              },
            ],
          },
        },
      ],
    },
    "[DONE]",
  ]);
}

function openAiSse(events: Array<unknown | "[DONE]">) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

interface PendingApprovalRow {
  id: string;
  channel: string;
  chat_id: string;
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

class FakeSqlStorage {
  readonly memories: StoredMemory[] = [];
  readonly pendingApprovals: PendingApprovalRow[] = [];
  readonly runtimeSettings: RuntimeSettingRow[] = [];
  readonly tasks: TaskRow[] = [];
  alarm: number | null = null;

  exec(sql: string, ...bindings: Array<string | number | null>) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE ")) return [];

    if (normalized === "SELECT COUNT(*) AS count FROM memories") {
      return [{ count: this.memories.length }];
    }

    if (normalized.startsWith("SELECT id, content, created_at FROM memories WHERE content = ?")) {
      return this.memories.filter((memory) => memory.content === bindings[0]).slice(0, 1);
    }

    if (normalized.startsWith("SELECT id, content, created_at FROM memories ORDER BY created_at DESC")) {
      return this.memories
        .slice()
        .sort((left, right) => right.created_at - left.created_at)
        .slice(0, Number(bindings[0]));
    }

    if (normalized.startsWith("INSERT INTO memories")) {
      const [id, content, createdAt] = bindings;
      this.memories.push({
        id: String(id),
        content: String(content),
        created_at: Number(createdAt),
      });
      return [];
    }

    if (normalized === "DELETE FROM memories WHERE id = ?") {
      this.deleteRows(this.memories, (memory) => memory.id === bindings[0]);
      return [];
    }

    if (normalized === "SELECT id FROM memories ORDER BY created_at DESC") {
      return this.memories
        .slice()
        .sort((left, right) => right.created_at - left.created_at)
        .map(({ id }) => ({ id }));
    }

    if (normalized.startsWith("INSERT INTO runtime_settings")) {
      const [key, valueJson, updatedAt] = bindings;
      const existing = this.runtimeSettings.find((setting) => setting.key === key);
      if (existing) {
        existing.value_json = String(valueJson);
        existing.updated_at = Number(updatedAt);
      } else {
        this.runtimeSettings.push({
          key: String(key),
          value_json: String(valueJson),
          updated_at: Number(updatedAt),
        });
      }
      return [];
    }

    if (normalized.startsWith("SELECT key, value_json, updated_at FROM runtime_settings WHERE key = ?")) {
      return this.runtimeSettings.filter((setting) => setting.key === bindings[0]).slice(0, 1);
    }

    if (normalized === "DELETE FROM runtime_settings WHERE key = ?") {
      this.deleteRows(this.runtimeSettings, (setting) => setting.key === bindings[0]);
      return [];
    }

    if (normalized.startsWith("INSERT INTO tasks")) {
      const [id, channel, chatId, title, status, dueAt, createdAt, completedAt, notifiedAt] = bindings;
      this.tasks.push({
        id: String(id),
        channel: String(channel),
        chat_id: String(chatId),
        title: String(title),
        status: status === "done" ? "done" : "pending",
        due_at: typeof dueAt === "number" ? dueAt : null,
        created_at: Number(createdAt),
        completed_at: typeof completedAt === "number" ? completedAt : null,
        notified_at: typeof notifiedAt === "number" ? notifiedAt : null,
      });
      return [];
    }

    if (normalized.startsWith("UPDATE tasks SET status = 'done', notified_at")) {
      const [notifiedAt, completedAt, id] = bindings;
      const task = this.tasks.find((item) => item.id === id);
      if (task) {
        task.status = "done";
        task.notified_at ??= Number(notifiedAt);
        task.completed_at ??= Number(completedAt);
      }
      return [];
    }

    if (normalized.startsWith("UPDATE tasks SET status = 'done'")) {
      const [completedAt, id] = bindings;
      const task = this.tasks.find((item) => item.id === id);
      if (task) {
        task.status = "done";
        task.completed_at ??= Number(completedAt);
      }
      return [];
    }

    if (normalized === "DELETE FROM tasks WHERE id = ?") {
      this.deleteRows(this.tasks, (task) => task.id === bindings[0]);
      return [];
    }

    if (normalized === "SELECT id FROM tasks ORDER BY created_at DESC") {
      return this.sortedTasks().map(({ id }) => ({ id }));
    }

    if (normalized.startsWith("SELECT MIN(due_at) AS due_at FROM tasks")) {
      const dueTasks = this.tasks
        .filter((task) => task.status === "pending" && typeof task.due_at === "number")
        .map((task) => task.due_at as number);
      return [{ due_at: dueTasks.length ? Math.min(...dueTasks) : null }];
    }

    if (normalized.includes("FROM tasks WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?")) {
      const [now, limit] = bindings;
      return this.sortedTasks()
        .filter(
          (task) =>
            task.status === "pending" &&
            typeof task.due_at === "number" &&
            task.due_at <= Number(now),
        )
        .slice(0, Number(limit));
    }

    if (normalized.includes("FROM tasks WHERE channel = ? AND chat_id = ? AND status = ?")) {
      const [channel, chatId, status, limit] = bindings;
      return this.sortedTasks()
        .filter(
          (task) =>
            task.channel === channel &&
            task.chat_id === chatId &&
            task.status === status,
        )
        .slice(0, Number(limit));
    }

    if (normalized.includes("FROM tasks WHERE channel = ? AND chat_id = ?")) {
      const [channel, chatId, limit] = bindings;
      return this.sortedTasks()
        .filter((task) => task.channel === channel && task.chat_id === chatId)
        .slice(0, Number(limit));
    }

    if (normalized.includes("FROM tasks WHERE id = ?")) {
      return this.tasks.filter((task) => task.id === bindings[0]).slice(0, 1);
    }

    if (normalized.includes("FROM tasks ORDER BY CASE WHEN status = 'pending'")) {
      return this.sortedTasks().slice(0, Number(bindings[0]));
    }

    if (normalized.startsWith("INSERT INTO pending_approvals")) {
      const [id, channel, chatId, toolName, toolInputJson, risk, createdAt, expiresAt] = bindings;
      this.pendingApprovals.push({
        id: String(id),
        channel: String(channel),
        chat_id: String(chatId),
        tool_name: String(toolName),
        tool_input_json: String(toolInputJson),
        risk: String(risk),
        created_at: Number(createdAt),
        expires_at: Number(expiresAt),
      });
      return [];
    }

    if (normalized === "DELETE FROM pending_approvals WHERE id = ?") {
      this.deleteRows(this.pendingApprovals, (approval) => approval.id === bindings[0]);
      return [];
    }

    if (normalized === "DELETE FROM pending_approvals WHERE expires_at <= ?") {
      this.deleteRows(this.pendingApprovals, (approval) => approval.expires_at <= Number(bindings[0]));
      return [];
    }

    if (normalized === "SELECT id FROM pending_approvals ORDER BY created_at DESC") {
      return this.sortedApprovals().map(({ id }) => ({ id }));
    }

    if (
      normalized.includes("FROM pending_approvals WHERE channel = ? AND chat_id = ? AND tool_name = ?")
    ) {
      const [channel, chatId, toolName, toolInputJson, expiresAfter] = bindings;
      return this.sortedApprovals()
        .filter(
          (approval) =>
            approval.channel === channel &&
            approval.chat_id === chatId &&
            approval.tool_name === toolName &&
            approval.tool_input_json === toolInputJson &&
            approval.expires_at > Number(expiresAfter),
        )
        .slice(0, 1);
    }

    if (normalized.includes("FROM pending_approvals WHERE channel = ? AND chat_id = ?")) {
      const [channel, chatId, limit] = bindings;
      return this.sortedApprovals()
        .filter((approval) => approval.channel === channel && approval.chat_id === chatId)
        .slice(0, Number(limit));
    }

    if (normalized.includes("FROM pending_approvals WHERE id = ?")) {
      return this.pendingApprovals.filter((approval) => approval.id === bindings[0]).slice(0, 1);
    }

    if (normalized.includes("FROM pending_approvals ORDER BY created_at DESC LIMIT ?")) {
      return this.sortedApprovals().slice(0, Number(bindings[0]));
    }

    throw new Error(`Unhandled SQL in test: ${normalized}`);
  }

  private sortedApprovals() {
    return this.pendingApprovals
      .slice()
      .sort((left, right) => right.created_at - left.created_at);
  }

  private sortedTasks() {
    return this.tasks.slice().sort((left, right) => {
      if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
      const leftDue = left.due_at ?? Number.POSITIVE_INFINITY;
      const rightDue = right.due_at ?? Number.POSITIVE_INFINITY;
      return leftDue - rightDue || right.created_at - left.created_at;
    });
  }

  private deleteRows<T>(rows: T[], predicate: (row: T) => boolean) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (predicate(rows[index])) rows.splice(index, 1);
    }
  }
}

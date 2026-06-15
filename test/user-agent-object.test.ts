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

  it("carries recent conversation history across independent chat requests", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        [openAiTextResponse("Your name is Ada."), openAiTextResponse("Your name is Ada.")],
        capturedRequests,
      ),
    );

    await readEvents(await object.fetch(chatRequest("my name is Ada")));
    await readEvents(await object.fetch(chatRequest("what is my name?")));

    expect(messageTail(capturedRequests[1], 3)).toEqual([
      { role: "user", content: "my name is Ada" },
      { role: "assistant", content: "Your name is Ada." },
      { role: "user", content: "what is my name?" },
    ]);
    expect(sql.memories).toHaveLength(0);
  });

  it("restores active session history after Durable Object restart", async () => {
    const sql = new FakeSqlStorage();
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        [openAiTextResponse("Saved."), openAiTextResponse("You said mango.")],
        capturedRequests,
      ),
    );

    await readEvents(await createObject(sql).fetch(chatRequest("remember mango")));
    await readEvents(await createObject(sql).fetch(chatRequest("what did I say?")));

    expect(messageTail(capturedRequests[1], 3)).toEqual([
      { role: "user", content: "remember mango" },
      { role: "assistant", content: "Saved." },
      { role: "user", content: "what did I say?" },
    ]);
  });

  it("switches between persisted chat sessions", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        [
          openAiTextResponse("Alpha saved."),
          openAiTextResponse("Beta saved."),
          openAiTextResponse("Alpha answer."),
        ],
        capturedRequests,
      ),
    );

    const firstSession = await object.fetch(
      jsonRequest("/chat-sessions", {
        source: { channel: "telegram", chatId: "123" },
        title: "alpha",
      }),
    );
    const firstSessionId = ((await firstSession.json()) as { session: { id: string } }).session.id;
    await readEvents(await object.fetch(chatRequest("alpha fact")));

    await object.fetch(
      jsonRequest("/chat-sessions", {
        source: { channel: "telegram", chatId: "123" },
        title: "beta",
      }),
    );
    await readEvents(await object.fetch(chatRequest("beta fact")));

    await object.fetch(
      jsonRequest("/chat-sessions/active", {
        source: { channel: "telegram", chatId: "123" },
        sessionId: firstSessionId,
      }),
    );
    await readEvents(await object.fetch(chatRequest("what is in this session?")));

    const finalMessages = requestMessages(capturedRequests[2]);
    expect(finalMessages).toContainEqual({ role: "user", content: "alpha fact" });
    expect(finalMessages).not.toContainEqual({ role: "user", content: "beta fact" });
  });

  it("persists full conversation history across turns", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        Array.from({ length: 14 }, (_, index) => openAiTextResponse(`answer ${index}`)),
        capturedRequests,
      ),
    );

    for (let index = 0; index < 13; index += 1) {
      await readEvents(await object.fetch(chatRequest(`turn ${index}`)));
    }
    await readEvents(await object.fetch(chatRequest("final question")));

    const finalMessages = requestMessages(capturedRequests[13]);
    expect(finalMessages).toContainEqual({ role: "user", content: "turn 0" });
    expect(finalMessages).toContainEqual({ role: "assistant", content: "answer 0" });
    expect(finalMessages).toContainEqual({ role: "user", content: "turn 12" });
    expect(messageTail(capturedRequests[13], 1)).toEqual([
      { role: "user", content: "final question" },
    ]);
  });

  it("clears conversation history when the session is reset", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        [openAiTextResponse("Noted."), openAiTextResponse("Fresh answer.")],
        capturedRequests,
      ),
    );

    await readEvents(await object.fetch(chatRequest("remember pineapple")));
    await object.fetch(
      jsonRequest("/sessions/stop", {
        source: { channel: "telegram", chatId: "123" },
        resetConversation: true,
      }),
    );
    await readEvents(await object.fetch(chatRequest("what fruit did I mention?")));

    const messages = requestMessages(capturedRequests[1]);
    expect(messages).not.toContainEqual(
      expect.objectContaining({ role: "user", content: "remember pineapple" }),
    );
    expect(messageTail(capturedRequests[1], 1)).toEqual([
      { role: "user", content: "what fruit did I mention?" },
    ]);
  });

  it("uses approved tool continuations in later conversation history", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const capturedRequests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      createCapturingFetchMock(
        [
          openAiToolCallResponse("fetch_url", { url: "https://example.com" }),
          openAiTextResponse("The page says Example page body."),
          openAiTextResponse("It found Example page body."),
        ],
        capturedRequests,
      ),
    );

    const firstEvents = await readEvents(await object.fetch(chatRequest("fetch this page")));
    const approval = approvalFromEvents(firstEvents);

    await readEvents(await object.fetch(approveRequest(approval.id)));
    await readEvents(await object.fetch(chatRequest("what did you find?")));

    expect(messageTail(capturedRequests[2], 3)).toEqual([
      { role: "user", content: "fetch this page" },
      { role: "assistant", content: "The page says Example page body." },
      { role: "user", content: "what did you find?" },
    ]);
    expect(JSON.stringify(requestMessages(capturedRequests[2]))).not.toContain(
      "Tool approval required",
    );
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

  it("imports standard SKILL.md and exposes available skill guidance", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const markdown = [
      "---",
      "name: planning",
      "description: Use when turning goals into concrete next steps",
      "---",
      "# Planning",
      "",
      "Break the work into sequenced steps.",
    ].join("\n");

    const imported = await object.fetch(
      jsonRequest("/settings/skills/import", { markdown }),
    );
    expect(imported.status).toBe(200);
    await expect(imported.json()).resolves.toMatchObject({
      ok: true,
      skill: {
        name: "planning",
        description: "Use when turning goals into concrete next steps",
      },
    });

    const capturedRequests: unknown[] = [];
    vi.stubGlobal("fetch", createCapturingFetchMock([openAiTextResponse("ok")], capturedRequests));
    await readEvents(await object.fetch(chatRequest("make a plan")));

    expect(JSON.stringify(requestMessages(capturedRequests[0]))).toContain("<available_skills>");
    expect(JSON.stringify(requestMessages(capturedRequests[0]))).toContain("<name>planning</name>");
  });

  it("imports skills source resources and returns them from the skill tool", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    const skillMarkdown = [
      "---",
      "name: release-notes",
      "description: Draft release notes from structured changes",
      "---",
      "# Release Notes",
      "",
      "Use the helper script when changes need grouping.",
    ].join("\n");

    vi.stubGlobal("fetch", createGitHubSkillSourceFetchMock({
      "skills/release-notes/SKILL.md": skillMarkdown,
      "skills/release-notes/scripts/group-changes.py": "print('group changes')",
      "skills/release-notes/templates/notes.md": "## Added\n\n## Fixed\n",
    }));

    const imported = await object.fetch(
      jsonRequest("/settings/skills/source", {
        source: "vercel-labs/agent-skills/skills/release-notes",
      }),
    );

    expect(imported.status).toBe(200);
    await expect(imported.json()).resolves.toMatchObject({
      ok: true,
      imported: ["release-notes"],
      settings: {
        skills: [
          {
            name: "release-notes",
            files: [
              { path: "scripts/group-changes.py", content: "print('group changes')" },
              { path: "templates/notes.md", content: "## Added\n\n## Fixed\n" },
            ],
          },
        ],
      },
    });

    vi.stubGlobal(
      "fetch",
      createFetchMock([
        openAiToolCallResponse("skill", { name: "release-notes" }),
        openAiTextResponse("Loaded."),
      ]),
    );
    const events = await readEvents(await object.fetch(chatRequest("load release skill")));
    const toolResult = events.find((event) => event.event === "tool_result");
    expect(toolResult).toBeDefined();
    const resultText = JSON.stringify(
      (toolResult as Extract<AgentStreamEvent, { event: "tool_result" }>).data.result,
    );
    expect(resultText).toContain("<skill_files>");
    expect(resultText).toContain("scripts/group-changes.py");
    expect(resultText).toContain("print('group changes')");
  });

  it("stores MCP settings and summarizes header names without values", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);

    const update = await object.fetch(
      jsonRequest(
        "/settings/mcp",
        {
          servers: {
            search: {
              type: "remote",
              url: "https://mcp.example.com/mcp",
              headers: {
                Authorization: "Bearer secret-token",
              },
            },
          },
        },
        "PUT",
      ),
    );

    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      ok: true,
      summary: {
        servers: [
          {
            name: "search",
            headerNames: ["Authorization"],
          },
        ],
      },
    });

    const state = await object.fetch(new Request("https://agent.test/state"));
    const stateText = JSON.stringify(await state.json());
    expect(stateText).toContain("Authorization");
    expect(stateText).not.toContain("secret-token");
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

  it("curates memory with the model before saving", async () => {
    const sql = new FakeSqlStorage();
    const object = createObject(sql);
    vi.stubGlobal(
      "fetch",
      createFetchMock([openAiTextResponse("用户偏好：以后回答先给结论，再给必要步骤。")]),
    );

    const response = await object.fetch(
      jsonRequest("/memories/curate", {
        content: "你记一下，我比较喜欢先看结论，然后再看步骤，不要一上来讲太多背景。",
        llm: llmConfig(),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      memory: {
        content: "用户偏好：以后回答先给结论，再给必要步骤。",
      },
    });
    expect(sql.memories).toHaveLength(1);
    expect(sql.memories[0]?.content).not.toContain("你记一下");
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

function createCapturingFetchMock(llmResponses: MockLlmResponse[], capturedRequests: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://llm.test/")) {
      capturedRequests.push(await readRequestJson(input, init));
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

function createGitHubSkillSourceFetchMock(files: Record<string, string>) {
  const entries = Object.keys(files).map((path, index) => ({
    path,
    type: "blob",
    sha: `sha-${index}`,
    size: files[path].length,
  }));
  const contentBySha = new Map(entries.map((entry) => [entry.sha, files[entry.path]]));

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.github.com/repos/vercel-labs/agent-skills/git/trees/HEAD?recursive=1") {
      return Response.json({ tree: entries });
    }

    const blobMatch = /^https:\/\/api\.github\.com\/repos\/vercel-labs\/agent-skills\/git\/blobs\/(.+)$/.exec(url);
    if (blobMatch) {
      const content = contentBySha.get(decodeURIComponent(blobMatch[1]));
      if (content === undefined) return new Response("Not found", { status: 404 });
      return Response.json({
        encoding: "base64",
        content: btoa(content),
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function readRequestJson(input: RequestInfo | URL, init?: RequestInit) {
  const text = input instanceof Request
    ? await input.clone().text()
    : typeof init?.body === "string"
      ? init.body
      : "";
  return text ? JSON.parse(text) as unknown : {};
}

function requestMessages(requestBody: unknown) {
  const body = requestBody as { messages?: Array<{ role?: string; content?: unknown }> };
  return body.messages ?? [];
}

function messageTail(requestBody: unknown, count: number) {
  return requestMessages(requestBody)
    .slice(-count)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
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

class FakeSqlStorage {
  readonly memories: StoredMemory[] = [];
  readonly pendingApprovals: PendingApprovalRow[] = [];
  readonly runtimeSettings: RuntimeSettingRow[] = [];
  readonly tasks: TaskRow[] = [];
  readonly chatSessions: ChatSessionRow[] = [];
  readonly activeChatSessions: ActiveChatSessionRow[] = [];
  readonly chatMessages: ChatMessageRow[] = [];
  alarm: number | null = null;

  exec(sql: string, ...bindings: Array<string | number | null>) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE ")) return [];
    if (normalized.startsWith("ALTER ")) return [];

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

    if (normalized.startsWith("SELECT channel, chat_id, session_id, updated_at FROM active_chat_sessions")) {
      const [channel, chatId] = bindings;
      return this.activeChatSessions
        .filter((session) => session.channel === channel && session.chat_id === chatId)
        .slice(0, 1);
    }

    if (normalized === "DELETE FROM active_chat_sessions WHERE channel = ? AND chat_id = ?") {
      const [channel, chatId] = bindings;
      this.deleteRows(
        this.activeChatSessions,
        (session) => session.channel === channel && session.chat_id === chatId,
      );
      return [];
    }

    if (normalized.startsWith("SELECT id, channel, chat_id, title, created_at, updated_at FROM chat_sessions WHERE id = ?")) {
      return this.chatSessions.filter((session) => session.id === bindings[0]).slice(0, 1);
    }

    if (normalized.startsWith("SELECT id, channel, chat_id, title, created_at, updated_at FROM chat_sessions WHERE channel = ? AND chat_id = ?")) {
      const [channel, chatId] = bindings;
      return this.chatSessions
        .filter((session) => session.channel === channel && session.chat_id === chatId)
        .sort((left, right) => right.updated_at - left.updated_at || right.created_at - left.created_at);
    }

    if (normalized.startsWith("INSERT INTO chat_sessions")) {
      const [id, channel, chatId, title, createdAt, updatedAt] = bindings;
      this.chatSessions.push({
        id: String(id),
        channel: String(channel),
        chat_id: String(chatId),
        title: String(title),
        created_at: Number(createdAt),
        updated_at: Number(updatedAt),
      });
      return [];
    }

    if (normalized.startsWith("INSERT INTO active_chat_sessions")) {
      const [channel, chatId, sessionId, updatedAt] = bindings;
      const existing = this.activeChatSessions.find(
        (session) => session.channel === channel && session.chat_id === chatId,
      );
      if (existing) {
        existing.session_id = String(sessionId);
        existing.updated_at = Number(updatedAt);
      } else {
        this.activeChatSessions.push({
          channel: String(channel),
          chat_id: String(chatId),
          session_id: String(sessionId),
          updated_at: Number(updatedAt),
        });
      }
      return [];
    }

    if (normalized.startsWith("SELECT id, session_id, channel, chat_id, role, content, sequence, created_at FROM chat_messages WHERE session_id = ?")) {
      return this.chatMessages
        .filter((message) => message.session_id === bindings[0])
        .sort((left, right) => left.sequence - right.sequence);
    }

    if (normalized.startsWith("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM chat_messages WHERE session_id = ?")) {
      const sessionMessages = this.chatMessages.filter((message) => message.session_id === bindings[0]);
      return [{
        sequence: sessionMessages.length
          ? Math.max(...sessionMessages.map((message) => message.sequence))
          : 0,
      }];
    }

    if (normalized.startsWith("INSERT INTO chat_messages")) {
      const [id, sessionId, channel, chatId, role, content, sequence, createdAt] = bindings;
      this.chatMessages.push({
        id: String(id),
        session_id: String(sessionId),
        channel: String(channel),
        chat_id: String(chatId),
        role: role === "assistant" ? "assistant" : "user",
        content: String(content),
        sequence: Number(sequence),
        created_at: Number(createdAt),
      });
      return [];
    }

    if (normalized.startsWith("SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'assistant'")) {
      return this.chatMessages
        .filter((message) => message.session_id === bindings[0] && message.role === "assistant")
        .sort((left, right) => right.sequence - left.sequence)
        .map(({ id, content }) => ({ id, content }));
    }

    if (normalized === "UPDATE chat_messages SET content = ? WHERE id = ?") {
      const [content, id] = bindings;
      const message = this.chatMessages.find((item) => item.id === id);
      if (message) {
        message.content = String(content);
      }
      return [];
    }

    if (normalized === "UPDATE chat_sessions SET updated_at = ? WHERE id = ?") {
      const [updatedAt, id] = bindings;
      const session = this.chatSessions.find((item) => item.id === id);
      if (session) {
        session.updated_at = Number(updatedAt);
      }
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
      const [
        id,
        channel,
        chatId,
        sessionId,
        toolName,
        toolInputJson,
        risk,
        createdAt,
        expiresAt,
      ] = bindings;
      this.pendingApprovals.push({
        id: String(id),
        channel: String(channel),
        chat_id: String(chatId),
        session_id: String(sessionId),
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
      normalized.includes("FROM pending_approvals WHERE channel = ?") &&
      normalized.includes("AND session_id = ?") &&
      normalized.includes("AND tool_name = ?")
    ) {
      const [channel, chatId, sessionId, toolName, toolInputJson, expiresAfter] = bindings;
      return this.sortedApprovals()
        .filter(
          (approval) =>
            approval.channel === channel &&
            approval.chat_id === chatId &&
            (approval.session_id ?? "") === sessionId &&
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

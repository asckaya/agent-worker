import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTestChannelRequest } from "../src/worker/channels/test";
import type { Env, LlmConfig } from "../src/worker/types";

describe("test channel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proxies chat requests into the agent object with a test channel source", async () => {
    let agentPath = "";
    let agentBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentPath = new URL(request.url).pathname;
      agentBody = await request.json();
      return new Response(
        sseStream([
          ["message_delta", { delta: "Hel" }],
          ["done", { content: "Hello test channel", memoryCount: 2 }],
        ]),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/chat?format=json", {
        chatId: "local",
        message: "hello",
        llm: llmConfig(),
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(agentPath).toBe("/chat");
    expect(agentBody).toEqual({
      message: "hello",
      history: [],
      llm: llmConfig(),
      source: { channel: "test", chatId: "local" },
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      content: "Hello test channel",
      memoryCount: 2,
      events: [
        { event: "message_delta", data: { delta: "Hel" } },
        { event: "done", data: { content: "Hello test channel", memoryCount: 2 } },
      ],
    });
  });

  it("uses server-side LLM env when chat payload omits llm", async () => {
    let agentBody = {};
    const agentFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/settings/llm") {
        return Response.json({ ok: true, settings: null });
      }

      agentBody = await request.json();
      return new Response(sseStream([["done", { content: "ok" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/chat?format=json", {
        message: "hello",
      }),
      env({
        AGENT_OBJECT: agentNamespace(agentFetch),
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "env-key",
        LLM_MODEL: "env-model",
      }),
    );

    expect(response.status).toBe(200);
    expect(agentBody).toMatchObject({
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "env-key",
        model: "env-model",
      },
      source: { channel: "test", chatId: "default" },
    });
  });

  it("approves pending tools through the test channel source", async () => {
    let agentPath = "";
    let agentBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentPath = new URL(request.url).pathname;
      agentBody = await request.json();
      return new Response(sseStream([["done", { content: "Approved result" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/approvals/ap1/approve?format=json", {
        chatId: "local",
        llm: llmConfig(),
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(agentPath).toBe("/approvals/ap1/approve-stream");
    expect(agentBody).toEqual({
      source: { channel: "test", chatId: "local" },
      llm: llmConfig(),
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      content: "Approved result",
    });
  });

  it("routes reset requests as stop plus conversation reset", async () => {
    let agentPath = "";
    let agentBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentPath = new URL(request.url).pathname;
      agentBody = await request.json();
      return Response.json({ ok: true, stopped: false, conversationReset: true });
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/reset", {
        chatId: "local",
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(agentPath).toBe("/sessions/stop");
    expect(agentBody).toEqual({
      source: { channel: "test", chatId: "local" },
      resetConversation: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      conversationReset: true,
    });
  });

  it("proxies chat session management endpoints", async () => {
    const calls: Array<{ path: string; search: string; body?: unknown; method: string }> = [];
    const agentFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        search: url.search,
        method: request.method,
        body: request.method === "GET" ? undefined : await request.json(),
      });
      return Response.json({ ok: true, sessions: [], session: { id: "s_1" } });
    });

    await handleTestChannelRequest(
      new Request("https://example.com/api/test-channel/sessions?chatId=local"),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );
    await handleTestChannelRequest(
      jsonRequest("/api/test-channel/sessions", {
        chatId: "local",
        title: "planning",
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );
    await handleTestChannelRequest(
      jsonRequest("/api/test-channel/sessions/active", {
        chatId: "local",
        sessionId: "s_1",
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(calls).toEqual([
      {
        path: "/chat-sessions",
        search: "?channel=test&chatId=local",
        method: "GET",
        body: undefined,
      },
      {
        path: "/chat-sessions",
        search: "",
        method: "POST",
        body: {
          source: { channel: "test", chatId: "local" },
          title: "planning",
        },
      },
      {
        path: "/chat-sessions/active",
        search: "",
        method: "POST",
        body: {
          source: { channel: "test", chatId: "local" },
          sessionId: "s_1",
        },
      },
    ]);
  });

  it("proxies memory and task management endpoints", async () => {
    const calls: Array<{ path: string; body?: unknown; method: string }> = [];
    const agentFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      calls.push({
        path,
        method: request.method,
        body: request.method === "GET" || request.method === "DELETE"
          ? undefined
          : await request.json(),
      });
      return Response.json({ ok: true, task: { id: "t_1" }, memory: { id: "m_1" } });
    });

    await handleTestChannelRequest(
      jsonRequest("/api/test-channel/memories", { content: "remember this" }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );
    await handleTestChannelRequest(
      jsonRequest("/api/test-channel/tasks", {
        chatId: "local",
        title: "pay bill",
        dueAt: 1_900_000_000_000,
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );
    await handleTestChannelRequest(
      jsonRequest("/api/test-channel/tasks/t_1/done", { chatId: "local" }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(calls).toEqual([
      {
        path: "/memories",
        method: "POST",
        body: { content: "remember this" },
      },
      {
        path: "/tasks",
        method: "POST",
        body: {
          source: { channel: "test", chatId: "local" },
          title: "pay bill",
          dueAt: 1_900_000_000_000,
        },
      },
      {
        path: "/tasks/t_1/done",
        method: "POST",
        body: {
          source: { channel: "test", chatId: "local" },
        },
      },
    ]);
  });

  it("requires LLM config for chat when env is not configured", async () => {
    const agentFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/settings/llm") {
        return Response.json({ ok: true, settings: null });
      }

      throw new Error("Unexpected agent call.");
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/chat", {
        message: "hello",
      }),
      env({ AGENT_OBJECT: agentNamespace(agentFetch) }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required for test channel.",
    });
  });

  it("uses stored LLM profile settings before server-side fallback env", async () => {
    let agentBody = {};
    const agentFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/settings/llm") {
        return Response.json({
          ok: true,
          settings: {
            activeProfileId: "openrouter",
            profiles: [
              {
                id: "openrouter",
                baseUrl: "https://openrouter.ai/api/v1",
                model: "google/gemma-4-31b-it:free",
                apiKeyEnv: "OPENROUTER_API_KEY",
              },
            ],
          },
        });
      }

      agentBody = await request.json();
      return new Response(sseStream([["done", { content: "ok" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const response = await handleTestChannelRequest(
      jsonRequest("/api/test-channel/chat?format=json", {
        message: "hello",
      }),
      env({
        AGENT_OBJECT: agentNamespace(agentFetch),
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "env-key",
        LLM_MODEL: "env-model",
        OPENROUTER_API_KEY: "stored-key",
      } as Partial<Env>),
    );

    expect(response.status).toBe(200);
    expect(agentBody).toMatchObject({
      llm: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "stored-key",
        model: "google/gemma-4-31b-it:free",
      },
    });
  });
});

function env(values: Partial<Env>) {
  return values as Env;
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function agentNamespace(fetchImpl: (request: Request) => Promise<Response>) {
  return {
    idFromName: vi.fn(() => "agent-id"),
    get: vi.fn(() => ({
      fetch: fetchImpl,
    })),
  } as unknown as DurableObjectNamespace;
}

function llmConfig(): LlmConfig {
  return {
    baseUrl: "https://llm.test/v1",
    apiKey: "key",
    model: "gpt-test",
  };
}

function sseStream(events: Array<[string, unknown]>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of events) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }
      controller.close();
    },
  });
}

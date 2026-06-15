import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramLlmConfig,
  canRunTelegramCommand,
  handleTelegramWebhook,
  isChatAllowed,
  isTelegramSecretValid,
  parseAllowedChatIds,
  parseTelegramAdminUserIds,
  parseTelegramReminderArgs,
  resolveTelegramStreamMode,
  resolveTelegramStreamTransport,
  resolveTelegramTextBatchDelayMs,
} from "../src/worker/integrations/telegram";
import type { Env } from "../src/worker/types";

describe("telegram integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("requires the Telegram secret header", () => {
    const request = new Request("https://example.com/api/tg/webhook", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    });

    expect(isTelegramSecretValid(request, env({ TELEGRAM_SECRET_TOKEN: "secret" }))).toBe(true);
    expect(isTelegramSecretValid(request, env({ TELEGRAM_SECRET_TOKEN: "other" }))).toBe(false);
    expect(isTelegramSecretValid(request, env({}))).toBe(false);
  });

  it("parses and enforces allowed chat ids", () => {
    expect(parseAllowedChatIds("123, -456,abc")).toEqual(new Set(["123", "-456", "abc"]));
    expect(isChatAllowed("-456", env({ TELEGRAM_ALLOWED_CHAT_IDS: "123,-456" }))).toBe(true);
    expect(isChatAllowed("999", env({ TELEGRAM_ALLOWED_CHAT_IDS: "123,-456" }))).toBe(false);
    expect(isChatAllowed("999", env({ TELEGRAM_ALLOW_ALL_CHATS: "true" }))).toBe(true);
  });

  it("parses Telegram stream and command policy settings", () => {
    expect(parseTelegramAdminUserIds("42, 99")).toEqual(new Set(["42", "99"]));
    expect(resolveTelegramStreamTransport(undefined)).toBe("auto");
    expect(resolveTelegramStreamTransport("draft")).toBe("draft");
    expect(resolveTelegramStreamTransport("invalid")).toBe("auto");
    expect(resolveTelegramStreamMode(env({}), { chatType: "private" })).toBe("draft");
    expect(resolveTelegramStreamMode(env({}), { chatType: "group" })).toBe("edit");
    expect(resolveTelegramStreamMode(env({ TELEGRAM_STREAM_TRANSPORT: "off" }), { chatType: "private" })).toBe("off");
    expect(resolveTelegramTextBatchDelayMs(undefined)).toBe(180);
    expect(resolveTelegramTextBatchDelayMs("0")).toBe(0);
    expect(resolveTelegramTextBatchDelayMs("2000")).toBe(1000);
  });

  it("requires configured Telegram admins for mutating slash commands", () => {
    expect(
      canRunTelegramCommand(
        { name: "approve", args: "abc", raw: "/approve abc", botName: undefined },
        { fromUserId: "42" },
        env({ TELEGRAM_ADMIN_USER_IDS: "42" }),
      ),
    ).toBe(true);
    expect(
      canRunTelegramCommand(
        { name: "approve", args: "abc", raw: "/approve abc", botName: undefined },
        { fromUserId: "99" },
        env({ TELEGRAM_ADMIN_USER_IDS: "42" }),
      ),
    ).toBe(false);
    expect(
      canRunTelegramCommand(
        { name: "pending", args: "", raw: "/pending", botName: undefined },
        { fromUserId: "99" },
        env({ TELEGRAM_ADMIN_USER_IDS: "42" }),
      ),
    ).toBe(true);
    expect(
      canRunTelegramCommand(
        { name: "stop", args: "", raw: "/stop", botName: undefined },
        { fromUserId: "99" },
        env({ TELEGRAM_ADMIN_USER_IDS: "42" }),
      ),
    ).toBe(false);
  });

  it("builds LLM config from server env for Telegram", () => {
    const config = buildTelegramLlmConfig(
      env({
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-4.1-mini",
        LLM_TEMPERATURE: "0.2",
        LLM_MAX_TOKENS: "800",
      }),
    );

    expect(config).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      model: "gpt-4.1-mini",
      temperature: 0.2,
      maxTokens: 800,
    });
    expect(buildTelegramLlmConfig(env({}))).toBeInstanceOf(Error);
  });

  it("rejects webhook requests without Telegram secret", async () => {
    const response = await handleTelegramWebhook(
      new Request("https://example.com/api/tg/webhook", {
        method: "POST",
        body: "{}",
      }),
      env({ TELEGRAM_SECRET_TOKEN: "secret" }),
    );

    expect(response.status).toBe(401);
  });

  it("ignores unsupported webhook updates before requiring bot token", async () => {
    const response = await handleTelegramWebhook(
      webhookRequest({ edited_message: {} }),
      env({ TELEGRAM_SECRET_TOKEN: "secret" }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, ignored: "unsupported_update" });
  });

  it("requires bot token for text updates", async () => {
    const response = await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 1,
          text: "hello",
          chat: { id: 123, type: "private" },
        },
      }),
      env({ TELEGRAM_SECRET_TOKEN: "secret" }),
    );

    expect(response.status).toBe(500);
  });

  it("handles /id without calling the agent", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 7,
          text: "/id",
          chat: { id: -100123, type: "group" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "-100123",
          text: "chat id: -100123",
          reply_to_message_id: 7,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });

  it("streams private agent responses through Telegram drafts and sends a final message", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentRequestBody = await request.json();
      return new Response(
        sseStream([
          ["token", { token: "Hel" }],
          ["message_delta", { delta: "lo" }],
          ["done", { content: "Hello from stream" }],
        ]),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });

    const response = await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 9,
          text: "hello",
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(agentFetch).toHaveBeenCalledTimes(1);
    expect(agentRequestBody).toEqual({
      message: "hello",
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
      },
      source: { channel: "telegram", chatId: "123" },
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessageDraft",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          draft_id: "agent-worker:123:9",
          text: "Hello from stream",
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Hello from stream",
          reply_to_message_id: 9,
          allow_sending_without_reply: true,
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).not.toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.anything(),
    );
  });

  it("batches rapid Telegram text updates before calling the agent", async () => {
    vi.useFakeTimers();
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const agentRequestBodies: unknown[] = [];
    const agentFetch = vi.fn(async (request: Request) => {
      agentRequestBodies.push(await request.json());
      return new Response(sseStream([["done", { content: "Batched response" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const testEnv = env({
      TELEGRAM_SECRET_TOKEN: "secret",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_ALLOWED_CHAT_IDS: "123",
      TELEGRAM_TEXT_BATCH_MS: "25",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_API_KEY: "key",
      LLM_MODEL: "gpt-test",
      AGENT_OBJECT: agentNamespace(agentFetch),
    });

    const first = handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 20,
          text: "first part",
          chat: { id: 123, type: "private" },
        },
      }),
      testEnv,
    );
    const second = handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 21,
          text: "second part",
          chat: { id: 123, type: "private" },
        },
      }),
      testEnv,
    );

    await vi.advanceTimersByTimeAsync(25);
    await Promise.all([first, second]);

    expect(agentFetch).toHaveBeenCalledTimes(1);
    expect(agentRequestBodies[0]).toEqual({
      message: "first part\n\nsecond part",
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
      },
      source: { channel: "telegram", chatId: "123" },
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Batched response",
          reply_to_message_id: 21,
          allow_sending_without_reply: true,
          parse_mode: "MarkdownV2",
        }),
      }),
    );
  });

  it("renders tool approvals with Telegram inline buttons", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const approval = {
      id: "ap1",
      channel: "telegram",
      chatId: "123",
      toolName: "fetch_url",
      toolInput: { url: "https://example.com" },
      risk: "network",
      created_at: 1,
      expires_at: 2,
    };
    const agentFetch = vi.fn(async () =>
      new Response(
        sseStream([
          ["approval_required", { message: "Tool approval required: fetch_url", approval }],
          ["done", { content: "Tool approval required: fetch_url" }],
        ]),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 9,
          text: "fetch this",
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Tool approval required: fetch_url",
          reply_to_message_id: 9,
          allow_sending_without_reply: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Approve",
                  callback_data: "agent-worker:approve:ap1",
                },
                {
                  text: "Deny",
                  callback_data: "agent-worker:deny:ap1",
                },
              ],
            ],
          },
          parse_mode: "MarkdownV2",
        }),
      }),
    );
  });

  it("handles Telegram approval callback queries", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 77 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    let agentPath = "";
    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      agentPath = url.pathname;
      agentRequestBody = await request.json();
      return new Response(sseStream([["done", { content: "Approved result" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        callback_query: {
          id: "callback-1",
          data: "agent-worker:approve:ap1",
          from: { id: 42 },
          message: {
            message_id: 55,
            text: "Tool approval required: fetch_url",
            chat: { id: 123, type: "private" },
          },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        TELEGRAM_ADMIN_USER_IDS: "42",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentPath).toBe("/approvals/ap1/approve-stream");
    expect(agentRequestBody).toEqual({
      source: { channel: "telegram", chatId: "123" },
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
      },
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/answerCallbackQuery",
      expect.objectContaining({
        body: JSON.stringify({
          callback_query_id: "callback-1",
          text: "Approved. Running tool...",
          show_alert: false,
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          message_id: 55,
          text: "Approved: ap1\nRunning tool...",
          reply_markup: { inline_keyboard: [] },
        }),
      }),
    );
  });

  it("renders an inline Telegram menu", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 16,
          text: "/menu",
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Agent menu",
          reply_to_message_id: 16,
          allow_sending_without_reply: true,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Status", callback_data: "agent-worker:menu:status" },
                { text: "LLM", callback_data: "agent-worker:menu:llm" },
              ],
              [
                { text: "Memory", callback_data: "agent-worker:menu:memory" },
                { text: "Tasks", callback_data: "agent-worker:menu:tasks" },
              ],
              [
                { text: "Pending", callback_data: "agent-worker:menu:pending" },
                { text: "Stop", callback_data: "agent-worker:menu:stop" },
              ],
            ],
          },
        }),
      }),
    );
  });

  it("creates Telegram reminders through the task endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    let agentPath = "";
    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentPath = new URL(request.url).pathname;
      agentRequestBody = await request.json();
      return Response.json({
        ok: true,
        task: {
          id: "t_123",
          due_at: Date.now() + 600_000,
        },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 17,
          text: "/remind 10m drink water",
          chat: { id: 123, type: "private" },
          from: { id: 42 },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        TELEGRAM_ADMIN_USER_IDS: "42",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentPath).toBe("/tasks");
    expect(agentRequestBody).toEqual({
      source: { channel: "telegram", chatId: "123" },
      title: "drink water",
      dueAt: Date.now() + 600_000,
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: expect.stringContaining("Reminder added: t_123"),
      }),
    );
  });

  it("curates Telegram /remember notes through the agent object", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    let agentPath = "";
    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentPath = new URL(request.url).pathname;
      agentRequestBody = await request.json();
      return Response.json({
        ok: true,
        memory: {
          id: "mem_1",
          content: "用户偏好：回答先给结论。",
        },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 18,
          text: "/remember 我喜欢回答先给结论",
          chat: { id: 123, type: "private" },
          from: { id: 42 },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        TELEGRAM_ADMIN_USER_IDS: "42",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentPath).toBe("/memories/curate");
    expect(agentRequestBody).toEqual({
      content: "我喜欢回答先给结论",
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
      },
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Saved memory: mem_1\n用户偏好：回答先给结论。",
          reply_to_message_id: 18,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });

  it("parses common Telegram reminder times", () => {
    const now = Date.parse("2026-06-15T10:00:00Z");

    expect(parseTelegramReminderArgs("10m stretch", now)).toEqual({
      dueAt: now + 600_000,
      title: "stretch",
    });
    expect(parseTelegramReminderArgs("2小时后 喝水", now)).toEqual({
      dueAt: now + 2 * 60 * 60_000,
      title: "喝水",
    });
    expect(parseTelegramReminderArgs("bad", now)).toBeInstanceOf(Error);
  });

  it("passes supported Telegram text files to the agent without storing them", async () => {
    const telegramFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "docs/note.txt", file_size: 18 } });
      }
      if (url === "https://api.telegram.org/file/botbot-token/docs/note.txt") {
        return new Response("hello from a file", {
          headers: { "Content-Type": "text/plain", "Content-Length": "17" },
        });
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    vi.stubGlobal("fetch", telegramFetch);

    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentRequestBody = await request.json();
      return new Response(sseStream([["done", { content: "File summary" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 18,
          caption: "summarize",
          document: {
            file_id: "file-1",
            file_name: "note.txt",
            mime_type: "text/plain",
            file_size: 18,
          },
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentRequestBody).toMatchObject({
      source: { channel: "telegram", chatId: "123" },
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
      },
    });
    expect((agentRequestBody as { message: string }).message).toContain("User instruction: summarize");
    expect((agentRequestBody as { message: string }).message).toContain("hello from a file");
  });

  it("blocks Telegram images when the active LLM profile does not declare image support", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);
    const agentFetch = vi.fn(async () => {
      throw new Error("Unexpected agent chat call.");
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 19,
          photo: [{ file_id: "photo-1", file_size: 1200, width: 32, height: 32 }],
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentFetch).not.toHaveBeenCalled();
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: [
            "The active model profile does not declare image support.",
            "Model: gpt-test",
            "Declared modalities: text",
            'Add "modalities": ["text", "image"] to the active LLM profile after confirming the model supports it.',
          ].join("\n"),
          reply_to_message_id: 19,
          allow_sending_without_reply: true,
        }),
      }),
    );
    expect(telegramFetch).not.toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/getFile",
      expect.anything(),
    );
  });

  it("passes Telegram images to the agent when the active LLM profile declares image support", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const telegramFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "photos/pic.jpg", file_size: 4 } });
      }
      if (url === "https://api.telegram.org/file/botbot-token/photos/pic.jpg") {
        return new Response(imageBytes, {
          headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
        });
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    vi.stubGlobal("fetch", telegramFetch);

    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      agentRequestBody = await request.json();
      return new Response(sseStream([["done", { content: "Image result" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 20,
          caption: "what is this",
          photo: [{ file_id: "photo-1", file_size: 4, width: 32, height: 32 }],
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        IMAGE_MODEL_KEY: "key",
        AGENT_OBJECT: agentNamespace(agentFetch, {
          ok: true,
          settings: {
            activeProfileId: "vision",
            profiles: [
              {
                id: "vision",
                baseUrl: "https://api.openai.com/v1",
                model: "gpt-vision-test",
                apiKeyEnv: "IMAGE_MODEL_KEY",
                modalities: ["text", "image"],
              },
            ],
          },
        }),
      } as Partial<Env>),
    );

    expect(agentRequestBody).toMatchObject({
      message: expect.stringContaining("User instruction: what is this"),
      attachments: [
        {
          type: "image",
          mediaType: "image/jpeg",
          filename: "telegram-photo.jpg",
        },
      ],
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-vision-test",
        modalities: ["text", "image"],
      },
      source: { channel: "telegram", chatId: "123" },
    });
    expect((agentRequestBody as { attachments: Array<{ data: string }> }).attachments[0]?.data)
      .toMatch(/^data:image\/jpeg;base64,/);
  });

  it("falls back to edit-message streaming when Telegram drafts fail", async () => {
    const telegramFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/sendMessageDraft")) {
        return Response.json({ ok: false, description: "unknown method" }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    vi.stubGlobal("fetch", telegramFetch);

    const agentFetch = vi.fn(async () =>
      new Response(
        sseStream([
          ["message_delta", { delta: "Hello" }],
          ["done", { content: "Hello from fallback" }],
        ]),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 9,
          text: "hello",
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Thinking...",
          reply_to_message_id: 9,
          allow_sending_without_reply: true,
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          message_id: 42,
          text: "Hello from fallback",
        }),
      }),
    );
  });

  it("uses edit-message streaming in group chats", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const agentFetch = vi.fn(async () =>
      new Response(sseStream([["done", { content: "Hello group" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 10,
          text: "hello group",
          chat: { id: -100123, type: "group" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          text: "Thinking...",
          reply_to_message_id: 10,
          allow_sending_without_reply: true,
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          message_id: 42,
          text: "Hello group",
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).not.toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessageDraft",
      expect.anything(),
    );
  });

  it("renders a cursor while editing Telegram stream previews", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const preview = "a".repeat(100);
    const agentFetch = vi.fn(async () =>
      new Response(
        sseStream([
          ["message_delta", { delta: preview }],
          ["done", { content: preview }],
        ]),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 15,
          text: "hello group",
          chat: { id: -100123, type: "group" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          message_id: 42,
          text: `${preview} ▌`,
        }),
      }),
    );
  });

  it("falls back to a fresh final message when Telegram edit streaming is rate limited", async () => {
    const telegramFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/editMessageText")) {
        return Response.json(
          {
            ok: false,
            description: "Too Many Requests: retry after 2",
            parameters: { retry_after: 2 },
          },
          { status: 429 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    vi.stubGlobal("fetch", telegramFetch);

    const agentFetch = vi.fn(async () =>
      new Response(sseStream([["done", { content: "Final after flood control" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 10,
          text: "hello group",
          chat: { id: -100123, type: "group" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          message_id: 42,
          text: "Final after flood control",
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          text: "Final after flood control",
          reply_to_message_id: 10,
          allow_sending_without_reply: true,
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/deleteMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          message_id: 42,
        }),
      }),
    );
  });

  it("retries final MarkdownV2 messages as plain text when Telegram rejects parsing", async () => {
    const telegramFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; parse_mode?: string };
      if (body.parse_mode === "MarkdownV2" && body.text?.includes("bad_markdown")) {
        return Response.json(
          { ok: false, description: "Bad Request: can't parse entities" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    vi.stubGlobal("fetch", telegramFetch);

    const agentFetch = vi.fn(async () =>
      new Response(sseStream([["done", { content: "bad_markdown" }]]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 13,
          text: "hello",
          chat: { id: 123, type: "private" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "bad_markdown",
          reply_to_message_id: 13,
          allow_sending_without_reply: true,
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "bad_markdown",
          reply_to_message_id: 13,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });

  it("sends a fresh final message and deletes stale edit previews", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const agentFetch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(`event: done\ndata: ${JSON.stringify({ content: "Fresh final" })}\n\n`),
              );
              controller.close();
            }, 60_000);
          },
        }),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    const responsePromise = handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 14,
          text: "hello group",
          chat: { id: -100123, type: "group" },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "-100123",
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await responsePromise;

    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          text: "Fresh final",
          reply_to_message_id: 14,
          allow_sending_without_reply: true,
          parse_mode: "MarkdownV2",
        }),
      }),
    );
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/deleteMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "-100123",
          message_id: 42,
        }),
      }),
    );
  });

  it("blocks mutating commands from non-admin Telegram users when admins are configured", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);
    const agentFetch = vi.fn(async () => Response.json({ ok: true }));

    const response = await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 11,
          text: "/forget mem_1",
          chat: { id: 123, type: "private" },
          from: { id: 99 },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        TELEGRAM_ADMIN_USER_IDS: "42",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(agentFetch).not.toHaveBeenCalled();
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "This command requires a Telegram admin user.",
          reply_to_message_id: 11,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });

  it("stops the active Telegram run through the Durable Object", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    let agentPath = "";
    let agentRequestBody: unknown;
    const agentFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      agentPath = url.pathname;
      agentRequestBody = await request.json();
      return Response.json({ ok: true, stopped: true });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 12,
          text: "/stop",
          chat: { id: 123, type: "private" },
          from: { id: 42 },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentPath).toBe("/sessions/stop");
    expect(agentRequestBody).toEqual({
      source: { channel: "telegram", chatId: "123" },
    });
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Stopped active response.",
          reply_to_message_id: 12,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });

  it("switches Telegram chat sessions through /session", async () => {
    const telegramFetch = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 42 } }),
    );
    vi.stubGlobal("fetch", telegramFetch);

    const agentCalls: Array<{ path: string; body?: unknown; method: string }> = [];
    const agentFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      agentCalls.push({
        path: url.pathname,
        method: request.method,
        body: request.method === "GET" ? undefined : await request.json(),
      });
      if (url.pathname === "/sessions/stop") {
        return Response.json({ ok: true, stopped: false });
      }
      return Response.json({
        ok: true,
        session: {
          id: "s_abc12345",
          channel: "telegram",
          chatId: "123",
          title: "Trip planning",
          created_at: 1,
          updated_at: 1,
          active: true,
        },
      });
    });

    await handleTelegramWebhook(
      webhookRequest({
        message: {
          message_id: 13,
          text: "/session s_abc12345",
          chat: { id: 123, type: "private" },
          from: { id: 42 },
        },
      }),
      env({
        TELEGRAM_SECRET_TOKEN: "secret",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_CHAT_IDS: "123",
        AGENT_OBJECT: agentNamespace(agentFetch),
      }),
    );

    expect(agentCalls).toEqual([
      {
        path: "/sessions/stop",
        method: "POST",
        body: {
          source: { channel: "telegram", chatId: "123" },
        },
      },
      {
        path: "/chat-sessions/active",
        method: "POST",
        body: {
          source: { channel: "telegram", chatId: "123" },
          sessionId: "s_abc12345",
        },
      },
    ]);
    expect(telegramFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "123",
          text: "Switched session: Trip planning\nid: s_abc12345",
          reply_to_message_id: 13,
          allow_sending_without_reply: true,
        }),
      }),
    );
  });
});

function env(values: Partial<Env>) {
  return {
    TELEGRAM_TEXT_BATCH_MS: "0",
    ...values,
  } as Env;
}

function webhookRequest(body: unknown) {
  return new Request("https://example.com/api/tg/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify(body),
  });
}

function agentNamespace(
  fetchImpl: (request: Request) => Promise<Response>,
  llmSettingsResponse: unknown = { ok: true, settings: null },
) {
  return {
    idFromName: vi.fn(() => "agent-id"),
    get: vi.fn(() => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/settings/llm") {
          return Response.json(llmSettingsResponse);
        }
        return fetchImpl(request);
      },
    })),
  } as unknown as DurableObjectNamespace;
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

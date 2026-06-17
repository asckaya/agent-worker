import { describe, expect, it } from "vitest";
import {
  parseApprovalActionPayload,
  parseChatRequestPayload,
  parseTelegramLlmEnv,
  TelegramUpdateSchema,
} from "../src/worker/validation";

describe("validation", () => {
  it("parses and trims chat requests with bounded history", () => {
    const parsed = parseChatRequestPayload({
      message: "  hello  ",
      history: Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
      })),
      llm: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "key",
        model: "gpt-test",
        temperature: 0.2,
        maxTokens: 100,
      },
      source: { channel: "telegram", chatId: "123" },
    });

    expect(parsed.message).toBe("hello");
    expect(parsed.history).toHaveLength(24);
    expect(parsed.history?.[0]?.content).toBe("message 6");
    expect(parsed.source).toEqual({ channel: "telegram", chatId: "123" });
  });

  it("rejects invalid chat requests", () => {
    expect(() => parseChatRequestPayload({ message: "", llm: {} })).toThrow(
      "Invalid chat request",
    );
  });

  it("parses Telegram update chat ids as strings", () => {
    const update = TelegramUpdateSchema.parse({
      message: {
        message_id: 1,
        text: "hello",
        chat: { id: -100123, type: "group" },
      },
    });

    expect(update.message?.chat.id).toBe("-100123");
  });

  it("parses Telegram multimodal update fields", () => {
    const update = TelegramUpdateSchema.parse({
      message: {
        message_id: 2,
        photo: [{ file_id: "photo-1", file_size: 100, width: 10, height: 10 }],
        chat: { id: 123, type: "private" },
      },
    });

    expect(update.message?.photo?.[0]?.file_id).toBe("photo-1");
  });

  it("parses Telegram LLM env", () => {
    expect(
      parseTelegramLlmEnv({
        LLM_BASE_URL: "https://api.openai.com/v1",
        LLM_API_KEY: "key",
        LLM_MODEL: "gpt-test",
        LLM_TEMPERATURE: "0.3",
        LLM_MAX_TOKENS: "200",
        LLM_MODALITIES: "text,image,audio",
      }),
    ).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "key",
      model: "gpt-test",
      temperature: 0.3,
      maxTokens: 200,
      modalities: ["text", "image", "audio"],
    });
    expect(parseTelegramLlmEnv({})).toBeInstanceOf(Error);
  });

  it("parses approval action payloads", () => {
    expect(
      parseApprovalActionPayload({
        source: { channel: "telegram", chatId: "123" },
      }),
    ).toEqual({
      source: { channel: "telegram", chatId: "123" },
      approvalMode: "once",
    });
  });
});

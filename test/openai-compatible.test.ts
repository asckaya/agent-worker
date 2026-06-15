import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeChatCompletionsUrl,
  streamChatCompletion,
} from "../src/worker/llm/openai-compatible";

describe("normalizeChatCompletionsUrl", () => {
  it("appends the chat completions path to provider base URLs", () => {
    expect(normalizeChatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("keeps complete chat completions URLs", () => {
    expect(normalizeChatCompletionsUrl("https://example.com/v1/chat/completions")).toBe(
      "https://example.com/v1/chat/completions",
    );
  });
});

describe("streamChatCompletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams text deltas and returns the final content", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        sseStream([
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          "[DONE]",
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const result = await streamChatCompletion({
      config: llmConfig(),
      messages: [{ role: "user", content: "Hi" }],
      onToken: (token) => {
        tokens.push(token);
      },
    });

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ content: "Hello", toolCalls: [] });
  });

  it("accumulates streamed tool call chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          sseStream([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "fetch_url", arguments: "{\"url\"" },
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
                        function: { arguments: ":\"https://example.com\"}" },
                      },
                    ],
                  },
                },
              ],
            },
            "[DONE]",
          ]),
          { status: 200 },
        ),
      ),
    );

    const result = await streamChatCompletion({
      config: llmConfig(),
      messages: [{ role: "user", content: "Fetch this" }],
      tools: [
        {
          type: "function",
          function: {
            name: "fetch_url",
            description: "Fetch a URL",
            parameters: { type: "object" },
          },
        },
      ],
      onToken: () => undefined,
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "fetch_url",
          arguments: "{\"url\":\"https://example.com\"}",
        },
      },
    ]);
  });

  it("serializes multimodal image parts for OpenAI-compatible providers", async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          sseStream([
            { choices: [{ delta: { content: "ok" } }] },
            "[DONE]",
          ]),
          { status: 200 },
        );
      }),
    );

    await streamChatCompletion({
      config: llmConfig(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              data: "data:image/png;base64,iVBORw0KGgo=",
              mediaType: "image/png",
            },
          ],
        },
      ],
      onToken: () => undefined,
    });

    expect(requestBody).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
  });

  it("throws on non-OK provider responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key", { status: 401 })),
    );

    await expect(
      streamChatCompletion({
        config: llmConfig(),
        messages: [{ role: "user", content: "Hi" }],
        onToken: () => undefined,
      }),
    ).rejects.toThrow("LLM request failed: 401 bad key");
  });
});

function llmConfig() {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "key",
    model: "gpt-test",
  };
}

function sseStream(events: Array<unknown | "[DONE]">) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
}

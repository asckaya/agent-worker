import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/worker/channels/commands";
import { createChannelRegistry } from "../src/worker/channels/registry";
import { readServerSentEvents } from "../src/worker/channels/sse";
import { telegramChannel } from "../src/worker/channels/telegram";
import { testChannel } from "../src/worker/channels/test";

describe("slash command parser", () => {
  it("parses commands, bot suffixes, and arguments", () => {
    expect(parseSlashCommand("/approve abc123")).toEqual({
      name: "approve",
      args: "abc123",
      raw: "/approve abc123",
      botName: undefined,
    });
    expect(parseSlashCommand("/Status@AgentBot now")).toEqual({
      name: "status",
      args: "now",
      raw: "/Status@AgentBot now",
      botName: "AgentBot",
    });
    expect(parseSlashCommand("not a command")).toBeNull();
  });
});

describe("SSE reader", () => {
  it("parses named JSON events split across chunks and maps legacy tokens", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("event: token\ndata: {\"token\":\"Hel\"}\n"));
          controller.enqueue(encoder.encode("\nevent: done\ndata: {\"content\":\"Hello\"}\n\n"));
          controller.close();
        },
      }),
    );

    const events = [];
    for await (const event of readServerSentEvents(response)) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "message_delta", data: { delta: "Hel" } },
      { event: "done", data: { content: "Hello" } },
    ]);
  });
});

describe("channel registry", () => {
  it("registers channel capabilities", () => {
    const registry = createChannelRegistry([telegramChannel, testChannel]);

    expect(registry.get("telegram")).toBe(telegramChannel);
    expect(registry.get("test")).toBe(testChannel);
    expect(registry.listCapabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "telegram",
          typedCommandPrefix: "/",
          supportsMessageEditing: true,
          supportsDraftStreaming: true,
        }),
        expect.objectContaining({
          name: "test",
          typedCommandPrefix: "/",
          supportsToolApprovalCommands: true,
        }),
      ]),
    );
  });

  it("rejects duplicate channel names", () => {
    const registry = createChannelRegistry([telegramChannel]);
    expect(() => registry.register(telegramChannel)).toThrow("Channel already registered");
  });
});

import { describe, expect, it } from "vitest";
import { buildClientHistoryMessages, buildModelMessages } from "../src/worker/agent/context";

describe("agent context", () => {
  it("keeps only valid browser history messages", () => {
    expect(
      buildClientHistoryMessages([
        { role: "system", content: "ignored" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "hi" },
      ]),
    ).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("injects bounded memory into model context", () => {
    const messages = buildModelMessages(
      [{ role: "user", content: "What should I remember?" }],
      Array.from({ length: 10 }, (_, index) => `memory ${index}`),
    );

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("memory 0");
    expect(messages[1]?.content).not.toContain("memory 8");
    expect(messages.at(-1)).toEqual({ role: "user", content: "What should I remember?" });
  });

  it("injects available skill guidance when provided", () => {
    const messages = buildModelMessages(
      [{ role: "user", content: "Plan this" }],
      [],
      { skillGuidance: "<available_skills><skill><name>planning</name></skill></available_skills>" },
    );

    expect(messages[1]).toEqual({
      role: "system",
      content: "<available_skills><skill><name>planning</name></skill></available_skills>",
    });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Plan this" });
  });

  it("does not trim chat history before sending model context", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index}`,
    }));

    const messages = buildModelMessages(history, []);

    expect(messages.slice(1)).toEqual(history);
  });
});

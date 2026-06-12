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
});

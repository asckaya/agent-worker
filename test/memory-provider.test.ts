import { describe, expect, it } from "vitest";
import {
  searchStoredMemories,
  tokenizeMemoryQuery,
} from "../src/worker/memory/provider";
import type { StoredMemory } from "../src/worker/types";

describe("memory provider helpers", () => {
  it("tokenizes memory search queries with stable bounds", () => {
    expect(tokenizeMemoryQuery("AI, ai; tg-worker x")).toEqual(["ai", "tg-worker"]);
  });

  it("returns scored memory matches without storing conversation history", () => {
    const memories: StoredMemory[] = [
      { id: "old", content: "Use email for invoices", created_at: 1 },
      { id: "new", content: "Telegram approvals are preferred", created_at: 3 },
      { id: "mid", content: "Use Telegram for personal agent alerts", created_at: 2 },
    ];

    expect(searchStoredMemories(memories, "telegram approvals", 2).map((memory) => memory.id)).toEqual([
      "new",
      "mid",
    ]);
    expect(searchStoredMemories(memories, "", 2).map((memory) => memory.id)).toEqual([
      "old",
      "new",
    ]);
  });
});

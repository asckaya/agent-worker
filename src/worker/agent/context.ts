import type { ChatMessage } from "../types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";

const MAX_HISTORY_MESSAGES = 24;
const MAX_MEMORY_ITEMS_IN_CONTEXT = 8;

export function buildModelMessages(history: ChatMessage[], memories: string[]): ChatMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
    },
  ];

  const memoryContext = memories
    .slice(0, MAX_MEMORY_ITEMS_IN_CONTEXT)
    .map((memory) => `- ${memory}`)
    .join("\n");
  if (memoryContext) {
    messages.push({
      role: "system",
      content: `Saved user memory:\n${memoryContext}`,
    });
  }

  messages.push(...recent);
  return messages;
}

export function buildClientHistoryMessages(history: Array<{ role: string; content: unknown }>) {
  return history
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .map<ChatMessage>((message) => ({
      role: message.role,
      content: message.content.slice(0, 16_000),
    }));
}

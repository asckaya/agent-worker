import type { ChatMessage } from "../types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";

const MAX_MEMORY_ITEMS_IN_CONTEXT = 8;

export function buildModelMessages(
  history: ChatMessage[],
  memories: string[],
  options: { skillGuidance?: string } = {},
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
    },
  ];

  if (options.skillGuidance) {
    messages.push({
      role: "system",
      content: options.skillGuidance,
    });
  }

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

  messages.push(...history);
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
      content: message.content,
    }));
}

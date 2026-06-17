import type { ChatMessage } from "../types";
import {
  memoryContextProvider,
  renderContextProviders,
  type AgentContextProvider,
} from "./context-providers";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";

const MAX_MEMORY_ITEMS_IN_CONTEXT = 8;

export function buildModelMessages(
  history: ChatMessage[],
  memories: string[],
  providers: AgentContextProvider[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
    },
  ];

  messages.push(...renderContextProviders([
    ...providers,
    memoryContextProvider(memories.slice(0, MAX_MEMORY_ITEMS_IN_CONTEXT)),
  ]));

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

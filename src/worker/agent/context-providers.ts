import type { ChatMessage } from "../types";

export interface AgentContextProvider {
  key: string;
  load: () => string | undefined;
}

export function contextProvider(key: string, load: () => string | undefined): AgentContextProvider {
  return { key, load };
}

export function renderContextProviders(providers: AgentContextProvider[]): ChatMessage[] {
  return providers.flatMap((provider) => {
    const content = provider.load()?.trim();
    if (!content) return [];
    return [{
      role: "system" as const,
      content: `<context source="${escapeXml(provider.key)}">\n${content}\n</context>`,
    }];
  });
}

export function memoryContextProvider(memories: string[]): AgentContextProvider {
  return contextProvider("memory/relevant", () => {
    const memoryContext = memories
      .map((memory) => `- ${memory}`)
      .join("\n");
    return memoryContext ? `Saved user memory:\n${memoryContext}` : undefined;
  });
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

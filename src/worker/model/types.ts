import type { ChatMessage, LlmConfig, ToolCall } from "../types";
import type { ModelTool } from "../tools/registry";

export interface ModelStreamOptions {
  config: LlmConfig;
  messages: ChatMessage[];
  tools?: ModelTool[];
  signal?: AbortSignal;
  onToken: (token: string) => Promise<void> | void;
}

export interface ModelStreamResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ModelClient {
  streamText(options: ModelStreamOptions): Promise<ModelStreamResult>;
}

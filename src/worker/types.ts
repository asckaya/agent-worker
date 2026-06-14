export interface Env {
  AGENT_OBJECT: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_SECRET_TOKEN?: string;
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  TELEGRAM_ALLOW_ALL_CHATS?: string;
  TELEGRAM_ADMIN_USER_IDS?: string;
  TELEGRAM_STREAM_TRANSPORT?: string;
  TELEGRAM_TEXT_BATCH_MS?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TEMPERATURE?: string;
  LLM_MAX_TOKENS?: string;
  GITHUB_TOKEN?: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ClientChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
}

export interface ChatRequest {
  message: string;
  history?: ClientChatMessage[];
  llm: LlmConfig;
  source?: ChannelSource;
}

export interface StoredMemory {
  id: string;
  content: string;
  created_at: number;
}

export interface ChannelSource {
  channel: string;
  chatId: string;
}

export interface PendingToolApproval {
  id: string;
  channel: string;
  chatId: string;
  toolName: string;
  toolInput: unknown;
  risk: string;
  created_at: number;
  expires_at: number;
}

export interface ActiveAgentRun {
  runId: string;
  channel: string;
  chatId: string;
  startedAt: number;
  status: "running" | "stopping";
  queuedMessageCount: number;
}

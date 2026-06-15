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
  TELEGRAM_TIME_ZONE?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TEMPERATURE?: string;
  LLM_MAX_TOKENS?: string;
  LLM_PROFILES_JSON?: string;
  GITHUB_TOKEN?: string;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type LlmModality = "text" | "image" | "audio" | "pdf";

export type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mediaType?: string;
      filename?: string;
    }
  | {
      type: "file";
      data: string;
      mediaType: string;
      filename?: string;
    };

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
  content: string | ChatContentPart[] | null;
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
  modalities?: LlmModality[];
}

export interface ChatRequest {
  message: string;
  history?: ClientChatMessage[];
  attachments?: ChatContentPart[];
  llm: LlmConfig;
  source?: ChannelSource;
  sessionId?: string;
}

export interface StoredMemory {
  id: string;
  content: string;
  created_at: number;
}

export interface StoredTask {
  id: string;
  channel: string;
  chatId: string;
  title: string;
  status: "pending" | "done";
  due_at: number | null;
  created_at: number;
  completed_at: number | null;
  notified_at: number | null;
}

export interface StoredChatSession {
  id: string;
  channel: string;
  chatId: string;
  title: string;
  created_at: number;
  updated_at: number;
  active?: boolean;
}

export interface ChannelSource {
  channel: string;
  chatId: string;
}

export interface PendingToolApproval {
  id: string;
  channel: string;
  chatId: string;
  sessionId?: string;
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

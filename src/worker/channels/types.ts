import type { Env } from "../types";

export interface ChannelMessage {
  channel: string;
  chatId: string;
  messageId?: number;
  text: string;
}

export interface ChannelCapabilities {
  name: string;
  typedCommandPrefix?: string;
  maxMessageLength?: number;
  supportsMessageEditing?: boolean;
  supportsDraftStreaming?: boolean;
  supportsToolApprovalCommands?: boolean;
}

export interface ChannelAdapter {
  name: string;
  capabilities: ChannelCapabilities;
  handleWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
}

export type AgentStreamEvent =
  | {
      event: "meta";
      data: Record<string, unknown>;
    }
  | {
      event: "message_delta";
      data: {
        delta: string;
      };
    }
  | {
      event: "message_stop";
      data: {
        content?: string;
      };
    }
  | {
      event: "tool_call";
      data: Record<string, unknown>;
    }
  | {
      event: "tool_result";
      data: Record<string, unknown>;
    }
  | {
      event: "approval_required";
      data: {
        message?: string;
        approval?: unknown;
      };
    }
  | {
      event: "done";
      data: {
        content?: string;
        memoryCount?: number;
        pendingApproval?: unknown;
        [key: string]: unknown;
      };
    }
  | {
      event: "error";
      data: {
        message: string;
      };
    };

export type AgentStreamEventName = AgentStreamEvent["event"];

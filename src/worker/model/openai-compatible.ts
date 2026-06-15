import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, streamText } from "ai";
import type { FilePart, ImagePart, JSONSchema7, ModelMessage, TextPart, ToolSet } from "ai";
import type { ChatContentPart, ChatMessage } from "../types";
import type { ModelTool } from "../tools/registry";
import type { ModelClient, ModelStreamOptions, ModelStreamResult } from "./types";

export class OpenAiCompatibleModelClient implements ModelClient {
  async streamText(options: ModelStreamOptions): Promise<ModelStreamResult> {
    const provider = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: normalizeOpenAICompatibleBaseUrl(options.config.baseUrl),
      apiKey: options.config.apiKey,
      headers: options.config.extraHeaders,
    });

    let streamError: unknown;
    const result = streamText({
      model: provider(options.config.model),
      messages: toModelMessages(options.messages),
      tools: toAiSdkTools(options.tools),
      toolChoice: options.tools?.length ? "auto" : undefined,
      maxRetries: 0,
      abortSignal: options.signal,
      temperature: options.config.temperature ?? 0.7,
      maxOutputTokens: options.config.maxTokens,
      onError: ({ error }) => {
        streamError = error;
      },
    });

    let content = "";
    for await (const token of result.textStream) {
      content += token;
      await options.onToken(token);
    }

    if (streamError) {
      throw normalizeProviderError(streamError);
    }

    return {
      content,
      toolCalls: (await result.toolCalls).map((toolCall) => ({
        id: toolCall.toolCallId,
        type: "function",
        function: {
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.input ?? {}),
        },
      })),
    };
  }
}

export function normalizeChatCompletionsUrl(baseUrl: string) {
  const trimmed = normalizeOpenAICompatibleBaseUrl(baseUrl);
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("LLM base URL is required.");
  }
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}

export async function streamChatCompletion(
  options: ModelStreamOptions,
): Promise<ModelStreamResult> {
  return new OpenAiCompatibleModelClient().streamText(options);
}

function toAiSdkTools(tools: ModelTool[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;

  return Object.fromEntries(
    tools.map((tool) => [
      tool.function.name,
      {
        description: tool.function.description,
        inputSchema: jsonSchema(tool.function.parameters as JSONSchema7),
      },
    ]),
  ) as ToolSet;
}

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id ?? crypto.randomUUID(),
            toolName: message.name ?? "unknown_tool",
            output: toToolResultOutput(contentToText(message.content)),
          },
        ],
      };
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      return {
        role: "assistant",
        content: [
          ...(typeof message.content === "string" && message.content
            ? [
                {
                  type: "text" as const,
                  text: message.content,
                },
              ]
            : []),
          ...message.tool_calls.map((toolCall) => ({
            type: "tool-call" as const,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            input: parseToolCallArguments(toolCall.function.arguments),
          })),
        ],
      };
    }

    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        role: "user",
        content: message.content.map(toModelContentPart),
      };
    }

    return {
      role: message.role,
      content: contentToText(message.content),
    } as ModelMessage;
  });
}

function toModelContentPart(part: ChatContentPart): TextPart | ImagePart | FilePart {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    };
  }

  if (part.type === "image") {
    return {
      type: "image",
      image: part.data,
      mediaType: part.mediaType,
    };
  }

  return {
    type: "file",
    data: part.data,
    mediaType: part.mediaType,
    filename: part.filename,
  };
}

function contentToText(content: ChatMessage["content"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}: ${part.filename ?? part.mediaType ?? "attachment"}]`))
    .join("\n");
}

function parseToolCallArguments(value: string) {
  if (!value.trim()) return {};

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function toToolResultOutput(value: string | null) {
  if (!value) return { type: "text" as const, value: "" };

  try {
    return { type: "json" as const, value: JSON.parse(value) };
  } catch {
    return { type: "text" as const, value };
  }
}

function normalizeProviderError(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    const responseBody = "responseBody" in error ? error.responseBody : undefined;
    if (typeof statusCode === "number") {
      return new Error(
        `LLM request failed: ${statusCode} ${
          typeof responseBody === "string" ? responseBody : ""
        }`.trim(),
      );
    }
  }

  return error instanceof Error ? error : new Error("LLM request failed.");
}

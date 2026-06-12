import { z } from "zod";
import { fetchAgentObject } from "./agent-object";
import { readServerSentEvents } from "./sse";
import type { AgentStreamEvent, ChannelAdapter, ChannelCapabilities } from "./types";
import type { Env, LlmConfig } from "../types";
import {
  ClientChatMessageSchema,
  LlmConfigSchema,
  parseServerLlmEnv,
} from "../validation";

const TEST_CHANNEL_NAME = "test";
const TEST_CHANNEL_DEFAULT_CHAT_ID = "default";
const MAX_TEST_MESSAGE_CHARS = 16_000;

const responseFormatSchema = z.enum(["sse", "json"]).optional();

const TestChatRequestSchema = z.object({
  chatId: z.string().trim().min(1).max(128).optional().default(TEST_CHANNEL_DEFAULT_CHAT_ID),
  message: z
    .string()
    .trim()
    .min(1)
    .transform((message) => message.slice(0, MAX_TEST_MESSAGE_CHARS)),
  history: z.array(ClientChatMessageSchema).optional().default([]),
  llm: LlmConfigSchema.optional(),
  format: responseFormatSchema,
});

const TestControlRequestSchema = z.object({
  chatId: z.string().trim().min(1).max(128).optional().default(TEST_CHANNEL_DEFAULT_CHAT_ID),
});

const TestApprovalRequestSchema = TestControlRequestSchema.extend({
  llm: LlmConfigSchema.optional(),
  format: responseFormatSchema,
});

type TestChatRequest = z.infer<typeof TestChatRequestSchema>;
type TestApprovalRequest = z.infer<typeof TestApprovalRequestSchema>;

export const testChannelCapabilities: ChannelCapabilities = {
  name: TEST_CHANNEL_NAME,
  typedCommandPrefix: "/",
  maxMessageLength: MAX_TEST_MESSAGE_CHARS,
  supportsToolApprovalCommands: true,
};

export const testChannel: ChannelAdapter = {
  name: TEST_CHANNEL_NAME,
  capabilities: testChannelCapabilities,
  handleWebhook: handleTestChannelRequest,
};

export async function handleTestChannelRequest(
  request: Request,
  env: Env,
  _ctx?: ExecutionContext,
) {
  try {
    return await routeTestChannelRequest(request, env);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Test channel request failed.",
      },
      { status: 400 },
    );
  }
}

async function routeTestChannelRequest(request: Request, env: Env) {
  const url = new URL(request.url);

  if (request.method === "GET" && isTestChannelRoot(url.pathname)) {
    return Response.json({
      ok: true,
      channel: TEST_CHANNEL_NAME,
      capabilities: testChannelCapabilities,
      endpoints: [
        "POST /api/test-channel/chat",
        "POST /api/test-channel/approvals/:id/approve",
        "POST /api/test-channel/approvals/:id/deny",
        "POST /api/test-channel/stop",
        "GET /api/test-channel/approvals?chatId=default",
        "GET /api/test-channel/state",
      ],
    });
  }

  if (request.method === "POST" && url.pathname.endsWith("/chat")) {
    return handleTestChat(request, env);
  }

  const approvalMatch = /\/approvals\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
  if (request.method === "POST" && approvalMatch) {
    const approvalId = decodeURIComponent(approvalMatch[1]);
    return approvalMatch[2] === "approve"
      ? handleTestApprove(request, env, approvalId)
      : handleTestDeny(request, env, approvalId);
  }

  if (
    request.method === "POST" &&
    (url.pathname.endsWith("/stop") || url.pathname.endsWith("/sessions/stop"))
  ) {
    return handleTestStop(request, env);
  }

  if (request.method === "GET" && url.pathname.endsWith("/approvals")) {
    const chatId = url.searchParams.get("chatId")?.trim() || TEST_CHANNEL_DEFAULT_CHAT_ID;
    return fetchAgentObject(
      env,
      request.url,
      `/approvals?channel=${TEST_CHANNEL_NAME}&chatId=${encodeURIComponent(chatId)}`,
      { method: "GET" },
    );
  }

  if (request.method === "GET" && url.pathname.endsWith("/state")) {
    return fetchAgentObject(env, request.url, "/state", { method: "GET" });
  }

  return Response.json({ ok: false, error: "Unknown test channel endpoint." }, { status: 404 });
}

async function handleTestChat(request: Request, env: Env) {
  const payload = await parseJsonBody(request, TestChatRequestSchema);
  const llm = resolveRequiredLlm(payload, env);
  if (llm instanceof Error) {
    return Response.json({ ok: false, error: llm.message }, { status: 400 });
  }

  const response = await fetchAgentObject(env, request.url, "/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: payload.message,
      history: payload.history,
      llm,
      source: { channel: TEST_CHANNEL_NAME, chatId: payload.chatId },
    }),
  });

  return maybeJsonAgentStream(request, payload.format, response);
}

async function handleTestApprove(request: Request, env: Env, approvalId: string) {
  const payload = await parseJsonBody(request, TestApprovalRequestSchema);
  const llm = resolveOptionalLlm(payload, env);
  const response = await fetchAgentObject(
    env,
    request.url,
    `/approvals/${encodeURIComponent(approvalId)}/approve-stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { channel: TEST_CHANNEL_NAME, chatId: payload.chatId },
        ...(llm ? { llm } : {}),
      }),
    },
  );

  return maybeJsonAgentStream(request, payload.format, response);
}

async function handleTestDeny(request: Request, env: Env, approvalId: string) {
  const payload = await parseJsonBody(request, TestControlRequestSchema);
  return fetchAgentObject(
    env,
    request.url,
    `/approvals/${encodeURIComponent(approvalId)}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { channel: TEST_CHANNEL_NAME, chatId: payload.chatId },
      }),
    },
  );
}

async function handleTestStop(request: Request, env: Env) {
  const payload = await parseJsonBody(request, TestControlRequestSchema);
  return fetchAgentObject(env, request.url, "/sessions/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { channel: TEST_CHANNEL_NAME, chatId: payload.chatId },
    }),
  });
}

async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const result = schema.safeParse(await request.json().catch(() => ({})));
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

function resolveRequiredLlm(payload: Pick<TestChatRequest, "llm">, env: Env) {
  return payload.llm ?? parseServerLlmEnv(env, "test channel");
}

function resolveOptionalLlm(payload: Pick<TestApprovalRequest, "llm">, env: Env) {
  if (payload.llm) return payload.llm;
  const llm = parseServerLlmEnv(env, "test channel");
  return llm instanceof Error ? undefined : llm;
}

async function maybeJsonAgentStream(
  request: Request,
  format: "sse" | "json" | undefined,
  response: Response,
) {
  if (!response.ok || resolveResponseFormat(request, format) === "sse") {
    return response;
  }

  const events: AgentStreamEvent[] = [];
  for await (const event of readServerSentEvents(response)) {
    events.push(event);
  }

  const error = [...events].reverse().find((event) => event.event === "error");
  if (error?.event === "error") {
    return Response.json(
      {
        ok: false,
        error: error.data.message,
        events,
      },
      { status: 500 },
    );
  }

  const done = [...events].reverse().find((event) => event.event === "done");
  const approvalRequired = [...events]
    .reverse()
    .find((event) => event.event === "approval_required");
  const doneData = done?.event === "done" ? done.data : {};

  return Response.json({
    ok: true,
    content: typeof doneData.content === "string" ? doneData.content : undefined,
    pendingApproval: doneData.pendingApproval,
    approval:
      approvalRequired?.event === "approval_required" ? approvalRequired.data.approval : undefined,
    memoryCount: doneData.memoryCount,
    events,
  });
}

function resolveResponseFormat(request: Request, format: "sse" | "json" | undefined) {
  if (format) return format;
  const url = new URL(request.url);
  return url.searchParams.get("format") === "json" ? "json" : "sse";
}

function isTestChannelRoot(pathname: string) {
  return pathname === "/api/test-channel" || pathname.endsWith("/test-channel");
}

function formatZodError(error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return "Invalid test channel request.";
  const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `Invalid test channel request${path}: ${issue.message}`;
}

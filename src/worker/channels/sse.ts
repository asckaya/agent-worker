import type { AgentStreamEvent, AgentStreamEventName } from "./types";

const encoder = new TextEncoder();

export async function* readServerSentEvents(response: Response): AsyncGenerator<AgentStreamEvent> {
  if (!response.body) return;

  const decoder = new TextDecoder();
  let buffer = "";

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);

      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseBlock(block);
        if (event) yield event;
        boundary = findBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) yield event;
}

export async function writeAgentStreamEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: AgentStreamEvent,
) {
  await writer.write(
    encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
  );
}

export function createAgentStreamEvent<EventName extends AgentStreamEventName>(
  event: EventName,
  data: Extract<AgentStreamEvent, { event: EventName }>["data"],
): Extract<AgentStreamEvent, { event: EventName }> {
  return { event, data } as Extract<AgentStreamEvent, { event: EventName }>;
}

function findBoundary(value: string) {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  const candidates = [
    lf >= 0 ? { index: lf, length: 2 } : null,
    crlf >= 0 ? { index: crlf, length: 4 } : null,
  ].filter((item): item is { index: number; length: number } => item !== null);

  return candidates.sort((left, right) => left.index - right.index)[0];
}

function parseSseBlock(block: string): AgentStreamEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) return null;

  const rawData = data.join("\n");
  const parsedData = parseSseData(rawData);
  return normalizeAgentStreamEvent(event, parsedData);
}

function parseSseData(rawData: string) {
  try {
    return JSON.parse(rawData) as unknown;
  } catch {
    return rawData;
  }
}

function normalizeAgentStreamEvent(event: string, data: unknown): AgentStreamEvent | null {
  switch (event) {
    case "meta":
      return createAgentStreamEvent("meta", readRecord(data));
    case "token":
      return createAgentStreamEvent("message_delta", { delta: readStringField(data, "token") });
    case "message_delta":
      return createAgentStreamEvent("message_delta", { delta: readStringField(data, "delta") });
    case "message_stop":
      return createAgentStreamEvent("message_stop", {
        content: readOptionalStringField(data, "content"),
      });
    case "tool_call":
      return createAgentStreamEvent("tool_call", readRecord(data));
    case "tool_result":
      return createAgentStreamEvent("tool_result", readRecord(data));
    case "approval_required":
      return createAgentStreamEvent("approval_required", {
        ...readRecord(data),
        message: readOptionalStringField(data, "message"),
      });
    case "done":
      return createAgentStreamEvent("done", readRecord(data));
    case "error":
      return createAgentStreamEvent("error", {
        message: readOptionalStringField(data, "message") ?? "Agent stream failed.",
      });
    default:
      return null;
  }
}

function readRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function readStringField(data: unknown, key: string) {
  return readOptionalStringField(data, key) ?? "";
}

function readOptionalStringField(data: unknown, key: string) {
  const record = readRecord(data);
  return typeof record[key] === "string" ? record[key] : undefined;
}

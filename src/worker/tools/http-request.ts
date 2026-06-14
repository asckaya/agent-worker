import { z } from "zod";
import type { ToolDefinition } from "./registry";

const MAX_REQUEST_BODY_CHARS = 64_000;
const MAX_RESPONSE_TEXT_CHARS = 120_000;
const MAX_HEADER_VALUE_CHARS = 2_000;
const MAX_RESPONSE_HEADERS = 40;
const DISALLOWED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

const HttpHeaderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
    .describe("HTTP header name."),
  value: z
    .string()
    .max(MAX_HEADER_VALUE_CHARS)
    .refine((value) => !/[\r\n]/.test(value), "Header values cannot contain newlines.")
    .describe("HTTP header value."),
});

const HttpRequestInputSchema = z
  .object({
    url: z.string().url().describe("Absolute HTTP or HTTPS URL."),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
      .optional()
      .default("GET")
      .describe("HTTP method."),
    headers: z
      .array(HttpHeaderSchema)
      .max(20)
      .optional()
      .default([])
      .describe("Optional request headers."),
    body: z
      .string()
      .max(MAX_REQUEST_BODY_CHARS)
      .optional()
      .describe("Optional request body for POST, PUT, PATCH, or DELETE."),
  })
  .superRefine((input, ctx) => {
    if ((input.method === "GET" || input.method === "HEAD") && input.body) {
      ctx.addIssue({
        code: "custom",
        path: ["body"],
        message: "GET and HEAD requests cannot include a body.",
      });
    }
  });

type HttpRequestInput = z.infer<typeof HttpRequestInputSchema>;

export interface HttpRequestResult {
  url: string;
  finalUrl: string;
  method: string;
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  contentType?: string;
  headers: Record<string, string>;
  text?: string;
  json?: unknown;
  truncated: boolean;
}

export const httpRequestTool: ToolDefinition<HttpRequestInput, HttpRequestResult> = {
  name: "http_request",
  description:
    "Make a bounded curl-like HTTP request. Supports common methods, headers, and text bodies for API checks or reading public web resources.",
  inputSchema: HttpRequestInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "web",
  maxResultChars: MAX_RESPONSE_TEXT_CHARS + 8_000,
  presentation: {
    label: "HTTP Request",
    icon: "globe",
  },
  async execute(ctx, input) {
    const url = normalizeHttpUrl(input.url);
    const headers = buildHeaders(input.headers);
    const response = await ctx.fetch(url.toString(), {
      method: input.method,
      headers,
      body: input.body,
      redirect: "follow",
    });
    const text = input.method === "HEAD" ? "" : await response.text();
    const contentType = response.headers.get("content-type") ?? undefined;
    const truncated = text.length > MAX_RESPONSE_TEXT_CHARS;
    const boundedText = text.slice(0, MAX_RESPONSE_TEXT_CHARS);
    const parsedJson = parseJsonResponse(boundedText, contentType);

    return {
      url: url.toString(),
      finalUrl: response.url || url.toString(),
      method: input.method,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      contentType,
      headers: readResponseHeaders(response.headers),
      ...(parsedJson === undefined ? { text: boundedText } : { json: parsedJson, text: boundedText }),
      truncated,
    };
  },
};

function normalizeHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return url;
}

function buildHeaders(inputHeaders: HttpRequestInput["headers"]) {
  const headers = new Headers();
  for (const header of inputHeaders) {
    const name = header.name.toLowerCase();
    if (DISALLOWED_REQUEST_HEADERS.has(name)) {
      throw new Error(`Header is not allowed: ${header.name}`);
    }
    headers.set(header.name, header.value);
  }
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "agent-worker/0.1");
  }
  return headers;
}

function readResponseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "set-cookie") continue;
    result[name] = value.slice(0, MAX_HEADER_VALUE_CHARS);
    count += 1;
    if (count >= MAX_RESPONSE_HEADERS) break;
  }
  return result;
}

function parseJsonResponse(text: string, contentType: string | undefined) {
  if (!contentType?.toLowerCase().includes("json")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

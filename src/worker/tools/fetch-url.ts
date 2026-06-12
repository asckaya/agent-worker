import { z } from "zod";
import type { ToolDefinition } from "./registry";

const MAX_TEXT_BYTES = 120_000;
const FetchUrlInputSchema = z.object({
  url: z.string().url().describe("Absolute HTTP or HTTPS URL."),
});

export const fetchUrlTool: ToolDefinition<{ url: string }, { url: string; status: number; text: string }> = {
  name: "fetch_url",
  description: "Fetch a public URL and return a bounded text response.",
  inputSchema: FetchUrlInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "web",
  maxResultChars: MAX_TEXT_BYTES,
  presentation: {
    label: "Fetch URL",
    icon: "globe",
  },
  async execute(ctx, input) {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported.");
    }

    const response = await ctx.fetch(url.toString(), {
      headers: { "User-Agent": "agent-worker/0.1" },
    });
    const text = await response.text();
    return {
      url: url.toString(),
      status: response.status,
      text: text.slice(0, MAX_TEXT_BYTES),
    };
  },
};

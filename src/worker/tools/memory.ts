import { z } from "zod";
import type { ToolDefinition } from "./registry";

const SaveMemoryInputSchema = z.object({
  content: z.string().trim().min(1).max(1200).describe("Memory content to save."),
});

const SearchMemoryInputSchema = z.object({
  query: z.string().trim().min(1).max(200).describe("Search query."),
});

export const saveMemoryTool: ToolDefinition<{ content: string }, { saved: true }> = {
  name: "save_memory",
  description: "Save a stable user preference or reusable fact to long-term memory.",
  inputSchema: SaveMemoryInputSchema,
  risk: "write",
  requiresApproval: false,
  toolset: "memory",
  maxResultChars: 2_000,
  presentation: {
    label: "Save Memory",
    icon: "database",
  },
  async execute(ctx, input) {
    await ctx.saveMemory(input.content);
    return { saved: true };
  },
};

export const searchMemoryTool: ToolDefinition<{ query: string }, { results: string[] }> = {
  name: "search_memory",
  description: "Search saved long-term memory.",
  inputSchema: SearchMemoryInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "memory",
  maxResultChars: 8_000,
  presentation: {
    label: "Search Memory",
    icon: "search",
  },
  async execute(ctx, input) {
    return { results: await ctx.searchMemory(input.query) };
  },
};

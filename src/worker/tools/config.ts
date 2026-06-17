import { z } from "zod";
import {
  formatSkillContent,
  SkillNameSchema,
  SkillSourceStringSchema,
} from "../skills/settings";
import { SkillSourceImportSchema } from "../skills/source";
import { McpServerNameSchema, PublicMcpServerUpdateSchema } from "../mcp/settings";
import type { ToolContext, ToolDefinition } from "./registry";

const SkillLoadInputSchema = z.object({
  name: SkillNameSchema.describe("The name of the skill from the available skills list."),
});

const DeleteSkillInputSchema = z.object({
  name: SkillNameSchema,
});

const SetSkillSourcesInputSchema = z.object({
  sources: z.array(SkillSourceStringSchema).max(20),
});

const EmptyInputSchema = z.object({});

const DeleteMcpServerInputSchema = z.object({
  name: McpServerNameSchema,
});

const OptionalMcpServerInputSchema = z.object({
  name: McpServerNameSchema.optional(),
});

const McpPromptInputSchema = z.object({
  server: McpServerNameSchema,
  name: z.string().trim().min(1).max(200),
  arguments: z.record(z.string(), z.string()).optional(),
});

const McpResourceInputSchema = z.object({
  server: McpServerNameSchema,
  uri: z.string().trim().min(1).max(2_000),
});

export const importSkillSourcesTool: ToolDefinition<z.infer<typeof SkillSourceImportSchema>, unknown> = {
  name: "import_skill_sources",
  description: [
    "Import one or more SQL-backed skills from skills package source strings.",
    "Use the same source formats as the skills package, such as owner/repo, owner/repo/path, owner/repo@skill, github:owner/repo, or GitHub tree URLs.",
  ].join("\n"),
  inputSchema: SkillSourceImportSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "skills",
  execute: async (ctx, input) => {
    const skills = await requireSkills(ctx).importSources(input);
    return {
      ok: true,
      imported: skills.map((skill) => skill.name),
      count: skills.length,
    };
  },
};

export const setSkillSourcesTool: ToolDefinition<z.infer<typeof SetSkillSourcesInputSchema>, unknown> = {
  name: "set_skill_sources",
  description: [
    "Replace the saved SQL-backed skill source list.",
    "Use source strings compatible with the skills package. This only saves sources; use import_skill_sources or reimport_skill_sources to import SKILL.md files.",
  ].join("\n"),
  inputSchema: SetSkillSourcesInputSchema,
  risk: "write",
  requiresApproval: true,
  toolset: "skills",
  execute: async (ctx, input) => ({
    ok: true,
    sources: await requireSkills(ctx).setSources(input.sources),
  }),
};

export const reimportSkillSourcesTool: ToolDefinition<z.infer<typeof EmptyInputSchema>, unknown> = {
  name: "reimport_skill_sources",
  description: "Reimport all saved SQL-backed skill sources and update installed skills.",
  inputSchema: EmptyInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "skills",
  execute: async (ctx) => {
    const skills = await requireSkills(ctx).reimportSources();
    return {
      ok: true,
      imported: skills.map((skill) => skill.name),
      count: skills.length,
    };
  },
};

export const skillTool: ToolDefinition<z.infer<typeof SkillLoadInputSchema>, unknown> = {
  name: "skill",
  description: [
    "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
    "The skill name must match one of the available skills.",
  ].join("\n"),
  inputSchema: SkillLoadInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "skills",
  maxResultChars: 60_000,
  execute: async (ctx, input) => {
    const skills = await requireSkills(ctx).list();
    const skill = skills.find((item) => item.name === input.name);
    if (!skill) {
      return {
        error: `Skill not found: ${input.name}`,
        availableSkills: skills.map((item) => item.name).sort(),
      };
    }
    return formatSkillContent(skill);
  },
};

export const deleteSkillTool: ToolDefinition<z.infer<typeof DeleteSkillInputSchema>, unknown> = {
  name: "delete_skill",
  description: "Delete a SQL-backed skill by name.",
  inputSchema: DeleteSkillInputSchema,
  risk: "write",
  requiresApproval: true,
  toolset: "skills",
  execute: async (ctx, input) => ({
    ok: await requireSkills(ctx).delete(input.name),
    name: input.name,
  }),
};

export const getMcpStatusTool: ToolDefinition<z.infer<typeof OptionalMcpServerInputSchema>, unknown> = {
  name: "get_mcp_status",
  description: "Return cached MCP server connection status, listed tool counts, prompt counts, resource counts, and last errors.",
  inputSchema: OptionalMcpServerInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "mcp",
  execute: async (ctx) => requireMcp(ctx).status(),
};

export const refreshMcpToolsTool: ToolDefinition<z.infer<typeof OptionalMcpServerInputSchema>, unknown> = {
  name: "refresh_mcp_tools",
  description: "Refresh MCP server connections and listed tools/prompts/resources. Optionally refresh one server by name.",
  inputSchema: OptionalMcpServerInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "mcp",
  execute: async (ctx, input) => requireMcp(ctx).refresh(input.name),
};

export const upsertMcpServerTool: ToolDefinition<z.infer<typeof PublicMcpServerUpdateSchema>, unknown> = {
  name: "upsert_mcp_server",
  description: [
    "Create or update a SQL-backed remote MCP server using a public HTTP/HTTPS endpoint.",
    "This tool cannot set authorization headers or tokens; configure secret headers from the protected status page.",
  ].join("\n"),
  inputSchema: PublicMcpServerUpdateSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "mcp",
  execute: async (ctx, input) => {
    await requireMcp(ctx).upsertPublicServer(input);
    return {
      ok: true,
      server: input,
    };
  },
};

export const listMcpPromptsTool: ToolDefinition<z.infer<typeof OptionalMcpServerInputSchema>, unknown> = {
  name: "list_mcp_prompts",
  description: "List cached MCP prompts from all connected servers or one server.",
  inputSchema: OptionalMcpServerInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "mcp",
  execute: async (ctx, input) => requireMcp(ctx).listPrompts(input.name),
};

export const getMcpPromptTool: ToolDefinition<z.infer<typeof McpPromptInputSchema>, unknown> = {
  name: "get_mcp_prompt",
  description: "Get a prompt from a configured MCP server.",
  inputSchema: McpPromptInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "mcp",
  maxResultChars: 20_000,
  execute: async (ctx, input) =>
    requireMcp(ctx).getPrompt(input.server, input.name, input.arguments),
};

export const listMcpResourcesTool: ToolDefinition<z.infer<typeof OptionalMcpServerInputSchema>, unknown> = {
  name: "list_mcp_resources",
  description: "List cached MCP resources from all connected servers or one server.",
  inputSchema: OptionalMcpServerInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "mcp",
  execute: async (ctx, input) => requireMcp(ctx).listResources(input.name),
};

export const readMcpResourceTool: ToolDefinition<z.infer<typeof McpResourceInputSchema>, unknown> = {
  name: "read_mcp_resource",
  description: "Read a resource from a configured MCP server.",
  inputSchema: McpResourceInputSchema,
  risk: "external",
  requiresApproval: true,
  toolset: "mcp",
  maxResultChars: 30_000,
  execute: async (ctx, input) => requireMcp(ctx).readResource(input.server, input.uri),
};

export const deleteMcpServerTool: ToolDefinition<z.infer<typeof DeleteMcpServerInputSchema>, unknown> = {
  name: "delete_mcp_server",
  description: "Delete a SQL-backed remote MCP server by name.",
  inputSchema: DeleteMcpServerInputSchema,
  risk: "write",
  requiresApproval: true,
  toolset: "mcp",
  execute: async (ctx, input) => ({
    ok: await requireMcp(ctx).deleteServer(input.name),
    name: input.name,
  }),
};

function requireSkills(ctx: ToolContext) {
  if (!ctx.skills) {
    throw new Error("Skill settings are not available in this runtime.");
  }
  return ctx.skills;
}

function requireMcp(ctx: ToolContext) {
  if (!ctx.mcp) {
    throw new Error("MCP settings are not available in this runtime.");
  }
  return ctx.mcp;
}

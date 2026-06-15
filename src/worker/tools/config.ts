import { z } from "zod";
import {
  formatSkillContent,
  parseSkillDefinitionPayload,
  SkillDefinitionSchema,
  SkillMarkdownImportSchema,
  SkillNameSchema,
} from "../skills/settings";
import { McpServerNameSchema, PublicMcpServerUpdateSchema } from "../mcp/settings";
import type { ToolContext, ToolDefinition } from "./registry";

const SkillLoadInputSchema = z.object({
  name: SkillNameSchema.describe("The name of the skill from the available skills list."),
});

const DeleteSkillInputSchema = z.object({
  name: SkillNameSchema,
});

const DeleteMcpServerInputSchema = z.object({
  name: McpServerNameSchema,
});

const UpsertSkillInputSchema = z.union([SkillMarkdownImportSchema, SkillDefinitionSchema]);

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

export const upsertSkillTool: ToolDefinition<z.infer<typeof UpsertSkillInputSchema>, unknown> = {
  name: "upsert_skill",
  description: [
    "Create or update a SQL-backed skill from a standard skills package SKILL.md document.",
    "Prefer the markdown input with YAML frontmatter containing name and description.",
  ].join("\n"),
  inputSchema: UpsertSkillInputSchema,
  risk: "write",
  requiresApproval: true,
  toolset: "skills",
  execute: async (ctx, input) => {
    const skill = parseSkillDefinitionPayload(input);
    await requireSkills(ctx).upsert(skill);
    return {
      ok: true,
      skill: {
        name: skill.name,
        description: skill.description,
        sourcePath: skill.sourcePath,
      },
    };
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

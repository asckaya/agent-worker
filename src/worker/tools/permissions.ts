import { z } from "zod";
import type { ToolDefinition } from "./registry";

const MAX_PERMISSION_RULES = 100;
const MAX_PATTERN_CHARS = 160;

export const PERMISSION_SETTINGS_KEY = "permissions";

export const PermissionActionSchema = z.enum(["ask", "allow", "deny"]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

export const ToolPermissionRuleSchema = z.object({
  tool: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PATTERN_CHARS)
    .regex(/^[A-Za-z0-9_*?-]+$/, "Use tool names or wildcard patterns."),
  action: PermissionActionSchema,
});

export const PermissionSettingsSchema = z.object({
  rules: z.array(ToolPermissionRuleSchema).max(MAX_PERMISSION_RULES).default([]),
});

export type ToolPermissionRule = z.infer<typeof ToolPermissionRuleSchema>;
export type PermissionSettings = z.infer<typeof PermissionSettingsSchema>;

export interface PermissionDecision {
  action: PermissionAction;
  rule?: ToolPermissionRule;
}

export function parsePermissionSettingsPayload(payload: unknown): PermissionSettings {
  const result = PermissionSettingsSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(formatZodError("Invalid permission settings", result.error));
  }
  return result.data;
}

export function evaluateToolPermission(
  tool: Pick<ToolDefinition, "name" | "requiresApproval">,
  settings: PermissionSettings,
): PermissionDecision {
  const rule = [...settings.rules]
    .reverse()
    .find((candidate) => wildcardMatch(tool.name, candidate.tool));
  if (rule) return { action: rule.action, rule };
  return { action: tool.requiresApproval ? "ask" : "allow" };
}

export function permissionSettingsSummary(settings: PermissionSettings) {
  return {
    ruleCount: settings.rules.length,
    rules: settings.rules,
  };
}

function wildcardMatch(value: string, pattern: string) {
  if (pattern === "*") return true;
  const expression = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*")}$`,
  );
  return expression.test(value);
}

function formatZodError(prefix: string, error: z.ZodError) {
  const issue = error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return `${prefix}${path}: ${issue?.message ?? "schema error"}`;
}

import { z } from "zod";
import type { Env } from "../types";

export type ToolRisk = "read" | "write" | "external" | "dangerous";
export type ToolAvailability =
  | boolean
  | {
      available: boolean;
      reason?: string;
    };

export interface ToolAvailabilityContext {
  env?: Env;
}

export interface ToolContext {
  fetch: typeof fetch;
  env?: Env;
  saveMemory: (content: string) => Promise<void>;
  searchMemory: (query: string) => Promise<string[]>;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  risk: ToolRisk;
  requiresApproval: boolean;
  toolset?: string;
  requiresEnv?: string[];
  maxResultChars?: number;
  presentation?: {
    label?: string;
    icon?: string;
  };
  isAvailable?: (ctx: ToolAvailabilityContext) => ToolAvailability;
  execute(ctx: ToolContext, input: Input): Promise<Output>;
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly availabilityContext: ToolAvailabilityContext = {}) {}

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(options: { includeUnavailable?: boolean } = {}) {
    const tools = [...this.tools.values()];
    if (options.includeUnavailable) return tools;
    return tools.filter((tool) => this.getAvailability(tool).available);
  }

  listModelTools() {
    return this.list().map<ModelTool>((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.requiresApproval
          ? `${tool.description} Requires explicit user approval before execution.`
          : tool.description,
        parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
      },
    }));
  }

  get(name: string) {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return this.getAvailability(tool).available ? tool : undefined;
  }

  getAvailability(tool: ToolDefinition) {
    const missingEnv = (tool.requiresEnv ?? []).filter(
      (key) => !this.availabilityContext.env?.[key as keyof Env],
    );
    if (missingEnv.length > 0) {
      return {
        available: false,
        reason: `Missing env: ${missingEnv.join(", ")}`,
      };
    }

    const dynamicAvailability = tool.isAvailable?.(this.availabilityContext);
    if (typeof dynamicAvailability === "boolean") {
      return { available: dynamicAvailability };
    }
    if (dynamicAvailability) return dynamicAvailability;
    return { available: true };
  }
}

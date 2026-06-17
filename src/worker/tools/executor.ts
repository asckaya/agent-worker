import type { PendingToolApproval, ToolCall } from "../types";
import type { PermissionDecision } from "./permissions";
import type { ToolContext, ToolDefinition, ToolRegistry } from "./registry";

export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export interface ToolApprovalRequest {
  tool: ToolDefinition;
  input: unknown;
}

export interface ToolApprovalGate {
  create(request: ToolApprovalRequest): Promise<PendingToolApproval>;
}

export type ToolExecutionOutcome =
  | {
      status: "executed";
      result: unknown;
    }
  | {
      status: "approval_required";
      approval: PendingToolApproval;
    };

export interface ToolExecutorOptions {
  timeoutMs?: number;
  approvalGate?: ToolApprovalGate;
  permissionEvaluator?: (tool: ToolDefinition) => PermissionDecision;
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolContext,
    private readonly options: ToolExecutorOptions = {},
  ) {}

  async executeToolCall(
    toolCall: ToolCall,
    options: { bypassApproval?: boolean } = {},
  ): Promise<ToolExecutionOutcome> {
    const tool = this.registry.get(toolCall.function.name);
    if (!tool) {
      return executedError(`Unknown tool: ${toolCall.function.name}`);
    }

    const input = parseToolArguments(toolCall.function.arguments);
    if (input instanceof Error) {
      return executedError(input.message);
    }

    return this.executeTool(tool, input, options);
  }

  async executeStoredTool(
    toolName: string,
    input: unknown,
    options: { bypassApproval?: boolean } = {},
  ): Promise<ToolExecutionOutcome> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return executedError(`Unknown tool: ${toolName}`);
    }

    return this.executeTool(tool, input, options);
  }

  private async executeTool(
    tool: ToolDefinition,
    input: unknown,
    options: { bypassApproval?: boolean },
  ): Promise<ToolExecutionOutcome> {
    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return executedError(
        `Invalid input for ${tool.name}: ${
          parsedInput.error.issues[0]?.message ?? "schema error"
        }`,
      );
    }

    const permission = this.options.permissionEvaluator?.(tool) ?? {
      action: tool.requiresApproval ? "ask" : "allow",
    };

    if (permission.action === "deny") {
      return executedError(`Tool denied by permission policy: ${tool.name}`);
    }

    if (permission.action === "ask" && !options.bypassApproval) {
      if (!this.options.approvalGate) {
        return executedError(`Tool requires approval: ${tool.name}`);
      }

      return {
        status: "approval_required",
        approval: await this.options.approvalGate.create({
          tool,
          input: parsedInput.data,
        }),
      };
    }

    try {
      const result = await withTimeout(
        tool.execute(this.ctx, parsedInput.data),
        this.options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        `Tool timed out: ${tool.name}`,
      );
      return {
        status: "executed",
        result: capToolResult(tool, result),
      };
    } catch (error) {
      return executedError(error instanceof Error ? error.message : "Tool execution failed.");
    }
  }
}

export function capToolResult(tool: Pick<ToolDefinition, "maxResultChars" | "name">, result: unknown) {
  const maxResultChars = tool.maxResultChars;
  if (!maxResultChars || maxResultChars <= 0) return result;

  const text = stringifyToolResult(result);
  if (text.length <= maxResultChars) return result;

  return {
    truncated: true,
    toolName: tool.name,
    maxResultChars,
    preview: text.slice(0, maxResultChars),
  };
}

function executedError(message: string): ToolExecutionOutcome {
  return {
    status: "executed",
    result: { error: message },
  };
}

function parseToolArguments(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return new Error("Invalid tool arguments JSON.");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stringifyToolResult(result: unknown) {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

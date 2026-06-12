export interface ToolCallGuardrailResult {
  signature: string;
  count: number;
  warning: boolean;
  blocked: boolean;
}

export class ToolRunGuardrails {
  private readonly callCounts = new Map<string, number>();

  constructor(
    private readonly maxRepeatedCalls = 2,
    private readonly warnRepeatedCalls = 2,
  ) {}

  recordCall(toolName: string, input: unknown): ToolCallGuardrailResult {
    const signature = toolCallSignature(toolName, input);
    const count = (this.callCounts.get(signature) ?? 0) + 1;
    this.callCounts.set(signature, count);

    return {
      signature,
      count,
      warning: count >= this.warnRepeatedCalls && count <= this.maxRepeatedCalls,
      blocked: count > this.maxRepeatedCalls,
    };
  }
}

export interface ToolRecoveryResult {
  key: string;
  count: number;
  warning?: string;
  hardStop?: string;
}

export class ToolLoopRecovery {
  private readonly failures = new Map<string, number>();
  private readonly noProgress = new Map<string, number>();

  constructor(
    private readonly warnAfter = 2,
    private readonly hardStopAfter = 3,
  ) {}

  recordFailure(toolName: string, input: unknown, error: string): ToolRecoveryResult {
    const key = `failure:${toolCallSignature(toolName, input)}:${error}`;
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    return this.toResult(key, count, `Tool ${toolName} is repeatedly failing with the same error.`);
  }

  recordNoProgress(toolName: string, input: unknown, result: unknown): ToolRecoveryResult {
    const key = `no_progress:${toolCallSignature(toolName, input)}:${stableJsonStringify(result)}`;
    const count = (this.noProgress.get(key) ?? 0) + 1;
    this.noProgress.set(key, count);
    return this.toResult(key, count, `Tool ${toolName} is returning the same result without progress.`);
  }

  private toResult(key: string, count: number, message: string): ToolRecoveryResult {
    if (count >= this.hardStopAfter) {
      return {
        key,
        count,
        hardStop: `${message} Stopping this tool loop.`,
      };
    }

    if (count >= this.warnAfter) {
      return {
        key,
        count,
        warning: `${message} Try a different approach before calling it again.`,
      };
    }

    return { key, count };
  }
}

export function toolCallSignature(toolName: string, input: unknown) {
  return `${toolName}:${stableJsonStringify(input)}`;
}

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(object[key])}`)
    .join(",")}}`;
}

export function parseToolCallArgumentsForSignature(rawArguments: string) {
  const trimmed = rawArguments.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

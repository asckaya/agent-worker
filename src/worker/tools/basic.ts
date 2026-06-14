import { z } from "zod";
import type { ToolDefinition } from "./registry";

const CurrentTimeInputSchema = z.object({
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("Optional IANA timezone, for example Asia/Shanghai or UTC."),
});

const CalculateInputSchema = z.object({
  expression: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "Arithmetic expression. Supports +, -, *, /, %, ^, parentheses, constants pi/e, and common functions like sqrt, abs, min, max, round, floor, ceil, sin, cos, tan, log, ln, log10.",
    ),
});

type CurrentTimeInput = z.infer<typeof CurrentTimeInputSchema>;
type CalculateInput = z.infer<typeof CalculateInputSchema>;

export const currentTimeTool: ToolDefinition<
  CurrentTimeInput,
  { iso: string; unixMs: number; timeZone: string; formatted: string }
> = {
  name: "current_time",
  description: "Get the current date and time, optionally formatted for a timezone.",
  inputSchema: CurrentTimeInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "basic",
  maxResultChars: 1_000,
  presentation: {
    label: "Current Time",
    icon: "clock",
  },
  async execute(_ctx, input) {
    const now = new Date();
    const timeZone = input.timeZone ?? "UTC";
    const formatted = formatDateTime(now, timeZone);
    return {
      iso: now.toISOString(),
      unixMs: now.getTime(),
      timeZone,
      formatted,
    };
  },
};

export const calculateTool: ToolDefinition<CalculateInput, { expression: string; result: number }> = {
  name: "calculate",
  description: "Evaluate a bounded arithmetic expression without executing code.",
  inputSchema: CalculateInputSchema,
  risk: "read",
  requiresApproval: false,
  toolset: "basic",
  maxResultChars: 1_000,
  presentation: {
    label: "Calculate",
    icon: "calculator",
  },
  async execute(_ctx, input) {
    const result = new MathExpressionParser(input.expression).parse();
    if (!Number.isFinite(result)) {
      throw new Error("Calculation result is not finite.");
    }
    return {
      expression: input.expression,
      result,
    };
  },
};

function formatDateTime(date: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(date);
  } catch {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
}

class MathExpressionParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse() {
    const value = this.parseAddSub();
    this.skipWhitespace();
    if (!this.isEnd()) {
      throw new Error(`Unexpected token at position ${this.index}.`);
    }
    return value;
  }

  private parseAddSub(): number {
    let value = this.parseMulDivMod();
    while (true) {
      this.skipWhitespace();
      if (this.consume("+")) {
        value += this.parseMulDivMod();
        continue;
      }
      if (this.consume("-")) {
        value -= this.parseMulDivMod();
        continue;
      }
      return value;
    }
  }

  private parseMulDivMod(): number {
    let value = this.parsePower();
    while (true) {
      this.skipWhitespace();
      if (this.consume("*")) {
        value *= this.parsePower();
        continue;
      }
      if (this.consume("/")) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error("Division by zero.");
        value /= divisor;
        continue;
      }
      if (this.consume("%")) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error("Modulo by zero.");
        value %= divisor;
        continue;
      }
      return value;
    }
  }

  private parsePower(): number {
    const left = this.parseUnary();
    this.skipWhitespace();
    if (!this.consume("^")) return left;
    return left ** this.parsePower();
  }

  private parseUnary(): number {
    this.skipWhitespace();
    if (this.consume("+")) return this.parseUnary();
    if (this.consume("-")) return -this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();
    if (this.consume("(")) {
      const value = this.parseAddSub();
      this.skipWhitespace();
      if (!this.consume(")")) throw new Error(`Expected ')' at position ${this.index}.`);
      return value;
    }

    const char = this.peek();
    if (char && /[0-9.]/.test(char)) {
      return this.parseNumber();
    }
    if (char && /[A-Za-z_]/.test(char)) {
      return this.parseIdentifierOrFunction();
    }

    throw new Error(`Expected number, constant, function, or '(' at position ${this.index}.`);
  }

  private parseIdentifierOrFunction() {
    const name = this.parseIdentifier().toLowerCase();
    this.skipWhitespace();
    if (!this.consume("(")) {
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      throw new Error(`Unknown constant: ${name}`);
    }

    const args: number[] = [];
    this.skipWhitespace();
    if (!this.consume(")")) {
      while (true) {
        args.push(this.parseAddSub());
        this.skipWhitespace();
        if (this.consume(")")) break;
        if (!this.consume(",")) throw new Error(`Expected ',' or ')' at position ${this.index}.`);
      }
    }
    return callMathFunction(name, args);
  }

  private parseIdentifier() {
    const start = this.index;
    while (!this.isEnd() && /[A-Za-z_]/.test(this.input[this.index])) {
      this.index += 1;
    }
    return this.input.slice(start, this.index);
  }

  private parseNumber() {
    const start = this.index;
    while (!this.isEnd() && /[0-9.]/.test(this.input[this.index])) {
      this.index += 1;
    }
    if (!this.isEnd() && /[eE]/.test(this.input[this.index])) {
      this.index += 1;
      if (!this.isEnd() && /[+-]/.test(this.input[this.index])) {
        this.index += 1;
      }
      while (!this.isEnd() && /[0-9]/.test(this.input[this.index])) {
        this.index += 1;
      }
    }
    const raw = this.input.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid number: ${raw}`);
    return value;
  }

  private skipWhitespace() {
    while (!this.isEnd() && /\s/.test(this.input[this.index])) {
      this.index += 1;
    }
  }

  private consume(value: string) {
    if (!this.input.startsWith(value, this.index)) return false;
    this.index += value.length;
    return true;
  }

  private peek() {
    return this.input[this.index];
  }

  private isEnd() {
    return this.index >= this.input.length;
  }
}

function callMathFunction(name: string, args: number[]) {
  const exactArity: Record<string, { arity: number; fn: (...args: number[]) => number }> = {
    abs: { arity: 1, fn: Math.abs },
    acos: { arity: 1, fn: Math.acos },
    asin: { arity: 1, fn: Math.asin },
    atan: { arity: 1, fn: Math.atan },
    ceil: { arity: 1, fn: Math.ceil },
    cos: { arity: 1, fn: Math.cos },
    exp: { arity: 1, fn: Math.exp },
    floor: { arity: 1, fn: Math.floor },
    ln: { arity: 1, fn: Math.log },
    log: { arity: 1, fn: Math.log },
    log10: { arity: 1, fn: Math.log10 },
    pow: { arity: 2, fn: Math.pow },
    round: { arity: 1, fn: Math.round },
    sin: { arity: 1, fn: Math.sin },
    sqrt: { arity: 1, fn: Math.sqrt },
    tan: { arity: 1, fn: Math.tan },
  };
  const variableArity: Record<string, (...args: number[]) => number> = {
    max: Math.max,
    min: Math.min,
  };
  const fixed = exactArity[name];
  if (fixed) {
    if (args.length !== fixed.arity) {
      throw new Error(`${name} expects ${fixed.arity} argument(s).`);
    }
    return fixed.fn(...args);
  }
  const variable = variableArity[name];
  if (variable) {
    if (args.length === 0) throw new Error(`${name} expects at least one argument.`);
    return variable(...args);
  }
  throw new Error(`Unknown function: ${name}`);
}

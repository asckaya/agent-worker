import { fetchUrlTool } from "./fetch-url";
import { saveMemoryTool, searchMemoryTool } from "./memory";
import { ToolRegistry } from "./registry";
import type { Env } from "../types";

export function createDefaultToolRegistry(env?: Env) {
  const registry = new ToolRegistry({ env });
  registry.register(fetchUrlTool);
  registry.register(saveMemoryTool);
  registry.register(searchMemoryTool);
  return registry;
}

import { arxivSearchTool } from "./arxiv";
import { calculateTool, currentTimeTool } from "./basic";
import {
  deleteMcpServerTool,
  deleteSkillTool,
  getMcpPromptTool,
  getMcpStatusTool,
  importSkillSourcesTool,
  listMcpPromptsTool,
  listMcpResourcesTool,
  readMcpResourceTool,
  refreshMcpToolsTool,
  reimportSkillSourcesTool,
  setSkillSourcesTool,
  skillTool,
  upsertMcpServerTool,
} from "./config";
import { fetchUrlTool } from "./fetch-url";
import {
  githubGetRepositoryTool,
  githubReadFileTool,
  githubSearchRepositoriesTool,
} from "./github";
import { httpRequestTool } from "./http-request";
import { saveMemoryTool, searchMemoryTool } from "./memory";
import { ToolRegistry } from "./registry";
import type { Env } from "../types";

export function createDefaultToolRegistry(env?: Env) {
  const registry = new ToolRegistry({ env });
  registry.register(currentTimeTool);
  registry.register(calculateTool);
  registry.register(arxivSearchTool);
  registry.register(githubSearchRepositoriesTool);
  registry.register(githubGetRepositoryTool);
  registry.register(githubReadFileTool);
  registry.register(fetchUrlTool);
  registry.register(httpRequestTool);
  registry.register(saveMemoryTool);
  registry.register(searchMemoryTool);
  registry.register(skillTool);
  registry.register(importSkillSourcesTool);
  registry.register(setSkillSourcesTool);
  registry.register(reimportSkillSourcesTool);
  registry.register(deleteSkillTool);
  registry.register(getMcpStatusTool);
  registry.register(refreshMcpToolsTool);
  registry.register(upsertMcpServerTool);
  registry.register(deleteMcpServerTool);
  registry.register(listMcpPromptsTool);
  registry.register(getMcpPromptTool);
  registry.register(listMcpResourcesTool);
  registry.register(readMcpResourceTool);
  return registry;
}

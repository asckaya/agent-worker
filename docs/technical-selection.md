# 技术选型

日期：2026-06-10

目标：基于 Cloudflare Worker 免费层优先实现一个非编码场景的个人 agent。第一入口是 Telegram，Web 只作为 status 页面；bash/code execution 作为可选能力。

## 总体决策

采用 **TypeScript + Cloudflare Workers + Durable Objects SQLite + Telegram + 服务端 OpenAI-compatible LLM 配置**。

第一版不使用 LangChain、Cloudflare Sandbox、Cloudflare Containers，也不直接绑定 Cloudflare Agents Think harness。先实现一个轻量可控的 agent loop，后续再评估是否接入 Cloudflare Agents SDK 的部分能力。

## 代码分层

当前实现借鉴 Hermes Agent 的 gateway/runtime 形态，但按 Worker 免费层收窄：

- `src/worker/model/*`：模型抽象。当前实现是 OpenAI-compatible adapter，内部使用 Vercel AI SDK。
- `src/worker/tools/*`：工具抽象。`registry` 描述 zod schema、risk、approval、toolset、availability 和输出上限；`executor` 负责解析模型 tool call、校验、timeout、approval gate 和结果裁剪；`guardrails` 负责重复调用控制。
- `src/worker/channels/*`：渠道抽象。当前实现 Telegram channel，包含 webhook、slash command、typed SSE 消费、capabilities/registry、text batching、typing refresh、private-chat draft streaming、MarkdownV2 retry/plain fallback、cursor、fresh-final cleanup 和 edit-message fallback/flood-control；同时有受保护的 HTTP test channel，用于不接 Telegram 时测试同一条 agent loop。
- `src/worker/memory/*`：memory provider 抽象。当前实现 Durable Object SQLite bounded curated memory。
- `src/worker/do/UserAgentObject.ts`：Durable Object actor。持有 bounded memory、当前 agent loop、短期 pending approval、内存 active-run/follow-up queue 和 paused approval continuation。
- `src/worker/integrations/*`：兼容层。旧路径只 re-export 新 channel adapter。

参考记录见：[hermes-agent-notes.md](./hermes-agent-notes.md)。

## 选型总览

| 模块 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript | Worker 原生生态最好，类型能约束工具 schema 和状态结构。 |
| 运行时 | Cloudflare Workers | 免费层可部署 API、静态前端、Webhook、SSE streaming。 |
| API 路由 | Hono | 轻量、Worker 友好、middleware 简洁；比手写路由更好维护。 |
| Agent 状态 | Durable Objects SQLite | 每个用户/agent 一个 actor，只持久化有用 memory 和后续任务状态；完整聊天历史不落库。 |
| 全局存储 | 暂不引入 D1，必要时第二阶段加入 | MVP 先减少 moving parts；多用户索引、审计报表再用 D1。 |
| 文件存储 | 暂不引入 R2 | 当前 MVP 无附件/导出；后续做文件、长工具结果、导出时再加 R2。 |
| LLM | OpenAI-compatible 服务端配置 | Telegram 没有浏览器本地 key store，使用 Worker secret/env 配置 base URL、API key、model。 |
| LLM 调用层 | Vercel AI SDK + `model` adapter | 使用 `ai` + `@ai-sdk/openai-compatible` 处理 streaming、tool call 解析和 provider 差异；工具执行和审批仍由 Worker 自己控制。 |
| LLM 观测 | AI Gateway 可选但推荐 | 免费核心能力：analytics、caching、rate limiting。 |
| Agent loop | 自研轻量 loop + 抽象层 | `model / tool / channel` 分层；控制 bundle、状态、审批和工具权限；避免早期框架锁定。 |
| Tool schema | zod + TypeScript registry/executor | zod 是工具输入 canonical schema；registry 转 JSON Schema 给模型，executor 执行前也用 zod 校验。 |
| 前端 | Vite + React status page | 构建静态 status 页面，由 Worker Static Assets 托管；不做 Web chat。 |
| Telegram | Bot webhook channel adapter | 使用 Telegram secret header + chat allowlist；支持 slash command、text batching、typing refresh、`sendMessageDraft` private-chat streaming、edit-message fallback、MarkdownV2 final fallback、inline approval。 |
| UI 样式 | 普通 CSS/CSS Modules 起步 | 避免引入重 UI 框架；后续再选组件库。 |
| 实时输出 | DO typed SSE + Telegram streaming adapter | DO `/chat` 输出 typed SSE；Telegram 默认 `auto`：private chat 优先 `sendMessageDraft`，失败或群聊再 fallback 到占位消息 + 节流 `editMessageText`；preview 带 cursor，final 尝试 MarkdownV2，parse 失败 fallback plain，旧 preview 可 fresh-final cleanup。 |
| 调度 | Durable Object alarms | 先做提醒/定时继续任务；复杂长任务再接 Workflows。 |
| 异步任务 | 暂不引入 Queues | 免费额度较小；MVP 用 DO alarms/Workflows。 |
| 检索记忆 | SQLite keyword search 起步，Vectorize 可选 | 先做轻量记忆；语义检索作为增强。 |
| 网页读取 | `fetch` + HTMLRewriter/文本抽取 | Browser Run 仅作为 JS 渲染页面的可选工具。 |
| bash/code execution | 不内置真实 shell | 免费层不适合；后续接用户自托管 runner 或 Cloudflare Paid Sandbox。 |
| 测试 | Vitest + Cloudflare Workers test pool | 覆盖 agent loop、tool registry、DO state、API。 |
| 部署 | Wrangler | Cloudflare 官方部署、类型生成、DO migrations。 |
| 包管理 | Bun | 用户偏好 Bun；单包项目安装和脚本执行更快，依赖版本保持 `latest` 起步。 |

## 为什么不先用 Cloudflare Agents Think

Cloudflare Agents/Think 很贴合目标，但第一版不直接采用：

- 它的内置 workspace/bash、extensions、session 能力更强，但也更容易把 MVP 带向编码 agent。
- 依赖和 bundle 体积需要实测，Workers Free bundle 限制更紧。
- 我们需要优先解决 Telegram、免费额度、工具审批、非编码渠道，而不是完整 workspace agent。
- 自研 loop 可以更容易做“极简模式”，后续仍可把 Durable Object actor 迁移到 Agents SDK。

保留评估点：

- 如果自研 loop 的会话恢复、工具调用和 streaming 复杂度上升，再引入 Agents SDK。
- Think 的 tools/session/skills 可以作为第二阶段参考或部分复用。

## 为什么不选 LangChain

- Worker bundle 和运行时兼容性风险更高。
- 抽象层较厚，不利于精确控制模型请求、tool call、审批和持久化。
- 当前需求更像个人 agent runtime，不是复杂 RAG chain 平台。

## LLM 接入决策

第一版只强制支持 OpenAI-compatible Chat Completions，由 Telegram channel 使用服务端 LLM 配置。

实现上使用 Vercel AI SDK：

- `@ai-sdk/openai-compatible` 连接 OpenAI-compatible endpoint。
- `ai` 的 `streamText` 负责 streaming 和 tool call 解析。
- 不使用 SDK 的自动工具执行；模型返回 tool call 后，仍由 Durable Object 根据 registry、risk、approval 策略执行。
- 这样可以减少手写 SSE/parser 维护成本，同时保留免费层和安全边界控制。

Telegram 使用 Worker secret/env 配置：

- `baseUrl`
- `apiKey`
- `model`
- `temperature`
- `maxTokens`
- optional headers

默认支持：

- OpenAI
- OpenRouter
- Groq
- DeepSeek
- Together/Fireworks 等兼容 OpenAI API 的服务
- AI Gateway unified/OpenAI-compatible endpoint

Anthropic/Gemini：

- 第一版可通过 OpenRouter 或 AI Gateway 使用。
- 原生 adapter 放到第二阶段，避免早期 provider 分支过多。

API key 存储策略：

1. Telegram：使用服务端 `LLM_*` secret/env，因为 Telegram channel 没有浏览器本地 key store。
2. Worker 不把 LLM API key 写入 Durable Object SQLite。
3. 后续如果开放多用户 BYOK，必须做明确 UI 提示和加密设计。

## Agent Runtime 设计

### Durable Object 粒度

采用 `UserAgentObject`：

- 一个用户的一个 agent 对应一个 Durable Object。
- Object 内保存 bounded memory；普通渠道消息不作为完整聊天历史落库。
- 个人使用时简单；多用户时天然隔离。

命名建议：

```text
agent:{tenantId}:{userId}:{agentId}
```

如果先做单用户自部署：

```text
agent:default
```

### 持久化边界

Durable Object SQLite 第一版只保存：

- `memories`：稳定偏好、长期事实、持续项目约束；数量和单条长度有硬上限。
- `pending_approvals`：短期工具审批状态，只保存工具名、工具输入、channel/chat id 和过期时间；approve/deny/过期后删除。

不保存：

- 完整用户消息历史。
- 完整 assistant 回复历史。
- 原始 prompt 或完整工具调用 transcript。
- 用户 LLM API key。

Web status page 不保存聊天消息或 LLM 配置。

后续如果引入附件或导出，再用 R2 保存：

- `attachments/{userId}/{fileId}`
- `artifacts/{userId}/{runId}/{name}`
- `exports/{userId}/{exportId}.json`

### Agent loop

第一版循环：

1. 接收用户消息。
2. 只把当前渠道消息作为当前请求上下文，不写入数据库。
3. 从 DO SQLite 检索少量相关 memory。
4. 组装上下文：system prompt、相关 memory、当前消息。
5. 调用 LLM。
6. 如果模型返回 tool call：
   - 查工具 registry。
   - 判断是否需要 approval。
   - 需要 approval 时创建或复用短期 pending approval，返回 `/approve <id>` / `/deny <id>` 指令并暂停本轮。
   - 用户批准后执行工具；如果 DO 内存里仍有 paused session，则把 tool result 注入原 model context 并继续 agent loop，审批前/恢复期间的 follow-up 继续用内存队列处理。
   - 如果 paused session 已丢失，则只基于工具输入和工具结果生成摘要，不恢复完整原始对话。
   - 不需要 approval 时直接执行工具。
   - 只把 tool result 放进当前请求上下文。
   - 继续下一 step。
7. 返回最终文本流。
8. 如果模型调用 `save_memory`，只保存有复用价值的 memory，并裁剪总量。

限制：

- 每轮最多 `N` 个 tool steps，默认 4。
- 同一轮重复 tool call 有 guardrail，超过阈值会返回合成 tool result 提醒模型换策略。
- 每个工具有 timeout。
- 工具可设置 `maxResultChars`，超大结果会被裁剪后再返回模型。
- 每轮请求有 token/context budget。
- 高风险工具默认 require approval。
- memory 默认最多 200 条，单条最多 1200 字符；旧记录按时间裁剪。

## Tool 系统

工具定义：

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  risk: "read" | "write" | "external" | "dangerous";
  requiresApproval: boolean;
  toolset?: string;
  requiresEnv?: string[];
  maxResultChars?: number;
  execute(ctx: ToolContext, input: ParsedInput): Promise<ToolResult>;
};
```

registry 用 `z.toJSONSchema(inputSchema)` 暴露工具参数给模型，只暴露当前可用工具；executor 执行前用同一个 zod schema 校验模型生成的 tool input，并统一处理 timeout/approval/result cap。

已实现工具：

- `fetch_url`：读取 URL；`risk=external`，需要 `/approve`。
- `save_memory`：保存长期记忆，第一版允许自动保存，但有硬上限且 UI 可删除。
- `search_memory`：检索记忆。

下一批工具：

- `extract_page_text`：抽取网页正文。
- `create_task`：创建待办。
- `schedule_reminder`：设置提醒，基于 DO alarm。
- `send_webhook`：调用用户配置的 webhook，需要确认。

暂不做：

- `bash`
- 任意 JS eval
- 任意文件系统 shell
- 自动支付/下单

## 前端选型

使用 Vite + React，静态构建后由 Worker Static Assets 提供。Web 只做 status page，不做 chat client。

首屏功能：

- Worker health。
- Telegram webhook path。
- 当前架构和数据边界状态。

不做 SSR：

- Worker Free CPU 只有 10ms/request，SSR 没必要。
- 静态 SPA + API 更符合免费层。

## 鉴权

MVP：

- 单用户部署模式。
- `ADMIN_TOKEN` Worker secret。
- 受保护 API 登录后设置 signed HTTP-only cookie。

为什么需要 `ADMIN_TOKEN`：

- Worker 默认是公网地址。
- 没有鉴权时，陌生人可以读写 memory、触发工具、消耗用户 LLM 额度。
- `ADMIN_TOKEN` 保护 `/api/agent/*` 管理/API 路由和 `/api/test-channel/*`，不用于公开 status page 或 Telegram webhook。受保护路由支持 signed cookie 和 `Authorization: Bearer`。

Telegram：

- `/api/tg/webhook` 使用 `TELEGRAM_SECRET_TOKEN` 校验 Telegram webhook header。
- 使用 `TELEGRAM_ALLOWED_CHAT_IDS` 限制允许使用 bot 的私聊、群组或频道。
- 可选 `TELEGRAM_ADMIN_USER_IDS` 限制 `/approve`、`/deny`、`/forget`、`/stop`、`/new`、`/reset` 只能由指定 Telegram user id 执行；未设置时保持 allowlist 内可用。
- 可选 `TELEGRAM_STREAM_TRANSPORT=auto|draft|edit|off` 控制 Telegram streaming，默认 `auto`。
- 可选 `TELEGRAM_TEXT_BATCH_MS` 控制普通文本短 debounce；默认 `180`，`0` 表示关闭。
- `/id` 命令返回当前 chat id，便于加入 allowlist。
- 普通消息走 DO typed `/chat` SSE，Telegram channel 在 private chat 优先 `sendMessageDraft`，群聊或失败时用 `editMessageText` 节流更新占位消息，并做 cursor、MarkdownV2 retry/plain fallback、fresh-final cleanup 和 flood-control backoff。
- Telegram 普通消息默认不保存完整历史；只使用当前消息和共享 bounded memory。
- 同一 chat active run 期间的新普通消息进入最多 3 条内存 follow-up queue，并 abort 当前模型 step 后用临时 in-run context 恢复；队列、paused approval continuation 和临时 history 不写 SQLite。

HTTP test channel：

- `/api/test-channel/*` 使用 `ADMIN_TOKEN` cookie 或 `Authorization: Bearer` 保护。
- `POST /api/test-channel/chat` 直接代理 DO `/chat`，source 固定为 `channel: "test"`，`chatId` 由请求指定，默认 `default`。
- 默认返回 SSE；`?format=json` 或 body `format: "json"` 会收集 typed stream events 并返回 `{ content, events, approval }`，便于脚本测试。
- 支持 `POST /api/test-channel/approvals/<id>/approve|deny`、`POST /api/test-channel/stop`、`GET /api/test-channel/approvals`、`GET /api/test-channel/state`。

当前 Telegram slash command：

- `/start` / `/help`：显示可用命令和数据边界。
- `/status`：显示 health、model、memory 和 pending approval 数量。
- `/memory`：列出已保存 memory。
- `/forget <memory_id>`：删除指定 memory。
- `/pending`：列出当前 chat 的 pending approval。
- `/approve <id>`：批准并执行 pending tool call。
- `/deny <id>`：拒绝 pending tool call。
- `/stop`：取消当前 chat active run。
- `/new` / `/reset`：停止当前 active run；由于不持久化完整历史，不需要清理 transcript。
- `/id`：显示当前 chat id。

后续：

- Cloudflare Access。
- OAuth。
- Passkey。

## 调度与后台任务

第一版：

- DO alarm 做 reminder 和 delayed continuation。

第二阶段：

- Workflows 做可恢复多步骤任务，例如批量抓网页、生成报告、定时摘要。

暂不引入 Queues，除非出现明确批处理吞吐需求。

## 文件和文档处理

第一版：

- 支持 `.txt`、`.md`、`.json`、`.csv`。
- 文件原文进 R2。
- 抽取文本摘要和 metadata 进 DO SQLite。

第二阶段：

- PDF、图片 OCR、音频转写交给用户配置的模型 API 或外部工具。
- 大文档切块 + Vectorize。

## 部署配置

首版 Cloudflare 资源：

- Worker
- Static Assets
- Durable Object class: `UserAgentObject`
- 可选 AI Gateway

暂不创建：

- D1
- KV
- Queue
- R2
- Container/Sandbox
- Browser Run binding

这些等功能需要时再加，避免用户一开始配置太多 Cloudflare 资源。

## 项目结构建议

```text
src/
  client/
    main.tsx        # status page only
    styles.css
  worker/
    index.ts
    channels/
      commands.ts
      registry.ts
      sse.ts
      telegram.ts
      types.ts
    auth/
      cookie.ts
    do/
      UserAgentObject.ts
    agent/
      context.ts
      prompts.ts
    integrations/
      telegram.ts    # compatibility re-export
    llm/
      openai-compatible.ts # compatibility re-export
    model/
      openai-compatible.ts
      types.ts
    memory/
      provider.ts
    tools/
      executor.ts
      registry.ts
      fetch-url.ts
      guardrails.ts
      memory.ts
    validation.ts
test/
  context.test.ts
  cookie.test.ts
  channels.test.ts
  memory-provider.test.ts
  openai-compatible.test.ts
  telegram.test.ts
  tools.test.ts
  validation.test.ts
docs/
  cloudflare-agent-research.md
  hermes-agent-notes.md
  technical-selection.md
wrangler.jsonc
package.json
vite.config.ts
tsconfig.json
```

## 阶段计划

### Phase 0: Skeleton（已实现）

- Worker + Hono。
- React static status page。
- Auth token for protected API routes。
- Durable Object route。
- Health check。

### Phase 1: Telegram MVP（已实现核心）

- Telegram webhook。
- Server-side OpenAI-compatible LLM env。
- AI SDK streaming/tool call parsing。
- Basic system prompt。
- `model / tool / channel` 抽象层。
- Telegram slash command。
- Telegram `sendMessageDraft` auto transport + edit-message fallback/flood-control + MarkdownV2 retry/plain fallback + fresh-final cleanup。
- Telegram text batching、typing refresh、interruptible active-run follow-up queue。
- HTTP test channel：无 Telegram 依赖的 protected SSE/JSON channel，用于测试 chat、approval 和 stop。
- Tool approval：inline buttons + `/approve <id>` / `/deny <id>`；内存 paused session 存在时 approval 后继续原 agent loop，approval continuation 也纳入 active-run `/stop`/follow-up 语义。
- Tool metadata/result cap/重复调用 guardrail；invalid tool name/JSON、重复失败、重复无进展结果有轻量 warning/hard-stop recovery。
- Memory provider 抽象。

### Phase 2: Personal Assistant（部分实现）

- Bounded memory。
- Tasks/reminders。
- URL reading（需要 approval）。
- AI Gateway metadata/logging。

### Phase 3: Channels（待实现）

- Slack webhook。
- Discord webhook。
- Email routing。

### Phase 4: Advanced Tools

- Vectorize semantic memory。
- Browser Run optional rendered-page tool。
- Workflows long tasks。
- MCP client。
- User-hosted runner / Cloudflare Paid Sandbox for bash.

## 最终决定

现在开始按这个栈实现：

- **TypeScript**
- **Cloudflare Workers**
- **Hono**
- **Durable Objects SQLite**
- **Vite + React status page**
- **OpenAI-compatible server env**
- **Telegram webhook**
- **Vercel AI SDK**
- **zod**
- **自研轻量 agent loop**
- **AI Gateway 可选接入**

明确不在 MVP 中使用：

- LangChain
- Cloudflare Containers/Sandbox
- 真实 bash/code execution
- SSR framework
- 多 provider 原生 SDK 全家桶
- D1/KV/Queues，除非实现中出现必要性

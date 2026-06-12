# Cloudflare Worker Agent 调研记录

调研日期：2026-06-10

目标：用 Cloudflare Worker/Cloudflare 免费层尽量实现一个类似 OpenClaw 的个人 agent，但更偏非编码场景；bash/code execution 能支持最好，但不是核心。

最终技术选型见：[technical-selection.md](./technical-selection.md)。

## 当前实现口径

2026-06-10 更新：实现阶段已经从最初的 Web chat 原型收窄为 **Telegram-first + Web status page**。

当前代码采用：

- Telegram bot webhook 作为主入口。
- Web 只提供 status page 和 `/api/health`，不提供 Web chat。
- Durable Objects SQLite 只持久化 bounded memory 和短期 pending approval，不保存完整聊天历史、assistant 回复或原始 prompt。
- LLM 由 Worker secret/env 配置，走 OpenAI-compatible endpoint。
- LLM 调用层使用 Vercel AI SDK：`ai` + `@ai-sdk/openai-compatible`。
- zod 是请求/env/tool input 的 canonical validation layer；工具 schema 由 zod 转 JSON Schema 给模型。
- `ADMIN_TOKEN` 只保护 `/api/agent/*` 管理/API 路由；Telegram 使用 webhook secret header + chat allowlist。
- 代码已经拆成 `model / tool / channel / memory` 分层；Telegram channel 支持 slash command、typed SSE、private-chat `sendMessageDraft` streaming、edit-message fallback 和 `/approve` 工具审批。
- Hermes Agent 参考记录见：[hermes-agent-notes.md](./hermes-agent-notes.md)。

下面的调研保留了更宽的探索范围，包括 Web chat、BYOK、多存储和多渠道能力。当前实现以 [technical-selection.md](./technical-selection.md) 为准。

## 结论

可行。推荐做成 **Cloudflare 原生 runtime + channel webhook + bounded memory** 的架构：

- Worker 负责入口、鉴权、工具编排、Webhook 接入和 status page。
- Durable Objects SQLite 负责 bounded memory 和后续轻量任务状态。
- Telegram webhook 作为第一入口，后续再加 Slack/Discord/Email。
- D1/R2/Vectorize/Queues 先不引入，等多用户、附件、检索或批处理需求明确后再加。
- AI Gateway 可选，用于模型请求观测、缓存、限流、fallback。
- LLM key 对 Telegram 场景放在 Worker secret/env 中，不写入 Durable Object SQLite。

免费层可以支撑一个个人/小规模 MVP。真正昂贵或不适合 Worker 的能力，例如完整 Linux shell、包管理、长时间浏览器自动化，应做成可选增强。

## OpenClaw 参考点

OpenClaw 的核心不是“编码 agent”，而是个人助手控制面：

- 多渠道入口：WhatsApp、Telegram、Slack、Discord、Signal、iMessage、Teams、WebChat 等。
- Local-first gateway：本地网关统一管理 session、channel、tool、event。
- Agent workspace + skills：通过工作区文件、技能说明、工具目录给模型扩展能力。
- 工具体系：browser、canvas、cron、session、渠道动作、sandbox 等。
- 安全重点：远程 DM 是不可信输入，默认 pairing/allowlist；高风险工具需要沙箱或审批。

我们的 Cloudflare 版本应借鉴这些概念，但不要照搬本地 daemon 模型。Cloudflare 更适合做 hosted gateway/agent runtime。

## Cloudflare 可用能力

### Workers

免费层：

- 100,000 requests/day。
- 10 ms CPU/request。
- 128 MB memory。
- 50 external subrequests/request。
- 100 Workers/account。
- Static Assets 可用于托管前端。

判断：

- 适合做 API、轻量 orchestration、streaming proxy。
- 不适合做重 CPU、本地 shell、大文件同步处理。
- 等待外部 LLM/API 的 wall time 不算 CPU，但代码本身要轻。

### Durable Objects

免费层可用，但只能用 SQLite-backed Durable Objects。

免费层关键额度/限制：

- 100,000 DO requests/day。
- 13,000 GB-s/day duration。
- SQLite 存储约 5 GB/account。
- 单个 SQLite-backed DO 存储限制：Free 约 1 GB，Paid 10 GB。
- 每个 DO 单线程，适合一个 user/session/agent 一个 actor。

判断：

- 很适合 agent session actor。
- 用 WebSocket hibernation 或短连接/SSE，避免空闲连接持续计费。
- 消息历史要做裁剪、摘要和归档，不要无限写 DO。

### D1

免费层：

- 5M rows read/day。
- 100k rows written/day。
- 5 GB storage。

判断：

- 适合用户表、agent 配置、工具授权、任务索引。
- 不适合直接存大量原始消息和文件。

### KV

免费层：

- 100k reads/day。
- 1k writes/day。
- 1 GB storage。

判断：

- 适合低频配置、公开元数据、缓存小对象。
- 不适合高频会话写入。

### R2

免费层：

- 10 GB-month storage。
- 1M Class A ops/month。
- 10M Class B ops/month。
- Egress free。

判断：

- 适合附件、长文档、导出、归档消息、工具结果。

### Queues

免费层：

- 10,000 operations/day。
- 消息保留 24h。
- 通常一条消息完整消费约 3 ops：write/read/delete。

判断：

- 可用于异步任务，但免费额度不大。
- MVP 可以先用 Durable Object alarms/Workflows，必要时再引入 Queues。

### Workflows

免费层可用，定价/额度与 Workers Free 共享：

- 100,000 requests/day。
- 10 ms CPU/invocation。
- 1 GB workflow storage。
- 空闲等待 API/sleep 不消耗 CPU。

判断：

- 适合多步骤、可恢复任务，例如“抓取网页 -> 总结 -> 发通知”。
- 对 agent 长任务比纯 `waitUntil` 更稳。

### Workers AI

免费层：

- 10,000 Neurons/day。
- 文本生成默认约 300 requests/min 的任务级限流。

判断：

- 可作为默认试用模型、小任务模型、embedding/分类/摘要兜底。
- 不应作为核心 LLM 依赖。用户自带 key 更合理。

### AI Gateway

核心功能当前免费：

- Analytics。
- Caching。
- Rate limiting。
- BYOK provider routing。

免费层限制：

- 10 gateways/account。
- 100,000 persistent logs/account。
- 单条 log 最大 10 MB。

判断：

- 强烈建议把用户自带 LLM key 的调用统一走 AI Gateway。
- 可以按 user/session 写 custom metadata，方便排查成本和质量。
- 日志要默认脱敏，给用户关闭/清理选项。

### Vectorize

免费层：

- 30M queried vector dimensions/month。
- 5M stored vector dimensions。

判断：

- 可做轻量个人知识库和长期记忆。
- 如果要极致免费，也可以先用 D1 FTS + 摘要记忆，Vectorize 做可选。

### Browser Run

免费层：

- 10 minutes/day browser hours。
- Browser Sessions 并发 3。
- 新 browser instance：1 every 20s。
- Quick Actions：1 request every 10s。
- Browser timeout 默认 60s。

判断：

- 可以作为可选“看网页/截图/网页转 markdown”工具。
- 免费额度很小，不能依赖它做大量网页自动化。
- 普通网页读取优先用 `fetch + HTMLRewriter/readability`，只有 JS 渲染页面再用 Browser Run。

### Sandbox / Containers

Sandbox 基于 Cloudflare Containers。

免费层：

- Containers Free: N/A。

判断：

- 不能作为免费 MVP 的核心。
- bash/code execution 应做成可选：
  - Cloudflare Paid Sandbox。
  - 用户自托管 runner。
  - 外部 MCP/code runner。
  - 或只提供受限虚拟 workspace 工具，不执行真实 shell。

## LLM BYOK 设计

建议支持三种模式：

1. 临时 API key，不存储
   - 用户每次或每个浏览器会话输入。
   - Worker 只在请求期间使用。
   - 最安全，最适合 MVP。

2. 浏览器本地保存
   - key 存在 localStorage/IndexedDB。
   - Worker 不落库。
   - 适合个人工具，但换设备要重填。

3. 服务端加密保存
   - 支持后台任务、定时任务、渠道自动回复。
   - 只存密文。
   - 最好用用户 passphrase 派生密钥加密，避免服务端直接可解密。
   - 如果用 Worker secret 统一加密，本质上服务端仍可解密，安全责任更高。

模型提供商：

- OpenAI compatible endpoint。
- Anthropic。
- Gemini。
- OpenRouter。
- Workers AI 作为无 key 试用/兜底。

## 当前 MVP 范围

第一阶段只做非编码个人 agent：

- Web status page，Worker Static Assets 托管。
- Telegram bot webhook。
- Protected HTTP test channel，用于不接真实 Telegram 时测试同一条 agent loop。
- 服务端 OpenAI-compatible LLM 配置。
- 每个部署/agent 一个 Durable Object。
- 不保存完整消息历史；只保存 bounded memory 和短期 pending approval。
- `model / tool / channel / memory` 分层。
- Telegram slash command、typing refresh、短文本 batching、长消息分页、`sendMessageDraft` private-chat streaming、edit-message fallback/flood-control、MarkdownV2 retry/plain fallback、fresh-final cleanup。
- Active run、approval continuation run、paused approval session 和 follow-up queue 只放 Durable Object 进程内存，不写完整聊天历史。
- `/approve <id>` / `/deny <id>` 工具审批；pending approval 只保存工具名、工具输入、channel/chat id 和过期时间。
- 工具注册表：
  - `fetch_url`，需要 approval。
  - `save_memory`
  - `search_memory`
- AI SDK 处理 OpenAI-compatible streaming/tool call 解析。
- zod 校验 HTTP payload、Telegram update、LLM env 和 tool input。

第二阶段增加渠道：

- Slack app。
- Discord interaction/webhook。
- Email routing。

第三阶段增加高级工具：

- Browser Run 可选。
- Vectorize 可选。
- Workflows 长任务。
- MCP client。
- 用户自托管 runner 或 Cloudflare Paid Sandbox 做 bash/code execution。

## 安全原则

- 默认把所有用户消息、Webhook、DM 当作不可信输入。
- channel inbound 要有 allowlist/pairing。
- 高风险工具必须 approval：
  - 发消息/邮件。
  - 调外部写 API。
  - 修改长期记忆时如果未来放宽为任意写入，应重新评估是否需要 approval；当前 `save_memory` 只保存 bounded memory，允许自动执行。
  - 花钱/下单/支付。
  - 访问用户私有数据。
- API key 默认不落库；如果落库必须加密，并明确告知。
- 工具权限按 agent/session 作用域隔离。
- 记录工具调用审计日志，但避免保存完整敏感 prompt。

## 关键取舍

- 不追求本地 OS 控制能力，先做 hosted personal assistant。
- 不把 bash 作为核心能力，因为免费 Cloudflare 不适合跑真实 shell。
- Telegram 当前使用服务端 LLM secret/env，避免 Web 本地 key store 复杂度。
- 优先 Durable Objects 做 bounded memory actor，D1/R2 做后续外围持久化。
- Browser Run、Vectorize、Workflows 都可以免费试用，但都应设计成可关闭/可替换。

## 需要进一步确认

- Cloudflare Agents SDK/Think 是否能在 Workers Free 下完整部署，尤其 bundle size、依赖和 Durable Object 迁移。
- AI Gateway BYOK 是否满足用户侧 key 临时透传的最佳实践，还是更适合用户在 Gateway 里配置 provider key。
- 后续渠道优先级：Slack、Discord、Email。
- 是否要多租户。如果只是个人自部署，鉴权和 key 管理可以简化很多。
- 是否需要附件、导出和语义记忆；需要时再引入 R2/Vectorize。

## 推荐下一步

当前原型已跑通。推荐下一步：

1. 增加 tasks/reminders：优先用 Durable Object alarms。
2. 加 AI Gateway 可选开关和 metadata。
3. 增加 Slack/Discord/Email channel adapter。
4. 评估是否需要 R2 附件和 Vectorize 语义记忆。
5. 评估是否需要用户自托管 runner 或 Cloudflare Paid Sandbox 做 bash/code execution。

跑通后再决定是否引入 Cloudflare Agents SDK/Think，或者保持自研轻量 agent loop。

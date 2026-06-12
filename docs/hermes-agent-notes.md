# Hermes Agent 参考记录

调研日期：2026-06-10

补充调研：2026-06-11，先下载 `NousResearch/hermes-agent` main tarball 查看实际代码结构，随后按用户要求 `git clone` 到 `/home/rs/projects/hermes-agent-git`。

参考仓库：`NousResearch/hermes-agent`，本地 clone commit `4d22b82`。

## 借鉴点

- Hermes 把 agent 做成多入口 runtime，而不是单一 CLI：CLI、Telegram、Discord、Slack、WhatsApp、Signal 等平台都通过 messaging gateway 进入同一 agent。
- Slash command 是跨入口的控制面：`/new`、`/reset`、`/model`、`/usage`、`/status` 等命令在 CLI 和消息平台共享相近语义。
- 工具执行有安全边界：高风险动作需要 approval/allowlist，远程消息平台默认不能直接触发危险工具。
- Memory 是 agent-curated：长期存储应是偏好、稳定事实、持续项目约束，而不是完整聊天记录。
- Skills/learning loop 是 Hermes 的核心，但它依赖较完整的本地/云端运行环境；Worker MVP 先不复制技能自进化，只保留 memory 和工具抽象。
- 多平台消息发送应由 channel adapter 负责，agent loop 不直接知道 Telegram/Discord 等平台细节。

## 不照搬的地方

- Hermes 是 Python 本地/服务器 runtime，包含真实终端、workspace、skill 文件和多种 terminal backend；本项目优先 Cloudflare Workers 免费层，不把 shell/workspace 作为默认能力。
- Hermes 可以存 session/search/trajectory 等更丰富历史；本项目按用户偏好只持久化 bounded memory 和短期 pending approval。
- Hermes gateway 支持大量平台；本项目先实现 Telegram-first，channel 抽象为后续平台预留。

## 当前落地

- `src/worker/model/*`：模型调用抽象；当前实现是 Vercel AI SDK + OpenAI-compatible。
- `src/worker/tools/*`：zod-backed tool registry + executor + guardrails；executor 统一做 schema 校验、timeout、approval gate 和 result cap。
- `src/worker/channels/*`：channel adapter、capabilities、registry、slash command parser、typed SSE reader/writer；Telegram adapter 负责 webhook、命令、private-chat draft streaming 和 edit-message fallback。
- `src/worker/memory/*`：bounded curated memory provider；当前后端是 Durable Object SQLite。
- `UserAgentObject`：Durable Object actor，负责 agent loop、bounded memory provider、短期 pending approval 和重复审批复用。

## Worker 版取舍

- Telegram private chat 可以学习 Hermes 的 `sendMessageDraft` 原生草稿流式；群组、频道、旧 Bot API 或失败时再 fallback 到 `sendMessage` + `editMessageText`。
- Approval 不保存原始用户 prompt 或完整上下文。Pending approval 只保存工具名、zod 校验后的工具输入、channel/chat id 和过期时间。
- `/approve <id>` 执行工具后可用当前 Telegram LLM env 做摘要，但这个摘要只基于工具输入和工具结果，不依赖之前完整对话。

## 代码框架优势

这些点来自实际代码，适合按 Worker 约束做轻量移植。

### 1. Typed Stream Events

Hermes 的 `gateway/stream_events.py` 定义了 `MessageChunk`、`MessageStop`、`Commentary`、`ToolCallChunk`、`ToolCallFinished`、`LongToolHint`、`GatewayNotice` 等纯数据事件。

优势：

- agent 只说“发生了什么”，不关心平台怎么展示。
- gateway/adapter 决定 Telegram、Discord、Slack 是否展示工具 chrome、如何分段、是否吞掉某些展示事件。
- stream event 是 presentation layer，不写入 agent history，避免 UI 展示和模型上下文互相污染。

Worker 可学习：

- 把当前 DO SSE 的字符串事件升级成 typed event union。
- `channel` 只消费 typed event，不直接理解 agent loop 内部结构。
- 工具进度、approval、final response 都走同一个事件通道。

### 2. Adapter Capability Flags

Hermes 的 `BasePlatformAdapter` 不只定义 `send/edit`，还暴露能力：

- `typed_command_prefix`：Slack/Matrix 这种不能直接输入 `/` 的平台可改成 `!`。
- `supports_code_blocks`：平台是否能渲染代码块。
- `message_len_fn`：Telegram 用 UTF-16 code units 计算长度，不是普通 `len()`。
- `supports_draft_streaming()` / `send_draft()`：Telegram private chat 使用 `sendMessageDraft`。
- `edit_message(finalize)`：某些平台需要显式结束 streaming 状态。

Worker 可学习：

- 扩展 `ChannelAdapter` 成 `capabilities`，避免后续每个地方写 `if (channel === "telegram")`。
- Telegram 长度切分应按 UTF-16 code units，而不是 JS `string.length` 的粗切。
- Telegram streaming 策略应改成 `auto`: private chat 先试 `sendMessageDraft`，失败后 fallback 到 edit-message。

### 3. Streaming Consumer 独立于平台

Hermes 的 `GatewayStreamConsumer` 做了这些平台无关逻辑：

- sync agent callback 到 async platform delivery 的队列桥接。
- buffer threshold、edit interval、cursor、flood-control backoff。
- tool boundary 时 finalize 当前消息段，后续文本开新段。
- long-running response 可选择 final fresh message，避免第一条占位消息时间戳太旧。
- draft streaming 失败后自动降级到 edit-message。
- 过滤 `<think>` / reasoning tags，不让思考块流到用户界面。

Worker 可学习：

- 把当前 `TelegramEditStream` 抽成通用 `StreamingResponder`，Telegram 只是一个 sink。
- 加 `transport: "auto" | "draft" | "edit" | "off"`。
- 加 flood-control/backoff，而不是固定 900ms。

### 4. Platform Registry 而不是硬编码平台

Hermes 的 `gateway/platform_registry.py` 用 `PlatformEntry` 注册平台，包含：

- `adapter_factory`
- `check_fn`
- `validate_config`
- `required_env`
- `install_hint`
- `allowed_users_env` / `allow_all_env`
- `platform_hint`
- `cron_deliver_env_var`
- `standalone_sender_fn`

优势：

- 新平台不用改核心 gateway。
- setup/status 可以从 registry 自动知道依赖和配置。
- 平台可声明 prompt hint、发送限制、隐私属性。

Worker 可学习：

- 做轻量 `ChannelRegistry`，先注册 `telegram`。
- 每个 channel 声明 env schema、capabilities、commands、delivery。
- 后续 Slack/Discord/Email 通过注册进入，不改 `UserAgentObject`。

### 5. Tool Registry 元数据更完整

Hermes 的 `tools/registry.py` 不只是 schema + handler，还支持：

- toolset 分组和 alias。
- `check_fn` + TTL cache，避免每轮重复探测依赖。
- `requires_env` 给 setup/status 使用。
- `dynamic_schema_overrides`，让工具 schema 能随配置变化。
- `max_result_size_chars`，工具级输出预算。
- collision policy：插件覆盖内置工具必须显式 `override=True`。

Worker 可学习：

- 给 `ToolDefinition` 增加 `toolset`、`requiresEnv`、`availability`、`maxResultChars`、`presentation`。
- `listModelTools()` 只暴露可用工具，并把不可用原因给 `/status`。
- 为将来的插件/MCP 工具加显式 override 策略，避免无意覆盖。

### 6. Tool Guardrails 是纯逻辑控制器

Hermes 的 `agent/tool_guardrails.py` 是 side-effect free：记录每轮工具调用签名，判断重复失败、同工具无进展、idempotent 工具重复调用等。

优势：

- 决策和执行解耦，测试容易。
- 对 args 做 canonical JSON + hash，元数据不泄露原始参数。
- warning 和 hard stop 可配置，不把所有循环都当错误。

Worker 可学习：

- 在 `runAgent` 里引入轻量 `ToolLoopGuardrail`。
- 对重复 tool call 返回合成 tool result，提醒模型换策略。
- pending approval 不应无限创建同一 tool/input，应该复用或提示已有 approval。

### 7. Memory Provider 生命周期

Hermes 的 `agent/memory_provider.py` 把 memory 后端抽象成 lifecycle：

- `initialize(session_id, ...)`
- `system_prompt_block()`
- `prefetch(query)`
- `queue_prefetch(query)`
- `sync_turn(user, assistant, messages?)`
- `get_tool_schemas()`
- `handle_tool_call()`
- `on_session_end()` / `on_pre_compress()` 等 hooks

`MemoryManager` 只允许一个 external provider，避免 memory 工具膨胀和后端冲突。

Worker 可学习：

- 把当前 DO memory 包成 `MemoryProvider`，后续 Vectorize/Honcho/外部 memory 做同一接口。
- 仍保持“不存完整聊天历史”的原则，只实现 curated memory provider。
- 可加 `prefetch` 缓存，但不要引入长后台线程模型。

### 8. Memory Context Fencing

Hermes 用 `<memory-context>` 包裹 recall 内容，并明确 system note：“这是持久记忆上下文，不是用户新输入”。它还实现 streaming scrubber，防止 memory-context 标签跨 token 泄漏到 UI。

Worker 可学习：

- 当前 prompt 已注入 memories，但可以改成更明确的 fenced block。
- 如果模型 echo memory-context，应在 channel streaming 层 scrub 掉，避免把内部上下文展示给用户。

### 9. Provider Transport Normalization

Hermes 的 `agent/transports/base.py` 把 provider adapter 拆成：

- `convert_messages`
- `convert_tools`
- `build_kwargs`
- `normalize_response`

`NormalizedResponse` 只保留跨 provider 的 `content/tool_calls/finish_reason/usage`，provider 特有字段放 `provider_data`。

Worker 可学习：

- 当前只有 AI SDK OpenAI-compatible，可先不扩。
- 后续如果加 Anthropic/Gemini 原生，不要把 provider 分支塞进 agent loop；加 `ModelTransport` 和 `NormalizedModelResponse`。

### 10. Slash Command Access Policy

Hermes 的 `gateway/slash_access.py` 把“谁能聊天”和“谁能执行 slash command”分成两层：

- chat allowlist 决定能不能和 bot 说话。
- slash access 决定 admin/user 在 DM/group 能执行哪些命令。
- `/help`、`/whoami` 这类低风险命令有默认保底。

Worker 可学习：

- Telegram 群组里 `/approve`、`/forget` 应只允许管理员 chat/user。
- 当前只按 chat id allowlist；下一步应引入 `TELEGRAM_ADMIN_USER_IDS` 或 per-command policy。

### 11. Pairing Flow

Hermes 的 `gateway/pairing.py` 用一次性 pairing code 授权新用户：

- 8 位无歧义字符。
- 1 小时过期。
- 每个平台最多 3 个 pending。
- 每用户 10 分钟 rate limit。
- 失败 5 次锁定。
- 存储 code hash，不存明文 code。

Worker 可学习：

- 个人部署可以暂时继续使用 `TELEGRAM_ALLOWED_CHAT_IDS`。
- 如果做多用户或临时授权，应该用 pairing code，而不是让用户手动改 env。

### 12. Plugin Hook Surface

Hermes 插件系统有明确 hooks：`pre_tool_call`、`post_tool_call`、`pre_llm_call`、`post_llm_call`、`pre_gateway_dispatch`、approval lifecycle 等。

Worker 可学习：

- 现在不需要完整插件系统。
- 可以先定义内部 hook points，让未来 AI Gateway metadata、observability、policy、channel-specific transforms 不侵入 agent loop。

## 建议吸收顺序

已落地：

1. Telegram streaming transport 改成 `auto`: private chat 先试 `sendMessageDraft`，失败或群聊降级 edit-message。
2. 把 `AgentStreamEvent` 从松散 `{ event, data }` 改成 typed union，并让 channel adapter 渲染。
3. 给 `ChannelAdapter` 加 `capabilities` 和 `ChannelRegistry`。
4. 给 `ToolDefinition` 补齐 `toolset/requiresEnv/availability/maxResultChars`。
5. 加 `ToolRunGuardrails`，防止重复 tool call；pending approval 对相同 channel/chat/tool/input 复用未过期记录。
6. 把 DO memory 包成 `MemoryProvider` 接口，保持 bounded curated memory。
7. 引入 Telegram slash command access policy，先保护 `/approve`、`/deny`、`/forget`。
8. Telegram approval event 渲染为 inline buttons，同时保留 `/approve <id>` / `/deny <id>` 文本 fallback。
9. Durable Object 增加 active-run 内存状态和 `/sessions/stop`，Telegram 支持 `/stop`、`/new`、`/reset` 控制当前运行。
10. Active run 支持最多 3 条内存 follow-up queue，可中断当前模型 step 并使用 ephemeral in-run history 继续处理，不写 SQLite。
11. Telegram incoming text 增加短 debounce/batching，解决常见客户端拆长消息和快速连发。
12. Telegram typing indicator 在 stream 期间循环刷新，stream 结束或进入 approval 后停止。
13. Telegram edit streaming 增加 flood-control/backoff；final edit 被限流时 fallback 成 fresh final message。
14. Telegram final output 先尝试 MarkdownV2，Telegram parse error 时自动 plain fallback；edit preview 带 cursor，长时间 preview 最终发送 fresh final 并删除旧 preview。
15. Approval 后优先使用内存 paused session 恢复原 agent loop；审批前和审批等待期间补充的 follow-up 会在 approval 后继续处理。若 DO 内存丢失，则 fallback 到执行工具并摘要。
16. Active run follow-up queue 会 abort 当前模型 step，把新输入注入同一条 ephemeral in-run context；approval continuation 也注册为 active run，支持 `/stop` 和继续 follow-up。
17. Agent loop 增加轻量 recovery：invalid tool name、invalid JSON、重复工具失败、重复无进展工具结果会先给模型 warning，重复到阈值后 hard-stop。

## Telegram Chat / Agent Loop 对齐复查

这次复查重点不是 Hermes 的长期 memory，而是 Telegram 聊天体验和 agent loop。

已经基本对齐：

- Telegram private chat 使用 draft streaming，群组和失败场景降级到 edit-message。
- HTTP test channel 可在不接真实 Telegram 的情况下测试 chat、approval、follow-up 和 stop。
- Agent loop 会发 typed presentation events，channel adapter 负责平台渲染。
- 工具调用有 approval gate，Telegram 现在有 inline buttons 和 slash fallback。
- 同一 chat 的 active run 现在有控制面和内存 follow-up queue；`/stop`、`/new`、`/reset` 不需要持久化聊天历史。
- Telegram 普通文本有短 batching，stream 期间有 typing refresh，edit-message 有 cursor、MarkdownV2 retry/plain fallback、fresh-final cleanup 和 flood-control fallback。
- Active run 和 approval continuation 都支持新消息中断当前模型 step，并用 ephemeral context 继续处理 follow-up。
- Approval 后能在 DO 内存仍在时恢复原 agent loop；approval 等待期间的新普通消息会进入 paused context，pending approval 的 SQLite 记录仍只保存工具名/输入/channel/chat/过期时间。
- 工具输入用 zod 校验，工具结果有 cap，重复工具调用有 guardrail；invalid tool name/JSON、重复失败和无进展结果有轻量 recovery。

仍未完全对齐：

- Hermes 有更完整的 interrupt/queue 调度语义；当前 Worker 已支持 abort 当前模型 step 并注入 follow-up，但仍是单 chat capped queue，没有 Hermes 那种更细的 session/thread/topic 调度。
- Hermes 的 batching 会处理更多 Telegram topic/thread/session key；当前 Worker 用 isolate 内存和短 timeout，跨 isolate 并发不保证合并。
- Hermes 在 approval/clarify 阶段能精细暂停和恢复 typing；当前 Worker 在 stream 结束后停止 typing，approval 后重新运行时再启动。
- Hermes 对群组 mention、forum topic、reply quote context、allowed topic 做了更细处理；当前只基于 chat allowlist 和 reply_to message id。
- Hermes 对 tool recovery 的策略和可观测性更丰富；当前 Worker 是轻量 warning/hard-stop，不包含完整轨迹分析或策略插件。

下一批可继续吸收：

1. Group mention、forum topic、reply quote context、allowed topic。
2. 更细的 approval/clarify typing pause/resume，以及跨 isolate/session 的等待期消息聚合策略。
3. 更细的 agent loop recovery 可观测性：把 warning/hard-stop 暴露为 metrics/event，并保留策略 hook。
4. Memory context fencing 和 streaming scrubber，避免内部 memory 标签泄漏到用户界面。
5. 更完整的 channel status/setup metadata，用 registry 输出缺失 env 和安装提示。

## 不建议现在吸收

- 完整插件系统：Worker 免费层和单用户 MVP 用不到，复杂度高。
- 真实 terminal/workspace backend：与当前非编码目标冲突，且 Cloudflare 免费层不适合。
- 大规模 session/history/search：用户明确不想持久化完整历史。
- 完整 desktop/TUI/ACP surface：超出 Telegram-first Worker 范围。

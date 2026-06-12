# AGENTS.md

Guidance for coding agents working in this repository.

## Project Direction

- This is a Cloudflare Worker personal agent focused on non-coding workflows.
- The primary user channel is Telegram.
- A protected HTTP `test` channel exists for manual/local testing without Telegram. It should stay API-only and must not become a Web chat UI unless explicitly requested.
- The web surface is a status page only. Do not add a Web chat client unless explicitly requested.
- Durable Objects SQLite must store only bounded memory and short-lived approvals. Active run state, approval continuation runs, paused approval sessions, and queued follow-up messages may live in Durable Object memory, but should not be persisted as chat history.
- Do not persist full chat history, assistant replies, raw prompts, raw tool transcripts, or LLM API keys in Durable Objects.
- Short-lived pending tool approvals are allowed, but only store tool name, validated tool input, channel/chat id, and expiry.

## Stack

- Package manager: Bun.
- Keep dependency ranges at `latest` unless there is a concrete compatibility reason.
- Runtime/API: Cloudflare Workers + Hono.
- State: SQLite-backed Durable Object `UserAgentObject`.
- Static assets: Vite + React status page.
- LLM layer: Vercel AI SDK with `ai` and `@ai-sdk/openai-compatible`.
- Validation: zod.
- Tests: Vitest.
- Deploy/build tooling: Wrangler.

## Architecture Rules

- Use `zod` as the canonical validation layer for request payloads, env-derived config, Telegram update shapes, and tool input.
- Tool definitions should use zod schemas. Convert them to JSON Schema for model-facing tool descriptions with `z.toJSONSchema`.
- Keep tool execution under our own registry/DO control. Do not let the AI SDK automatically execute tools unless the approval/risk boundary is redesigned first.
- Keep the runtime split by responsibility:
  - `model`: provider adapters and streaming model interface.
  - `tools`: zod-backed registry plus executor/approval gate, metadata, result caps, and guardrails.
  - `channels`: platform adapters, capabilities, registry, slash commands, and delivery/streaming behavior.
  - `memory`: provider abstraction for bounded curated memory.
- Keep Telegram webhook protection separate from admin/API auth:
  - Telegram: `TELEGRAM_SECRET_TOKEN` header check plus `TELEGRAM_ALLOWED_CHAT_IDS`.
  - Admin/API: `ADMIN_TOKEN` signed cookie or bearer token for `/api/agent/*` and `/api/test-channel/*`.
- `ADMIN_TOKEN` is not required for the public status page or `/api/health`.
- For Telegram, LLM credentials come from Worker secrets/env vars: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, optional temperature/max tokens.
- Telegram streaming uses `TELEGRAM_STREAM_TRANSPORT=auto` by default: private chats try Bot API `sendMessageDraft`, groups and failures use `sendMessage` + throttled `editMessageText`.
- Telegram edit streaming should keep cursor rendering, stale-preview cleanup, MarkdownV2 retry/plain fallback, and flood-control/backoff inside the channel adapter.
- Telegram incoming ordinary text can be short-debounced with `TELEGRAM_TEXT_BATCH_MS`; slash commands and callback queries must bypass batching.
- Telegram approval UX should prefer inline callback buttons while preserving typed `/approve <id>` and `/deny <id>` fallbacks.
- If `TELEGRAM_ADMIN_USER_IDS` is configured, mutating slash commands (`/approve`, `/deny`, `/forget`, `/stop`, `/new`, `/reset`) and equivalent callback actions must be restricted to those Telegram user ids.
- Slash commands should be parsed in `src/worker/channels/commands.ts`, not inside the agent loop.

## Data Limits

- Memory cap is currently 200 items.
- Single memory item cap is currently 1200 characters.
- Pending approvals currently expire after 15 minutes and are capped at 50 rows.
- Active Telegram runs, approval continuation runs, paused approval sessions, and queued follow-ups are process-memory control state only. Do not add persisted transcript/session tables to implement `/stop`, `/new`, `/reset`, approval continuation, or follow-up queueing.
- The active-run follow-up queue interrupts the current model step and resumes with ephemeral in-run model context. Paused approval continuation can collect supplemental user messages while waiting for `/approve` or `/deny`. Neither path may write user messages, assistant replies, raw tool transcript, or LLM keys to SQLite.
- Each agent turn has a max tool step limit.
- High-risk tools should require approval before execution.
- Duplicate pending approvals for the same channel/chat/tool/input should be reused while unexpired.
- Tool results should respect tool-level `maxResultChars` before being returned to the model.

## Commands

```bash
bun install
bun run typecheck
bun run test
bun run build
bun run dev
```

`bun run build` performs a Wrangler dry-run build. `bun run dev` starts Wrangler dev and may need elevated permissions in restricted sandboxes because Wrangler reads local network interfaces.

## Files To Know

- `src/worker/index.ts`: top-level routes.
- `src/worker/channels/telegram.ts`: Telegram webhook, slash commands, draft/edit streaming, and command access policy.
- `src/worker/channels/commands.ts`: shared slash-command parser.
- `src/worker/channels/registry.ts`: channel registration and capability listing.
- `src/worker/channels/sse.ts`: typed server-side SSE reader/writer for channel adapters.
- `src/worker/do/UserAgentObject.ts`: agent loop, memory persistence, pending approvals.
- `src/worker/memory/provider.ts`: bounded memory provider interface and Durable Object SQLite implementation.
- `src/worker/model/openai-compatible.ts`: AI SDK OpenAI-compatible adapter.
- `src/worker/llm/openai-compatible.ts`: compatibility re-export for the model adapter.
- `src/worker/tools/registry.ts`: zod-backed tool registry.
- `src/worker/tools/executor.ts`: tool call parsing, zod validation, timeout, approval gate.
- `src/worker/tools/guardrails.ts`: pure tool-call repeat guardrails and stable input signatures.
- `src/worker/validation.ts`: request/env/update schemas.
- `src/client/main.tsx`: public status page.
- `docs/technical-selection.md`: current architecture decisions.
- `docs/cloudflare-agent-research.md`: research notes plus current implementation scope.
- `docs/hermes-agent-notes.md`: Hermes Agent framework notes and Worker-specific tradeoffs.

## Avoid

- Do not introduce LangChain for the MVP.
- Do not add Cloudflare Containers/Sandbox or real shell execution as a default feature.
- Do not introduce D1/KV/R2/Queues unless the feature requires them.
- Do not add Web chat, browser-local LLM key storage, or session/message persistence without explicit direction.
- Do not store secrets in Durable Object SQLite.

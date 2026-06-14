# Agent Worker

Cloudflare Worker personal agent focused on non-coding workflows. The MVP uses Cloudflare Workers, Durable Objects SQLite, Hono, React status page, Vercel AI SDK, zod, and server-side OpenAI-compatible LLM credentials for Telegram.

The runtime is split into `model / tool / channel` layers. Telegram is the first real channel and supports slash commands, private-chat draft streaming with edit-message fallback, typing refresh, short text batching, interruptible active-run follow-up queueing, MarkdownV2 final-message fallback, and `/approve` tool approval with inline buttons. A protected HTTP test channel is also available for local/manual testing without Telegram.

## Data Boundary

- The web surface is status-only, not a chat client.
- Telegram messages are used for the current turn and are not stored as conversation history.
- Durable Object SQLite stores only bounded `memories` and short-lived pending tool approvals.
- Active Telegram run state, approval continuation runs, paused approval sessions, and queued follow-up messages are kept in Durable Object memory only; they are not persisted as chat history.
- Telegram uses server-side LLM env vars because it has no browser-local key store.
- Memory is capped at 200 items and 1200 characters per item.

## Tooling

Default tools are intentionally Worker-native and bounded:

- `current_time`: current date/time with optional timezone.
- `calculate`: arithmetic expression evaluator without code execution.
- `arxiv_search`: arXiv paper search through the public arXiv API.
- `github_search_repositories`, `github_get_repository`, `github_read_file`: public GitHub repository and file reading via Octokit. Optional `GITHUB_TOKEN` raises GitHub API rate limits.
- `fetch_url`: simple bounded URL read, requires approval.
- `http_request`: curl-like HTTP request with method/header/body support, requires approval.
- `save_memory` and `search_memory`: bounded curated memory tools.

External HTTP tools require `/approve` or an inline Telegram approval before execution. There is no shell/bash execution in the Worker runtime.

## Auth Boundary

`ADMIN_TOKEN` protects `/api/agent/*` admin/API routes and `/api/test-channel/*`. The status page and `/api/health` are public. A Worker URL is public, so protected agent APIs prevent other people from reading/writing memory or spending your LLM quota through your deployment. Protected routes accept either the signed login cookie or `Authorization: Bearer $ADMIN_TOKEN` for curl-based testing.

Telegram uses separate protection:

- `TELEGRAM_SECRET_TOKEN` validates Telegram webhook requests through the `X-Telegram-Bot-Api-Secret-Token` header.
- `TELEGRAM_ALLOWED_CHAT_IDS` limits who can use the bot.
- `TELEGRAM_ADMIN_USER_IDS` optionally limits mutating commands (`/approve`, `/deny`, `/forget`) to specific Telegram users.
- `TELEGRAM_STREAM_TRANSPORT` optionally controls streaming: `auto` default, `draft`, `edit`, or `off`.
- `TELEGRAM_TEXT_BATCH_MS` optionally controls short incoming text debounce; default is `180`, max is `1000`, `0` disables batching.
- `/id` in Telegram replies with the current chat id so you can add it to the allowlist.

Telegram commands:

- `/status`
- `/memory`
- `/forget <memory_id>`
- `/pending`
- `/approve <id>`
- `/deny <id>`
- `/stop`
- `/new`
- `/reset`
- `/id`

Telegram streaming uses `auto` transport by default: private chats try Bot API `sendMessageDraft`, then send the final answer as a normal message; groups and draft failures use a placeholder message with throttled `editMessageText`. Edit previews use a cursor, final messages try MarkdownV2 and retry as plain text on Telegram parse errors, stale previews are deleted after a fresh final message, and edit streaming has flood-control backoff. Tool approvals render as Telegram inline buttons and still support text `/approve <id>` / `/deny <id>`. The Durable Object streams typed SSE events internally.

When a normal Telegram message arrives while the same chat already has an active run, the Durable Object queues up to three follow-up turns in memory, aborts the current model step, and resumes with ephemeral in-run history. If the active run pauses for tool approval, the paused model context and queued/supplemental follow-ups stay in memory and continue after approval. Approval continuation is also tracked as an active run, so `/stop` and later follow-ups keep the same semantics. If the Durable Object loses paused memory, approval falls back to executing the tool and summarizing the result. Nothing in this path is persisted as full chat history.

## Local Setup

```bash
bun install
cp .dev.vars.example .dev.vars
bun run dev
```

Set `ADMIN_TOKEN` in `.dev.vars` if you use protected admin/API routes. The root page is only a status page.

## Telegram Setup

Set these secrets/env vars:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_SECRET_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1001234567890
TELEGRAM_ADMIN_USER_IDS=123456789
TELEGRAM_STREAM_TRANSPORT=auto
TELEGRAM_TEXT_BATCH_MS=180
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4.1-mini
```

Register the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_WORKER_DOMAIN/api/tg/webhook" \
  -d "secret_token=$TELEGRAM_SECRET_TOKEN"
```

For Cloudflare deployment, store sensitive values with `wrangler secret put`.

## HTTP Test Channel

The test channel runs the same Durable Object agent loop without Telegram. It uses `source: { channel: "test", chatId }`, supports SSE streaming by default, and can return collected JSON with `format=json`.

```bash
curl -N "http://127.0.0.1:8787/api/test-channel/chat" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"local","message":"hello from test channel"}'
```

JSON mode for scripts:

```bash
curl "http://127.0.0.1:8787/api/test-channel/chat?format=json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"local","message":"fetch https://example.com"}'
```

Approval and control endpoints:

- `POST /api/test-channel/approvals/<id>/approve`
- `POST /api/test-channel/approvals/<id>/deny`
- `POST /api/test-channel/stop`
- `GET /api/test-channel/approvals?chatId=local`
- `GET /api/test-channel/state`

## Scripts

```bash
bun run typecheck
bun run test
bun run test:coverage
bun run test:full
bun run build
```

`bun run test:coverage` runs the Vitest suite with V8 coverage and writes HTML/lcov reports under `coverage/`. `bun run test:full` runs typecheck, tests, and the Wrangler dry-run build. `bun run build` performs a Wrangler dry-run build and writes Wrangler config/log state under `.wrangler-home` inside the project.

Current tests cover zod validation schemas, cookies, top-level Worker route/auth/assets boundaries, Cloudflare runtime-boundary checks, context assembly, memory search helpers, zod-backed basic/research/GitHub/web/memory tools, tool registry/executor/guardrails, Durable Object approval/follow-up state, HTTP test channel proxying, channel command/SSE/registry helpers, OpenAI-compatible AI SDK streaming/tool calls, Telegram webhook auth paths, Telegram draft streaming, text batching, edit fallback and flood-control fallback, MarkdownV2 plain fallback, stale preview cleanup, inline approval callbacks, active-run stop commands, and command admin policy.

## Docs

- [Agent instructions](AGENTS.md)
- [Cloudflare agent research](docs/cloudflare-agent-research.md)
- [Hermes Agent notes](docs/hermes-agent-notes.md)
- [Technical selection](docs/technical-selection.md)

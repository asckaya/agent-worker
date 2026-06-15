# Agent Worker

Cloudflare Worker personal agent focused on non-coding workflows. The MVP uses Cloudflare Workers, Durable Objects SQLite, Hono, React status page, Vercel AI SDK, zod, and server-side OpenAI-compatible LLM credentials for Telegram.

The runtime is split into `model / tool / channel` layers. Telegram is the first real channel and supports slash commands, inline menu buttons, private-chat draft streaming with edit-message fallback, typing refresh, short text batching, text/image/PDF/MP3/WAV file handling, reminders/tasks, interruptible active-run follow-up queueing, MarkdownV2 final-message fallback, and `/approve` tool approval with inline buttons. A protected HTTP test channel is also available for local/manual testing without Telegram.

## Data Boundary

- The web surface is status-only, not a chat client.
- Telegram messages are used for the current turn and are not stored as conversation history.
- Durable Object SQLite stores bounded `memories`, bounded reminders/tasks, short-lived pending tool approvals, and bounded non-secret LLM profile overrides.
- Active Telegram run state, approval continuation runs, paused approval sessions, and queued follow-up messages are kept in Durable Object memory only; they are not persisted as chat history.
- Telegram uses server-side LLM secrets/env vars because it has no browser-local key store.
- LLM API keys are Worker secrets/env bindings only; they are not stored in Durable Object SQLite, docs, or client state.
- Memory is capped at 200 items and 1200 characters per item. Tasks are capped at 200 items.
- Telegram media files are never persisted. Supported media is downloaded only for the current turn and sent to the active model as bounded request content.
- Telegram `/remember` sends the note to the active LLM for curation and stores only the curated memory item, not the raw note.

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
- `TELEGRAM_ADMIN_USER_IDS` optionally limits mutating commands (`/approve`, `/deny`, `/forget`, `/remember`, `/stop`, `/new`, `/reset`, `/llmuse`, `/remind`, `/task`, `/todo`, `/done`) to specific Telegram users.
- `TELEGRAM_STREAM_TRANSPORT` optionally controls streaming: `auto` default, `draft`, `edit`, or `off`.
- `TELEGRAM_TEXT_BATCH_MS` optionally controls short incoming text debounce; default is `180`, max is `1000`, `0` disables batching.
- `TELEGRAM_TIME_ZONE` optionally controls reminder time parsing/display; default is `Asia/Shanghai`.
- `/id` in Telegram replies with the current chat id so you can add it to the allowlist.

Telegram commands:

- `/status`
- `/menu`
- `/memory`
- `/remember <text>` - curate with the active model and save memory
- `/task <text>`
- `/remind <when> <text>`
- `/tasks`
- `/done <task_id>`
- `/llm`
- `/llmuse <profile_id>`
- `/llmtest`
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
TELEGRAM_TIME_ZONE=Asia/Shanghai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4.1-mini
LLM_MODALITIES=text
```

For one model, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` are enough. For multiple models, keep API keys in separate Worker secrets and store only profile metadata in `LLM_PROFILES_JSON` or through the protected LLM settings API:

```json
{
  "activeProfileId": "openrouter-free",
  "profiles": [
    {
      "id": "openrouter-free",
      "name": "OpenRouter free",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "google/gemma-4-31b-it:free",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "modalities": ["text"],
      "maxTokens": 16384,
      "extraHeaders": {
        "HTTP-Referer": "https://YOUR_WORKER_DOMAIN",
        "X-Title": "agent-worker"
      }
    }
  ]
}
```

`apiKeyEnv` is the Worker secret/env binding name to read at runtime. Do not put the actual API key in the profile JSON. Secret-bearing headers such as `Authorization` and `X-API-Key` are rejected in `extraHeaders`; use `apiKeyEnv` instead.

`modalities` is an explicit capability declaration used before Telegram sends media to a model. Default is `["text"]`. Add `image`, `audio`, or `pdf` only after confirming that the selected provider/model supports that input type through the OpenAI-compatible API. Telegram rejects unsupported media before calling the provider. Current OpenAI-compatible serialization supports:

- `image`: Telegram photos and image documents.
- `audio`: MP3 and WAV only.
- `pdf`: PDF documents.
- `text`: text-like documents are converted into current-turn text.

Video and Telegram OGG/Opus voice messages are intentionally blocked for now because the current OpenAI-compatible adapter does not serialize them reliably.

For Cloudflare AI Gateway, either set `baseUrl` directly to the Gateway provider endpoint, or use first-class `aiGateway` metadata:

```json
{
  "activeProfileId": "openrouter-gateway",
  "profiles": [
    {
      "id": "openrouter-gateway",
      "name": "OpenRouter via AI Gateway",
      "aiGateway": {
        "accountId": "YOUR_ACCOUNT_ID",
        "gatewayId": "YOUR_GATEWAY_NAME",
        "provider": "openrouter"
      },
      "model": "openai/gpt-5-mini",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "modalities": ["text", "image"]
    }
  ]
}
```

This resolves to `https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_NAME/openrouter`.

Register the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_WORKER_DOMAIN/api/tg/webhook" \
  -d "secret_token=$TELEGRAM_SECRET_TOKEN"
```

Register the Telegram command menu so commands appear in the bot UI:

```bash
export TELEGRAM_BOT_TOKEN=...
bun run telegram:set-commands
```

For Cloudflare deployment, store sensitive values as encrypted Worker secrets, not plain variables:

```bash
wrangler secret put ADMIN_TOKEN
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_SECRET_TOKEN
wrangler secret put LLM_API_KEY
wrangler secret put OPENROUTER_API_KEY
```

User-specific runtime settings such as `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_ADMIN_USER_IDS`, `TELEGRAM_TIME_ZONE`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_MODALITIES`, and `LLM_PROFILES_JSON` can be set in the Cloudflare Dashboard under Worker variables and secrets. `wrangler.jsonc` sets `keep_vars: true` so Git/CLI deploys preserve Dashboard-managed runtime configuration instead of deleting it.

Wrangler local dev reads `.dev.vars`; use that instead of `.env` for local Worker secrets. For production, use Worker secrets for sensitive values and plain variables only for non-secret allowlists/profile metadata.

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
- `POST /api/test-channel/memories`
- `DELETE /api/test-channel/memories/<id>`
- `GET /api/test-channel/tasks?chatId=local`
- `POST /api/test-channel/tasks`
- `POST /api/test-channel/tasks/<id>/done`
- `DELETE /api/test-channel/tasks/<id>`
- `GET|PUT|DELETE /api/test-channel/llm`
- `POST /api/test-channel/llm/active`
- `POST /api/test-channel/llm/test`

Update persisted LLM profile metadata through the protected test channel:

```bash
curl "https://YOUR_WORKER_DOMAIN/api/test-channel/llm" \
  -X PUT \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @llm-settings.json
```

Switch and test the active profile:

```bash
curl "https://YOUR_WORKER_DOMAIN/api/test-channel/llm/active" \
  -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profileId":"openrouter-free"}'

curl "https://YOUR_WORKER_DOMAIN/api/test-channel/llm/test" \
  -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

The same profile list is visible in Telegram with `/llm`; `/llmuse <profile_id>` switches the active profile and `/llmtest` checks that the selected profile can call the provider.

## Scripts

```bash
bun run typecheck
bun run test
bun run test:coverage
bun run test:full
bun run build
bun run deploy:dry-run
bun run telegram:set-commands
```

`bun run build` runs typecheck and builds the status-page assets, which is the right command for Cloudflare Git builds. `bun run deploy:dry-run` additionally runs the Wrangler dry-run build and writes Wrangler config/log state under `.wrangler-home` inside the project. `bun run test:coverage` runs the Vitest suite with V8 coverage and writes HTML/lcov reports under `coverage/`. `bun run test:full` runs tests plus the Wrangler dry-run build.

Current tests cover zod validation schemas, cookies, top-level Worker route/auth/assets boundaries, Cloudflare runtime-boundary checks, context assembly, memory search helpers, zod-backed basic/research/GitHub/web/memory tools, tool registry/executor/guardrails, Durable Object approval/follow-up/task state, HTTP test channel proxying, channel command/SSE/registry helpers, OpenAI-compatible AI SDK streaming/tool calls, Telegram webhook auth paths, Telegram draft streaming, text batching, edit fallback and flood-control fallback, MarkdownV2 plain fallback, stale preview cleanup, inline approval callbacks/menu actions, active-run stop commands, and command admin policy.

## Docs

- [Agent instructions](AGENTS.md)
- [Cloudflare agent research](docs/cloudflare-agent-research.md)
- [Hermes Agent notes](docs/hermes-agent-notes.md)
- [Technical selection](docs/technical-selection.md)

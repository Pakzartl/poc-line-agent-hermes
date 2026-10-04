# Messaging Agent POC

Bun/TypeScript proof of concept for an AI coding assistant on Telegram, Discord, WhatsApp, and LINE. The Cloudflare Worker remains the public webhook edge while a pinned NousResearch Hermes Agent runtime on the personal OVH VPS handles allowed Telegram and Discord agent traffic. LINE and WhatsApp continue to use the Worker legacy loop.

## Current architecture

- Cloudflare Worker owns provider webhooks, signature checks, Telegram/Discord allowlists, the shared agent queue/DLQ, routing, and rollback.
- Production uses `AGENT_RUNTIME=hermes`; `legacy` remains the immediate rollback mode for the existing TypeScript agent loop.
- `AGENT_RUNTIME=hermes` routes all allowed Telegram and Discord agent traffic to Hermes. LINE and WhatsApp remain on the Worker legacy loop, so their legacy OpenAI/GitHub secrets are still required when those providers are configured.
- `AGENT_RUNTIME=fallback` is a routing/canary fallback only: Telegram users in `HERMES_TELEGRAM_ALLOWED_USER_IDS` use Hermes, other Telegram users plus LINE/WhatsApp use legacy. After a Hermes dispatch lease is acquired, the Worker does not execute the legacy agent for that update.
- `TELEGRAM_SESSION_COORDINATOR` is the existing Durable Object authority for Telegram and Discord duplicate claims and dispatch leases. Its binding name is retained to avoid a migration; `SESSION_MEMORY` remains legacy memory/cache/audit.
- Hermes runs as the pinned Docker image on the personal OVH VPS and listens only on `127.0.0.1:8642`. The outbound-only Cloudflare Tunnel publishes `https://hermes.pakzartl.xyz`; all non-health API calls require bearer authentication.
- The Cloudflare Worker and Tunnel remain on free Cloudflare products. Do not enable Cloudflare Containers or add paid Cloudflare/OVH resources without explicit approval; the already-purchased OVH VPS is the only additional hosting cost.

## Channel recommendation

**Discord is the recommended company operating interface for this project.** It supports signed interactions, deferred replies, autocomplete, buttons, attachments, typing indicators, slash commands, and natural mention flows. The adapter keeps repository selection and long-running Hermes work on the existing Worker Queue and Durable Object, so it does not add a Cloudflare resource.

Telegram remains a good lightweight fallback. Its Bot API has a straightforward webhook secret and normal `sendMessage` calls without an expiring reply token.

WhatsApp is also supported and is usually a better fit than LINE when the intended users already work in WhatsApp. It requires Meta Business onboarding and is still subject to WhatsApp's customer-service window, template, and pricing rules.

**LINE is not recommended for long-running agent tasks.** A LINE reply token is single-use and should be used within one minute. Production webhook ingress should target an acknowledgement within three seconds as an engineering target; that is not a documented LINE SLA, and this synchronous POC does not guarantee it. A slow model or tool run can outlive the useful reply-token window and require an asynchronous push message. LINE reply messages themselves do not consume the monthly message quota, but push-message fallbacks do. That combination makes LINE more restrictive and potentially more expensive for coding-agent workloads than Telegram, and often than WhatsApp.

## Run

```sh
cp .env.local.example .env.local
bun run dev
```

Configure at least one complete messaging provider block. Unused provider blocks must remain entirely blank.

Local validation entrypoints:

```sh
bun run test:worker
bun run test:adapter
bun run test:hermes
```

Run them sequentially. `test:worker` runs the Bun suite, main TypeScript check, Worker TypeScript check, formatting check, and Wrangler dry-run in order. `test:hermes` runs the test Compose service from `hermes/compose.test.yaml`.
`test:adapter` runs the local companion adapter suites without external credentials.

Endpoints:

- `GET /health`
- `POST /telegram/webhook`
- `POST /discord/interactions`
- `POST /discord/gateway/messages` for the signed OVH Gateway bridge
- `POST /events/queue-failure` for signed retry-exhausted job events
- `GET /whatsapp/webhook` for Meta's verification challenge
- `POST /whatsapp/webhook`
- `POST /line/webhook`

All inbound provider requests are authenticated before their JSON body is processed:

- Telegram checks `X-Telegram-Bot-Api-Secret-Token`.
- Discord verifies `X-Signature-Ed25519` over the exact timestamp and raw body.
- The Discord Gateway bridge signs the exact timestamp and raw body with a
  separate HMAC-SHA256 secret and the Worker rejects requests older than five
  minutes.
- WhatsApp checks `X-Hub-Signature-256` against the exact raw body with the Meta App Secret.
- LINE checks `x-line-signature` against the exact raw body with HMAC-SHA256 and the channel secret.

## Telegram setup

Set these values in `.env.local`:

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-botfather-token
TELEGRAM_WEBHOOK_SECRET=replace-with-a-random-secret
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_API_BASE_URL=https://api.telegram.org
```

Telegram access is deny-by-default. Send `/whoami` to the bot to see your own
Telegram user ID, then add that numeric ID to `TELEGRAM_ALLOWED_USER_IDS`.
Separate multiple IDs with commas. Unauthorized users receive only their own ID;
their messages never reach session memory, OpenAI, or GitHub.
Allowed users can send `/clear` to delete the current chat's conversation
history and start fresh with the next message.
Normal messages go directly to general Hermes chat. Use `/code` followed by a
question to choose any repository visible to `GITHUB_TOKEN`, then choose one of
its live GitHub branches with Telegram buttons. The legacy `repo:` / `branch:`
header format also remains supported.

Expose the server over HTTPS, then register the webhook. Telegram accepts only `A-Z`, `a-z`, `0-9`, `_`, and `-` in the webhook secret.

```sh
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://agent.example.com/telegram/webhook",
    "secret_token": "replace-with-the-same-webhook-secret",
    "allowed_updates": ["message", "callback_query"]
  }'
```

The Bot API token is part of Telegram's request URL. Avoid saving the expanded command in shell history or logs.

The Queue consumer sends Telegram's `typing` chat action immediately and refreshes it every four seconds while the agent is working. Failure to publish the indicator is logged but never fails the agent job.

## Discord setup

Create an application in the Discord Developer Portal. Copy its Application ID
and Public Key, then set the Worker variables in `wrangler.jsonc`:

```jsonc
"DISCORD_APPLICATION_ID": "123456789012345678",
"DISCORD_PUBLIC_KEY": "64-character-hex-public-key",
"DISCORD_ALLOWED_USER_IDS": "your-numeric-discord-user-id"
```

Discord access is deny-by-default. Only IDs in `DISCORD_ALLOWED_USER_IDS` can
queue agent work. Set the application's Interactions Endpoint URL to
`https://agent.pakzartl.xyz/discord/interactions`; Discord's signed PING request
must succeed before the portal accepts it.

Put the bot token in local `.env.local`, then register the Discord capability
commands:

```dotenv
DISCORD_APPLICATION_ID=123456789012345678
DISCORD_BOT_TOKEN=replace-with-discord-bot-token
DISCORD_ALLOWED_USER_IDS=123456789012345678
DISCORD_ALLOWED_GUILD_IDS=123456789012345678
DISCORD_GATEWAY_SHARED_SECRET=replace-with-at-least-32-random-characters
DISCORD_WORKER_GATEWAY_URL=https://agent.pakzartl.xyz/discord/gateway/messages
# Optional for immediate test-server registration; omit for global commands.
DISCORD_GUILD_ID=123456789012345678
```

```sh
bun run discord:register
```

`/code` autocompletes every repository visible to `GITHUB_TOKEN`, then
autocompletes branches from the selected repository. Agent commands respond
with an ephemeral deferred message immediately; the Queue consumer replaces it
with the Hermes result and keeps overflow followups ephemeral.

Natural code chat runs alongside the slash commands. Mention the bot with a
question, reply with a repository, then reply with a branch. Follow-up selection
messages do not need another mention. The OVH `discord-gateway` container keeps
the outbound Gateway connection and forwards allowlisted messages to the signed
Worker endpoint; it exposes no inbound port. Enable **Message Content Intent**
for the bot in Discord Developer Portal so unmentioned repo/branch follow-ups
contain their text. The Worker sends `typing` while Hermes is processing and
posts the final answer back to the channel. Unmentioned messages outside an
active selection flow are ignored. The adapter reuses the existing Queue and
Durable Object, so it adds no Cloudflare resource.

### Discord capability commands

- `/code` investigates an explicit repository and branch and attaches a cited HIL artifact.
- `/risk` inspects an implementation or deployment change and returns blast radius, side effects, a Human Test Plan, and a HIL artifact.
- `/db` executes an explicit `SELECT`/`WITH` query. Live execution is disabled unless the complete read-only adapter block is configured; natural-language-to-SQL, mutations, comments, multi-statements, unsafe functions, non-allowlisted tables, oversized results, and unmasked PII fail closed.
- `/artifact` creates a Markdown, JSON, CSV, diagram, or screenshot artifact. Text artifacts are generated through the existing model path and validated before attachment. Screenshots accept only a server-owned target id; users cannot supply an arbitrary URL. Production includes the no-cost OVH companion renderer and a `javis-health` demo target.
- `/deploy` accepts an allowlisted repository, immutable 40-character commit SHA, and autocomplete target. It creates a plan first, then requires the requesting user to press **Approve deploy** before the external executor is called. Approval is bound to user, guild, target, repository, SHA, expiry, and plan digest.
- `/status request_id:<id>` reads the persisted capability lifecycle and latest audit entry.
- `/skills` lists the demo and output artifact for every capability.
- `/clear` clears the caller's channel-scoped Hermes conversation.

All capability jobs use the existing Durable Object for `queued → running → waiting_approval → completed/failed/cancelled` state and the existing Queue for execution. Deploy chat generation can only prepare a plan; it cannot call the executor.

### Optional capability adapters

Leave an entire block blank to keep that capability safely disabled. Tokens are secrets and must be uploaded with Wrangler, not committed.

```dotenv
# Bounded read-only HTTP adapter
DATABASE_ADAPTER_URL=https://db-reader.example/db/query
DATABASE_ADAPTER_TOKEN=secret
DATABASE_DATASOURCE=lms-read-replica
DATABASE_ALLOWED_SCHEMAS=public,reporting
DATABASE_ALLOWED_TABLES=public.users,reporting.course_progress

# Screenshot renderer; targets are IDs mapped to URLs on the server
ARTIFACT_RENDERER_URL=https://renderer.example/capture
ARTIFACT_RENDERER_TOKEN=secret
ARTIFACT_SCREENSHOT_TARGETS_JSON=[{"id":"learner-preview","url":"https://learner.example"}]

# Approval-gated deploy executor
DEPLOY_EXECUTOR_TOKEN=secret
DEPLOY_TARGETS_JSON=[{"id":"worker-dev","displayName":"Worker development","environment":"development","allowedRepositories":["owner/repo"],"executorUrl":"https://deploy.example/run","healthcheckUrl":"https://example.com/health"}]
```

The DB and deploy endpoints must use credential-free HTTPS URLs; bearer tokens are sent separately. The included OVH DB adapter is a separate optional Compose profile that exposes `POST /db/query`, validates the Worker fingerprint and limits again, starts a PostgreSQL transaction in read-only mode, and refuses writes, comments, multi-statements, unsafe functions, unknown datasources, and limit escalation before execution. It requires a read-only PostgreSQL connection string supplied only through the VPS `env.local`. The loopback-only OVH deploy executor receives a finite JSON plan and idempotency key, never a shell command. It deploys only an allowlisted repository and exact commit SHA. A failed deploy returns rollback guidance but never rolls back automatically; rollback requires a separate approved plan.

### Queue-failure event artifact

Set `QUEUE_FAILURE_EVENT_SECRET` and optionally `QUEUE_FAILURE_DISCORD_CHANNEL_ID`. Producers send a bounded `queue-failure/v1` JSON body to `/events/queue-failure` with `X-Javis-Signature: sha256=<HMAC-SHA256(body)>`. The Worker verifies the raw body, deduplicates the event, redacts credentials and PII, classifies the likely cause, and posts one Markdown HIL artifact to Discord. No event secret means the endpoint returns `503`.

## WhatsApp setup

Create a Meta app with the WhatsApp product and configure:

```dotenv
WHATSAPP_ACCESS_TOKEN=replace-with-system-user-or-test-token
WHATSAPP_PHONE_NUMBER_ID=replace-with-phone-number-id
WHATSAPP_VERIFY_TOKEN=replace-with-your-own-random-verification-token
WHATSAPP_APP_SECRET=replace-with-meta-app-secret
WHATSAPP_API_BASE_URL=https://graph.facebook.com/v26.0
```

In the Meta App Dashboard, set the callback URL to `https://agent.example.com/whatsapp/webhook`, enter the same `WHATSAPP_VERIFY_TOKEN`, and subscribe the WhatsApp Business Account to the `messages` field. The GET verification request returns `hub.challenge`; POST deliveries are validated with the App Secret before processing.

`WHATSAPP_API_BASE_URL` is configurable because Graph API versions expire. Update it to a currently supported version when upgrading the deployment.

## LINE setup

```dotenv
LINE_CHANNEL_SECRET=replace-with-line-channel-secret
LINE_CHANNEL_ACCESS_TOKEN=replace-with-line-channel-access-token
LINE_API_BASE_URL=https://api.line.me
```

Set the Messaging API webhook URL to `https://agent.example.com/line/webhook`. The implementation uses the one-time reply token and does not automatically fall back to a quota-consuming push message.

## Cloudflare Worker deployment

The production Worker is configured in `wrangler.jsonc` with:

- Custom Domain: `https://agent.pakzartl.xyz`
- Worker name: `poc-line-agent`
- KV-backed legacy session memory/cache/audit through the `SESSION_MEMORY` binding
- Durable Object-backed Telegram idempotency through `TELEGRAM_SESSION_COORDINATOR`
- Shared Telegram/Discord queue and DLQ for asynchronous processing
- Workers logs and sampled traces enabled

Authenticate, generate binding types, validate the bundle, and deploy:

```sh
bunx wrangler login --use-keyring
bun run worker:types
bun run test:worker
bun run worker:deploy
```

Upload secrets with `wrangler secret put` or `wrangler secret bulk`; never add their values to `wrangler.jsonc`. The required production secrets are:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_USER_IDS`
- `DISCORD_ALLOWED_USER_IDS`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GATEWAY_SHARED_SECRET`
- `DISCORD_ALLOWED_GUILD_IDS`
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`
- `HERMES_API_SERVER_KEY`

Optional capability secrets are `QUEUE_FAILURE_EVENT_SECRET`, `DATABASE_ADAPTER_TOKEN`, `ARTIFACT_RENDERER_TOKEN`, and `DEPLOY_EXECUTOR_TOKEN`. Upload only the blocks that have an actual external adapter; blank optional configuration is intentionally fail-closed.

Production sets `HERMES_BASE_URL=https://hermes.pakzartl.xyz`. `HERMES_API_SERVER_KEY` must match the VPS `API_SERVER_KEY`; keep both values outside git and inject the Worker value with Wrangler secret storage.

After deployment, register `https://agent.pakzartl.xyz/telegram/webhook` with Telegram, `https://agent.pakzartl.xyz/discord/interactions` with Discord, and `https://agent.pakzartl.xyz/line/webhook` with LINE. LINE also requires **Use webhook** to be enabled in the Messaging API channel settings.

## Hermes runtime

Hermes assets live under `hermes/`:

- `compose.yaml` pins `nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`, exposes the API server on `127.0.0.1:8642`, mounts `/srv/hermes/data:/opt/data`, and mounts local plugin/skill directories read-only.
- `config.template.yaml` enables the Hermes API server and the read-only GitHub plugin.
- `plugins/poc-line-agent-github/` mirrors the current read-only GitHub tool surface.
- `skills/*/SKILL.md` mirrors the current Worker Markdown skills in Hermes-compatible form.
- `tests/` contains plugin, skill, and Sessions API spike checks.
- `runbook.md` documents the OVH production deployment, Tunnel, validation, rollback, backup, and upgrade gates.

For local Hermes validation:

```sh
cp hermes/env.template hermes/env.local
docker compose -f hermes/compose.yaml config
docker compose -f hermes/compose.yaml pull
docker compose -f hermes/compose.yaml up -d
curl -fsS http://127.0.0.1:8642/health
bun run test:hermes
```

`hermes/env.local` and local Hermes data directories are ignored by git. Keep real `API_SERVER_KEY`, OpenAI keys, and GitHub tokens outside committed files.

Before Telegram Hermes canary, run the Sessions API spike from the test container against the pinned image and confirm isolation, message retrieval metadata, and restart persistence. If that spike fails, keep `AGENT_RUNTIME=legacy`.

Rollback is config-only for routing: set `AGENT_RUNTIME=legacy` or remove Hermes canary users in `AGENT_RUNTIME=fallback`. Do not remove the Durable Object binding/migration during a normal rollback.

## Local sandbox

Run a full local loop without LINE, OpenAI, or GitHub credentials:

```sh
bun run sandbox
```

Run the same local UI with real OpenAI and GitHub credentials from `.env.local`:

```sh
bun run sandbox:live
```

The browser sandbox currently simulates LINE ingress so it can exercise signature verification and reply-token behavior locally. Live mode still captures the final reply locally; it does not send a response to a real chat. The automated sandbox suite runs full webhook-to-reply loops for LINE, Telegram, and WhatsApp, while keeping every external service mocked.

Conversation memory is opt-in in the sandbox UI. When enabled, recent user and assistant messages are persisted under `.sessions/<hashed-session-id>/memory.json`. The provider-qualified session ID is hashed and is never used directly as a directory name. Reset session clears that sandbox session's memory.

Open [http://127.0.0.1:3101](http://127.0.0.1:3101), or send a request directly:

```sh
curl -s -X POST http://127.0.0.1:3101/sandbox/send \
  -H 'Content-Type: application/json' \
  -d '{"text":"why does login fail?"}'
```

Inspect captured traces:

```sh
curl -s http://127.0.0.1:3101/sandbox/traces
```

Run the automated full-loop test:

```sh
bun run test:sandbox
```

Defaults:

- Real app: `http://127.0.0.1:3100`
- Sandbox UI, mocks, and LINE reply capture: `http://127.0.0.1:3101`
- Override with `PORT`, `SANDBOX_PORT`, or `LINE_CHANNEL_SECRET`.
- Both sandbox servers bind to `127.0.0.1` only.

## Shared environment

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. For OpenRouter, use `https://openrouter.ai/api/v1` and an OpenRouter model slug.
- `OPENAI_MODEL` defaults to `gpt-5.4-mini`.
- `OPENAI_MAX_TOOL_ROUNDS` defaults to `50`; the model stops earlier as soon as it can answer. If it reaches the limit, it returns a best-effort summary from the evidence already collected.
- `OPENAI_MAX_TOOL_CALLS` defaults to `100` and caps the total tools executed even when one model round requests several tools.
- `GITHUB_TOKEN` with read-only repository contents/search access.
- `GITHUB_REF` remains a legacy-runtime compatibility default. Hermes code search does not use it.
- `/code` lists every repository the configured `GITHUB_TOKEN` can read, including owned, collaborator, and organization repositories. General chat does not receive a repository scope.
- `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated allowlist of numeric Telegram
  user IDs. An empty list denies all agent access except `/whoami`.
- `DISCORD_ALLOWED_USER_IDS` is a comma-separated allowlist of numeric Discord user IDs. An empty list leaves the Discord endpoint disabled.
- `AGENT_RUNTIME` defaults to `legacy`. Use `fallback` for Telegram user canaries and `hermes` only after the Hermes health, spike, Worker, and canary gates pass.
- `HERMES_BASE_URL` is the Worker-to-Hermes API origin, for example a private Cloudflare Tunnel URL or local `http://127.0.0.1:8642`.
- `HERMES_API_SERVER_KEY` is a Worker secret matching Hermes `API_SERVER_KEY`.
- `HERMES_TELEGRAM_ALLOWED_USER_IDS` controls the Telegram Hermes canary only in `AGENT_RUNTIME=fallback`. In `AGENT_RUNTIME=hermes`, every allowed Telegram agent request routes to Hermes.
- `SESSION_MEMORY_DIR` defaults to `.sessions`.
- `SESSION_MEMORY_MAX_MESSAGES` defaults to `12` messages (six user/assistant turns).

## Skills

Skills live in `src/skills/*.md`. The backend selects one skill from the incoming question, loads the Markdown text as instructions, and injects it into the model instructions.

Included skills:

- `repo-overview.md`
- `find-code.md`
- `rate-limit-audit.md`
- `explain-code.md`
- `trace-feature.md`
- `recent-changes.md`
- `commit-review.md`
- `pr-review.md`
- `bug-investigator.md`
- `test-finder.md`
- `missing-tests.md`
- `dependency-check.md`
- `security-review.md`
- `config-explainer.md`
- `api-catalog.md`
- `database-map.md`
- `architecture-map.md`
- `onboarding-guide.md`
- `release-summary.md`
- `incident-triage.md`
- `repo-comparison.md`

## Tools

The model can request:

- `search_code(query)` scans the runtime-bound repository and branch; separate
  literal alternatives with `|` to search the downloaded branch archive once.
- `read_file(path)` reads from that same bound repository and branch.

Repository and branch are injected by a Hermes `pre_tool_call` policy hook from
the latest runtime-created scope envelope; the model cannot choose or override
them. Broad repository listing and generic GitHub REST tools are not exposed.
All GitHub requests are backend HTTP `GET` reads. Branch archive redirects
issued by GitHub are followed for bounded streaming search. Tokens are never
included in model input or chat replies.

Responses are sent with `store: false`; only bounded tool output is returned to the model.

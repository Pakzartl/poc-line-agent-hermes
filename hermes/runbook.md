# Hermes Runtime Runbook

This runbook covers local validation and the production Hermes Agent runtime for `poc-line-agent`. It intentionally contains no real credentials.

## Production cost guard

Production uses the already-purchased personal OVH VPS plus Cloudflare Workers and Cloudflare Tunnel. Do not provision GCE, Cloudflare Containers, a paid Worker plan, a second VPS, paid backups, or any other paid resource without explicit approval. Normal OpenAI usage remains usage-billed by the configured provider.

The VPS is reached with the local SSH alias `megalodon_ovh`. Hermes must stay bound to `127.0.0.1:8642`; the only public application path is the outbound Cloudflare Tunnel hostname `hermes.pakzartl.xyz`.

## Local Validation

1. Validate production Compose shape without secrets: `docker compose -f hermes/compose.yaml config`.
2. Validate the local smoke override: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml config`.
3. Start the local smoke gateway with a Docker named volume: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml up -d`.
4. Check health through the loopback bind: `curl -fsS http://127.0.0.1:8642/health`.
5. Check the authenticated API surface without sending a model prompt: `curl -fsS -H "Authorization: Bearer local-smoke-api-key-0000000000000000" http://127.0.0.1:8642/v1/capabilities`.
6. Validate the local companion adapters without secrets: `bun run test:adapter`.
7. Stop the local smoke gateway: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml down`.
8. Run Hermes tests: `docker compose -f hermes/compose.test.yaml run --rm hermes-tests`.

Run Worker and Hermes validations sequentially. Do not run the Worker suite while the Hermes test container is running.

Production validation on the OVH host uses `/srv/hermes/app/env.local` and `/srv/hermes/data:/opt/data`; local smoke uses placeholder-only Compose overrides and the `hermes-smoke-data` Docker volume so a clean macOS checkout does not need `/srv/hermes` or a committed env file.

The pinned s6 image reads the active runtime config from `/opt/data/config.yaml`. Compose binds `hermes/config.template.yaml` there directly; do not rely on an entrypoint copy into `/opt/data` for this image.

## OVH Debian 13 production host

- Host: `megalodon_ovh` (`vps-df9f4297`), Debian 13, amd64, 4 GB RAM, 40 GB local SSD, and 2 GB swap.
- Docker Engine and Compose come from Docker's official Debian repository. Docker logs rotate at 10 MB with three files.
- Runtime files live under `/srv/hermes/app`; persistent state lives under `/srv/hermes/data`.
- `env.local` is root-owned with mode `0600`. Tunnel configuration and credentials under `/etc/cloudflared` are root-only.
- SSH accepts public keys only, disables root login, and is the only inbound port allowed by UFW.
- Docker, cloudflared, UFW, and the unattended-upgrade timers must remain enabled across reboot.
- Validate with `sudo docker compose -f /srv/hermes/app/compose.yaml config --quiet`.
- Start the production containers with `sudo docker compose -f /srv/hermes/app/compose.yaml up -d --wait`.
- Verify `poc-line-agent-hermes` and `poc-line-agent-capability-adapter` are healthy. `ss -lntp` must show the application ports only on `127.0.0.1`: Hermes on `8642` and the capability adapter on `8788`. The DB adapter is optional and behind the `db` Compose profile; if enabled, it must bind only to `127.0.0.1:8789` and use a read-only PostgreSQL credential. The approval-gated deploy executor runs as `poc-line-agent-deploy-executor.service` on `127.0.0.1:8790`; it must not expose Docker or a shell API to the Worker.

Do not use object/FUSE storage for `/opt/data`. Hermes SQLite/WAL state must stay on the VPS local ext4 filesystem.

## Discord Gateway Bridge

The `discord-gateway` service keeps a persistent Discord Gateway connection for normal chat messages while the Cloudflare Worker keeps handling slash-command interactions. It publishes no ports and only egresses to Discord plus `DISCORD_WORKER_GATEWAY_URL`.

Required `env.local` values:

- `DISCORD_BOT_TOKEN`
- `DISCORD_WORKER_GATEWAY_URL`
- `DISCORD_GATEWAY_SHARED_SECRET` with the same value configured on the Worker
- `DISCORD_ALLOWED_USER_IDS`
- `DISCORD_ALLOWED_GUILD_IDS`

The bridge requests `Guilds`, `GuildMessages`, `DirectMessages`, and `MessageContent` Gateway intents. Message Content must be enabled for the bot in Discord Developer Portal for non-mention follow-up messages in guild channels. The service ignores bot/webhook messages, denies users and guilds outside the allowlists, signs the exact JSON body as `timestamp.body` with HMAC-SHA256, and never logs message content.

## Cloudflare Tunnel

- Tunnel: `poc-line-agent-hermes-ovh` (`04f4553e-c475-424b-b0b6-22f4c4106400`).
- Hostname: `https://hermes.pakzartl.xyz` -> `http://127.0.0.1:8642`.
- Capability hostname: `https://capabilities.pakzartl.xyz` -> `http://127.0.0.1:8788`.
- Deploy executor hostname: `https://deploy.pakzartl.xyz` -> `http://127.0.0.1:8790`.
- Optional DB capability hostname: `https://db-capabilities.pakzartl.xyz` -> `http://127.0.0.1:8789`, enabled only after `DB_ADAPTER_*` points at a read-only datasource.
- Keep tunnel credentials outside git with root-only permissions.
- Run `cloudflared` as an enabled systemd service and keep its metrics listener on loopback.
- Keep the Hermes Compose port bound to `127.0.0.1`.
- Keep the capability adapter bound to `127.0.0.1:8788`. Its artifact route requires a bearer token and resolves only server-owned target ids; never accept a user-supplied URL.
- Keep the DB adapter disabled unless a read-only PostgreSQL datasource is approved. Its `/db/query` route requires bearer auth, validates datasource alias, Worker fingerprint, request limits, SQL read-only shape, and parameter safety, then runs through `psql` inside a read-only transaction.
- Keep the deploy executor bound to loopback and its bearer token synchronized with the Worker's `DEPLOY_EXECUTOR_TOKEN`. It accepts only `DEPLOY_PLAN_V1`, an allowlisted repository, an immutable SHA, and the matching idempotency key. It never accepts arbitrary commands and never auto-rolls back.
- Require `API_SERVER_KEY` bearer auth on every Worker-to-Hermes call.
- Do not expose the dashboard publicly unless an auth provider is configured.

## Secret Injection

Secrets live outside git:

- Hermes runtime: `API_SERVER_KEY`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `GITHUB_TOKEN`, and `GITHUB_API_BASE_URL`. Repository tools receive repository and branch from the Worker-created scope envelope for the current turn; Hermes does not select a branch from an environment default. The pinned runtime selects its provider and model through `model.provider` and `model.default` in `config.template.yaml`; `OPENAI_MODEL` alone does not configure Hermes.
- Worker: `HERMES_BASE_URL`, `HERMES_API_SERVER_KEY`, provider webhook/reply secrets, Telegram allowlist.
- Capability adapter: `CAPABILITY_ADAPTER_TOKEN` and `CAPABILITY_ARTIFACT_TARGETS_JSON`. The token must equal the Worker's `ARTIFACT_RENDERER_TOKEN`; the Worker and adapter target lists must match.
- DB adapter: `DB_ADAPTER_TOKEN`, `DB_ADAPTER_DATASOURCES_JSON`, and the datasource-specific connection string env such as `LMS_READONLY_DATABASE_URL`. Each datasource entry must include its own `allowedSchemas` and `allowedTables`. The token must equal the Worker's `DATABASE_ADAPTER_TOKEN`; the datasource alias must equal both `DATABASE_DATASOURCE` and the non-secret `DATABASE_SCHEMA_CATALOG_JSON.datasource`; the Worker table/schema allowlists remain the first gate and the adapter independently enforces the same or narrower allowlists as the second gate.

Before enabling the DB profile, prove the database role itself is read-only independently of application validation. Set `DB_READONLY_CONNECTION_ENV` to the datasource connection-string environment-variable name and `DB_READONLY_PROBE_TABLE` to one allowlisted `schema.table`, then run:

```bash
sudo docker compose --profile db run --rm \
  -e DB_READONLY_CONNECTION_ENV=LMS_READONLY_DATABASE_URL \
  -e DB_READONLY_PROBE_TABLE=public.example \
  db-adapter /app/verify-readonly-role.sh
```

The verifier requires `default_transaction_read_only=on` and deliberately attempts a no-row `DELETE` inside a transaction. Enabling `/db` is prohibited unless the write probe is rejected. The verifier never prints the connection string.
- Deploy executor: `DEPLOY_EXECUTOR_TOKEN`, `DEPLOY_EXECUTOR_PORT`, `DEPLOY_EXECUTOR_STATE_DIR`, and `DEPLOY_EXECUTOR_TARGETS_JSON`. The token must equal the Worker's secret; targets must name a fixed repository, app directory, backup directory, Compose file, and healthcheck.

Never place provider tokens, GitHub tokens, OpenAI keys, or the Hermes API key in `config.template.yaml`, `compose.yaml`, tests, logs, snapshots, or committed env files.

## Tool Exposure Security

Production and smoke configs pin `platform_toolsets.api_server` to only:

- `poc_line_agent_github`
- `poc_line_agent_skills_read`
- `no_mcp`

`known_plugin_toolsets.api_server` records the two plugin toolsets so Hermes does not silently drop them, and `agent.disabled_toolsets` explicitly disables risky defaults including terminal, file, browser, web/search, memory/session search, code execution, delegation, cron, connectors, computer use, image/video/TTS generation, x_search, homeassistant, kanban, Discord/admin, Feishu doc/drive, Spotify, Yuanbao, and stock `skills`.

`tools.tool_search.enabled: off` is intentional. In pinned Hermes v0.21.5, plugin tools are otherwise replaced in the model request by `tool_search`, `tool_describe`, and `tool_call`; the smoke must fail if those bridge tools, stock `skill_manage`/`skill_view`/`skills_list`, MCP, browser, web, memory, terminal/shell, file write, or other mutation-capable tools appear in the model-facing schema.

The approved model-facing tools are exactly:

- Scope-bound GitHub read tools: `search_code(query)`, `read_file(path)`
- Mounted skill read tools: `list_repo_skills`, `read_repo_skill`

Normal Telegram messages are general Hermes chat and carry no source scope. `/code <question>` creates an independent short-lived selection flow in the existing per-chat Durable Object, lists every repository the configured GitHub token can read, fetches the selected repository's live branches, and sends the selected repository and branch in the canonical scope envelope. Multiple `/code` pickers can remain active in the same chat without replacing one another. The legacy `repo:` / `branch:` header format remains supported. The plugin captures scope per `session_id` and `turn_id`, clears invalid or missing scope for that turn, and injects scope into `search_code` and `read_file` with a `pre_tool_call` hook. The model-facing schemas contain no repository or branch fields, and broad `list_repositories`, `github_get`, and `get_commit` tools are absent.

The `poc_line_agent_skills_read` plugin reads only direct child `SKILL.md` files under `POC_LINE_AGENT_SKILLS_DIR`, rejects traversal and symlink escapes, bounds output, and never writes. Use it for runtime skill discovery instead of the stock Hermes `skills` toolset.

## Sessions API Spike

Every caller must create a session with `POST /api/sessions` before the first `POST /api/sessions/{id}/chat`. Treat HTTP 409 from session creation as success because it means the durable session already exists.

Before routing real traffic, run the credential-free local spike against a deterministic fake OpenAI-compatible service:

1. Validate the fake-model Compose stack: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml -f hermes/compose.fake-openai.yaml config`.
2. Start the pinned Hermes container and fake model service: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml -f hermes/compose.fake-openai.yaml up -d`.
3. Run the machine-readable spike: `python3 hermes/smoke/sessions_api_spike.py`.
4. Stop the stack when finished: `docker compose -f hermes/compose.yaml -f hermes/compose.local.yaml -f hermes/compose.fake-openai.yaml down -v`.

The spike sends two provider-qualified session IDs, `telegram:chat:1001` and `line:user:u-1001`, through `POST /api/sessions/{id}/chat`, verifies `GET /api/sessions/{id}/messages` returns stable ordered `id`/timestamp, `role`, and `content`, restarts the Hermes container while preserving the `hermes-smoke-data` volume, and verifies both histories remain persistent and isolated.

Known pinned-runtime observability defect: Hermes Agent v0.21.5 currently returns HTTP 500 for `GET /v1/skills` with `_find_all_skills() got an unexpected keyword argument 'include_editorial'`. This endpoint is irrelevant to the production skill path because the stock `skills` toolset is deliberately disabled. The spike keeps the endpoint failure as a warning, not a blocker, only when the fake model proves the approved `poc_line_agent_skills_read` tools can list skills, read `repo-overview`, and complete with `runtime-skill-smoke-ok`. The spike also fails on any enabled toolset outside the approved plugin toolsets, or any model-facing tool outside the four approved read tools above.

If the spike cannot prove retrieval, isolation, restart persistence, and ordering metadata, Telegram Hermes routing remains blocked.

## Canary

- Canary starts Telegram-only for configured allowed users or a synthetic canary route.
- LINE stays on legacy until a dedicated timing spike proves reply-token budget.
- WhatsApp stays unconfigured until production secrets exist.
- Keep the Cloudflare Worker as public edge, provider auth gate, Telegram queue/DLQ owner, canary router, and rollback switch.

## Rollback

Rollback changes routing, not coordination:

- Set the Worker runtime back to legacy or disable Hermes canary.
- Keep the Durable Object binding/migration deployed once introduced.
- Keep `TELEGRAM_SESSION_COORDINATOR` as the Telegram idempotency authority in legacy, Hermes, and fallback modes.
- Leave Hermes state mounted for audit unless an explicit destructive cleanup is approved.
- If Hermes is unavailable, legacy traffic should not depend on it.

## Backups And Upgrades

- Take a VPS snapshot before upgrades only when its optional OVH cost has been explicitly approved; otherwise make an application-level SQLite-consistent backup.
- Back up `/srv/hermes/data` while the container is stopped or with a SQLite-consistent backup method.
- Upgrade only by changing the image pin after rerunning the full plugin, Sessions API spike, persistence, Worker, canary, and rollback test gates.
- Keep a rollback copy of the previous `compose.yaml`, image pin, and `/srv/hermes/data` backup until the canary window is accepted.

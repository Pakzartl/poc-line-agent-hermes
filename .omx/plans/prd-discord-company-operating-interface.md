# Discord Company Operating Interface PRD

## Objective

Turn Javis into the Discord-first operating interface described by the approved
AI Capability Assignments while preserving the current Cloudflare Worker edge,
shared Queue/Durable Object coordination, and Hermes runtime on the personal OVH
server.

The completed system must provide:

1. Risk Assessment with a Human Test Plan and a reviewable HIL artifact.
2. Event-driven Queue Failure investigation with a one-screen Discord artifact.
3. Discord commands for Ask Code, Ask Database, and Ask for Artifact.
4. An approval-gated `/deploy` workflow with preflight, health check, audit, and
   rollback guidance.
5. A versioned skill contract so every skill is demoable, verifiable, and ends
   in a useful HIL artifact.

LINE, Telegram, and WhatsApp compatibility may remain, but all new capabilities
and interactions in this PRD are Discord-only.

## Constraints

- Cloudflare operations must use only `pok.vip.08@gmail.com`; never access or
  mutate any `@skilllane.co` account.
- Reuse the existing Worker, Queue, Durable Object, KV, custom domain, OVH VPS,
  and Discord bot. Do not provision a paid service or another server.
- Database access is read-only, allowlisted, bounded, audited, and fail-closed.
- Deployment or any other external mutation requires a fresh human approval
  tied to the exact immutable operation being approved.
- The model never receives generic terminal, file-write, browser, database-write,
  GitHub-write, or deployment tools. Existing disabled toolsets in
  `hermes/config.template.yaml` remain disabled.
- Credentials stay in Worker secrets or `/srv/hermes/app/env.local`; no secret
  values enter source, logs, artifacts, prompts, or Discord.

## Current Reusable Surfaces

- Discord slash interactions: `src/discord/webhook.ts`
- Natural mention/repository/branch selection: `src/discord/gateway-webhook.ts`
- Queue execution, recovery, and typing heartbeat: `src/discord/job.ts`
- Discord rendering and delivery: `src/discord/reply.ts`
- Shared Queue consumer and bindings: `src/worker.ts`, `wrangler.jsonc`
- Durable job/source-selection coordination: `src/telegram/session-coordinator.ts`
- Hermes session API client: `src/hermes/client.ts`
- Read-only GitHub plugin boundary: `hermes/plugins/poc-line-agent-github/`
- Runtime skill mirror: `src/skills/`, `hermes/skills/`
- Locked-down Hermes tool configuration: `hermes/config.template.yaml`

## Product Contract

### HIL artifact

Every capability produces a versioned artifact containing:

- artifact ID, capability, job/source identity, creation time, and status;
- human-readable summary;
- evidence and provenance;
- findings and explicit uncertainty;
- risks and severity;
- required human checks/actions;
- machine-readable metadata;
- a Markdown representation downloadable from Discord.

Artifacts must not contain secrets, full sensitive payloads, or unmasked PII.

### Job lifecycle

`queued -> running -> waiting_approval -> completed | failed | cancelled`

Each transition is idempotent. Progress is visible in Discord. Duplicate webhook,
Gateway, Queue, component, and event deliveries do not duplicate work or external
mutations.

### Discord surface

- `/code`: repository and branch investigation.
- `/risk`: implementation/deployment risk and Human Test Plan.
- `/db`: bounded read-only query.
- `/artifact`: screenshot or structured document generation.
- `/deploy`: approval-gated allowlisted deployment.
- `/status`: job/approval status.
- `/skills`: enabled capability and permission inventory.
- `/clear`: clear the current Hermes conversation.

Long work uses a Discord thread where possible. Progress updates are edited in
place, typing remains active during model work, and final artifacts are attached.

## Capability Requirements

### Risk Assessment

- Inputs: repository, target ref/PR, optional base ref, and release intent.
- Read the bounded diff plus relevant callers, tests, configuration, deployment,
  data, queue, and API surfaces.
- Identify blast radius, side effects, rollback concerns, and evidence gaps.
- Produce severity-ranked risks and a concrete Human Test Plan.
- Never infer deployment state from source alone.

### Queue Failure Event

- Accept a signed, size-bounded failure event or an existing DLQ message.
- Deduplicate by event/source identity.
- Sanitize payload, logs, entity references, retry history, and configuration.
- Correlate source evidence and recent change metadata where configured.
- Classify the likely category without claiming unsupported root cause.
- Publish a one-screen Discord summary plus a full HIL artifact.

### Ask Code

- Preserve explicit repository and any valid user-selected Git ref.
- Continue to clone/search the selected source rather than relying on GitHub code
  search snippets.
- Point to concrete files/symbols and distinguish registered behavior from dead,
  example, dependency, or unregistered code.
- Attach a code-investigation artifact.

### Ask Database

- Use a dedicated adapter/sidecar and dedicated read-only database credentials.
- Accept a single SELECT/CTE statement only; reject comments used to smuggle a
  second statement, mutation keywords, transaction control, and unsafe functions.
- Enforce allowlisted schemas/tables, server statement timeout, row/byte limit,
  and PII masking.
- Return query text/fingerprint, datasource alias, duration, row count, truncation,
  and result data as Discord summary plus CSV/JSON artifact.
- Remain disabled until a datasource allowlist and read-only credential are set.

### Ask for Artifact

- Generate Markdown, JSON, CSV, diagram text, and allowlisted-page screenshot.
- Screenshot execution runs on the existing OVH host in a sandboxed sidecar with
  SSRF protection, URL allowlist, no persisted browser profile, and strict time,
  response-size, and output-size limits.
- Deliver directly to Discord when size permits; no new paid storage is required.

### Deploy

- Targets and workflows are explicit allowlists configured outside prompts.
- Show immutable repository/ref/commit/environment and preflight/risk output.
- Create an approval ID bound to an operation digest and expiry.
- Only an authorized Discord user can approve; approvals are single-use.
- Execute through a narrow deployment adapter, not through a model-visible shell.
- Report deploy result and health check. Never auto-rollback unless that separate
  mutation is explicitly approved; always produce rollback guidance.

### Skill contract

Every enabled skill declares name, description, inputs, permissions, steps,
artifact type, verification, failure behavior, and demo fixture. A verifier fails
the build if a skill is not mirrored, lacks its artifact/verification contract,
or requests a capability outside the allowlist.

## Delivery Stories

1. HIL artifact contract and Discord attachment delivery.
2. Discord command/capability model, progress, threads, components, status, and
   approval persistence.
3. Ask Code artifact and Risk Assessment skill/read-only comparison evidence.
4. Signed Queue Failure event ingestion, classification, dedupe, and Discord HIL.
5. Read-only database sidecar/plugin plus `/db`.
6. Artifact/screenshot sidecar plus `/artifact`.
7. Approval-gated allowlisted deployment adapter plus `/deploy`.
8. Skill manifest/verifier, demo fixtures, documentation, production rollout,
   and full completion audit.

## Completion Criteria

- All commands are registered in the configured Discord guild and exercised by
  integration tests.
- Each capability produces its specified HIL artifact and a visible Discord result.
- Read-only and mutation boundaries have adversarial security tests.
- Queue/event, approval, recovery, duplicate-delivery, timeout, and failure paths
  are covered.
- Worker and Hermes suites, typecheck, formatting, dry-run, container builds,
  smoke tests, and production health checks pass.
- Production rollout touches only the approved Cloudflare account and existing OVH
  host, creates no paid resource, and has rollback evidence.


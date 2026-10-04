# Discord Company Operating Interface Test Specification

## HIL artifact

- Unit: required fields, version, statuses, evidence, risks, human actions,
  metadata bounds, deterministic Markdown, safe filenames, redaction.
- Delivery: Discord interaction/channel multipart upload, chunking, mention
  suppression, retry behavior, output limits, and artifact attachment exactly once.

## Discord orchestration

- Signed interaction and signed Gateway bridge validation.
- Authorization by user and guild before state, queue, or external calls.
- Command parsing/autocomplete for every capability.
- Thread creation fallback when threads are unavailable.
- Progress edit, typing heartbeat, component expiry, replay, cancellation, and
  concurrent-job behavior.
- `/status`, `/skills`, and `/clear` are deterministic and idempotent.

## Risk Assessment and Ask Code

- Source scope always contains the user-selected repository/ref.
- Compare/PR evidence is read-only, origin checked, bounded, and token-safe.
- Risk artifact includes blast radius, severity, evidence gaps, Human Test Plan,
  and no unsupported deployment claims.
- Existing code investigation behavior and recovery remain regression-covered.

## Queue Failure Event

- Reject missing, malformed, stale, or tampered signatures before JSON parsing.
- Reject oversized or malformed payloads and redact secrets/PII.
- Duplicate events create one job and one Discord artifact.
- Retry-exhausted and DLQ paths preserve evidence without recursive alerts.
- Missing optional logs/deploy metadata lowers confidence rather than fabricating.

## Database

- Allow valid SELECT and WITH...SELECT.
- Reject INSERT/UPDATE/DELETE/DDL/COPY/CALL/DO, multiple statements, transaction
  control, unsafe functions, comment smuggling, and invalid encodings.
- Enforce datasource/schema/table allowlist, timeout, row/byte limit, masking,
  audit record, and disabled-by-default configuration.
- Database role fixture proves write attempts fail independently of application
  validation.

## Artifact and screenshot

- Markdown/JSON/CSV outputs are deterministic and bounded.
- URL policy rejects non-HTTPS, credentials, redirects outside allowlist,
  localhost, link-local, RFC1918/private ranges, and oversized responses.
- Browser container is non-root/read-only/no-new-privileges, has no persistent
  profile, and terminates on time/output limits.
- Discord receives the artifact or an explicit size/error result.

## Deploy

- Reject unlisted project/environment/workflow/ref and mutable/ambiguous target.
- Approval digest binds exact operation and expires; wrong user, replay, modified
  payload, and concurrent approval are rejected.
- Preflight/risk failures prevent approval and execution.
- Model-facing tool inventory contains no deployment mutation tool.
- Adapter test covers success, health-check failure, transport uncertainty,
  non-retryable rejection, audit, and explicit rollback guidance.

## Skill contract

- Every source skill has a matching Hermes mirror and manifest.
- Every manifest declares permissions, artifact, verifier, failure behavior, and
  demo fixture.
- Verifier rejects unknown permissions, mutation capability without approval,
  missing mirror, missing demo, and unbounded output.

## End-to-end and production evidence

- Discord `/code`, `/risk`, `/db`, `/artifact`, `/deploy`, `/status`, `/skills`,
  `/clear` happy paths plus safe failure paths.
- Signed queue failure event produces one visible Discord HIL artifact.
- Worker full suite, TypeScript checks, formatter, Wrangler dry-run/startup check.
- Hermes unit/security/smoke tests and all sidecar builds/health checks run
  sequentially by service.
- `wrangler whoami` proves `pok.vip.08@gmail.com` immediately before deployment.
- Production Worker, Hermes, Discord Gateway, and enabled sidecar health checks pass;
  no unexpected public listener and no new paid Cloudflare resource exists.


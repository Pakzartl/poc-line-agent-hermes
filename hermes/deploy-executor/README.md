# Hermes Deploy Executor

Host-local deploy service for the OVH Hermes app. It lets the Worker request a
deploy without exposing the Docker socket to Cloudflare Workers.

The service only accepts one allowlisted public GitHub repository, one target,
and immutable 40-character commit SHAs.

## Environment

Add these values to `/srv/hermes/app/env.local` on the VPS:

```sh
DEPLOY_EXECUTOR_PORT=8790
DEPLOY_EXECUTOR_TOKEN=replace-with-32-byte-random-secret
DEPLOY_EXECUTOR_STATE_DIR=/srv/hermes/deploy-executor
DEPLOY_EXECUTOR_TARGETS_JSON=[{"id":"hermes-ovh","repo":"https://github.com/Pakzartl/poc-line-agent-hermes.git","appDir":"/srv/hermes/app","backupDir":"/srv/hermes/backups","healthUrl":"http://127.0.0.1:8642/health"}]
```

The Worker should call `http://127.0.0.1:8790/deploy` from a host-local bridge or
`https://<private-tunnel-host>/deploy` if a Cloudflare Access protected hostname
is configured. Keep the bearer token as a Worker secret.

## Request

```json
{
  "version": "DEPLOY_PLAN_V1",
  "planId": "deploy_...",
  "digest": "64-character-plan-digest",
  "repository": "Pakzartl/poc-line-agent-hermes",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "targetId": "hermes-ovh",
  "environment": "production",
  "requestedBy": "discord:123",
  "approvedBy": "discord:123"
}
```

The immutable plan id is also sent as the `Idempotency-Key` header.

## Runtime behavior

1. Rejects non-bearer or short-token requests.
2. Rejects repos, targets, and mutable refs outside the allowlist.
3. Clones the allowlisted repo and checks out exactly the requested commit.
4. Runs `docker compose config --quiet` against the staged compose file.
5. Backs up `/srv/hermes/app` to `/srv/hermes/backups`.
6. Copies the staged `hermes/` directory into `/srv/hermes/app` while preserving
   `env.local`.
7. Runs `docker compose up -d --build`.
8. Checks `http://127.0.0.1:8642/health`.
9. On failure, returns explicit restore commands and the backup path as rollback
   guidance. It never runs rollback automatically; rollback requires a separate
   approved mutation.

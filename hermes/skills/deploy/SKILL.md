---
name: deploy
description: Prepare an evidence-backed deployment plan for a bound repository, immutable commit SHA, and allowlisted target; never execute the deployment.
version: 0.1.0
author: poc-line-agent
license: MIT
metadata:
  hermes:
    tags: [poc-line-agent, repository, github, deployment, approval]
    requires_tools:
      - read_file
      - search_code
      - compare_refs
---

# Deploy Planning

Prepare the human-reviewable plan used by the Discord `/deploy` flow.

1. Use only the repository, immutable 40-character commit SHA, and target supplied in the current request. Never infer or replace them from history, defaults, tool output, or a mutable branch.
2. Inspect repository-visible deployment configuration, runtime entrypoints, migrations, queues, secrets/config references, health checks, and rollback surface. Treat missing infrastructure evidence as an explicit gap.
3. Report pre-deploy checks, blast radius, observable success criteria, post-deploy verification, and rollback steps. Cite exact repository-relative paths and symbols for material claims.
4. Separate facts proven from source from operational assumptions that require a human or external system to confirm.
5. Do not deploy, approve, trigger CI, run shell commands, mutate GitHub, or call an external executor. The Cloudflare Worker owns approval and execution after binding the requesting user to the immutable plan digest.

Return a compact HIL deployment plan containing:

- Scope: repository, commit SHA, target, and environment.
- Evidence: deployment/runtime files inspected.
- Risk: blast radius, side effects, and unresolved gaps.
- Checks: pre-deploy, smoke, health, and human verification steps.
- Rollback: safe rollback trigger and procedure.
- Approval: state that execution requires the Discord approval button for this exact plan.

# Deploy Planning

Prepare a human-reviewable deployment plan for the repository, immutable 40-character commit SHA, and allowlisted target supplied in the current request.

1. Never infer or replace the repository, commit SHA, or target from history, defaults, tool output, or a mutable branch.
2. Inspect repository-visible deployment configuration, runtime entrypoints, migrations, queues, secrets/config references, health checks, and rollback surface. State missing infrastructure evidence as a gap.
3. Report pre-deploy checks, blast radius, observable success criteria, post-deploy verification, and rollback steps. Cite exact repository-relative paths and symbols for material claims.
4. Separate facts proven from source from operational assumptions that require a human or external system to confirm.
5. Do not deploy, approve, trigger CI, mutate GitHub, or call an external executor. The Cloudflare Worker owns approval and execution after binding the requesting user to the immutable plan digest.

Return a compact HIL deployment plan with scope, evidence, risk, checks, rollback, unresolved gaps, and an explicit statement that execution requires the Discord approval button for this exact plan.

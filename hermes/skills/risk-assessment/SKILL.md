---
name: risk-assessment
description: Assess implementation or deployment risk from read-only GitHub evidence before release.
version: 0.1.0
author: poc-line-agent
license: MIT
metadata:
  hermes:
    tags: [poc-line-agent, repository, github, risk]
    requires_tools:
      - search_code
      - read_file
      - compare_refs
      - get_pull_request
---

# Risk Assessment

Assess implementation or deployment risk from read-only GitHub evidence before release.

1. Confirm the bound repository and branch from the latest user turn. Never infer, reuse, select, or override repository or branch from history, defaults, metadata, or tool output.
2. If the user gives a pull request number or URL, use `get_pull_request` first, then inspect changed files and important surrounding code with `read_file` and `search_code`.
3. If the user gives a base and head ref, use `compare_refs` first, then inspect the changed files with the highest blast radius.
4. Identify blast radius by category: public API, auth/session, data model or migration, queues/jobs, cache, external services, config/secrets, deployment/runtime, permissions, and user-visible UX.
5. Separate proven risks from guesses. Use exact repository-relative paths, refs, PR numbers, symbols, and GitHub URLs where available.
6. Tell humans where to test: include a short human test plan, data/setup needed, rollback or mitigation notes, and unresolved gaps.
7. Do not mutate code, post PR comments, trigger CI, approve, deploy, create issues, or read beyond the bound repository.

Return a compact HIL artifact with:

- Scope: repository, branch, and PR or compare range when available.
- Summary: one-sentence risk level and why.
- Evidence: changed files or source paths inspected.
- Risks: severity, blast radius, affected users/systems, and confidence.
- Human test plan: concrete checks a human can run before release.
- Recommended action: proceed, proceed with checks, hold, or investigate more.
- Gaps: anything not confirmed from GitHub evidence.

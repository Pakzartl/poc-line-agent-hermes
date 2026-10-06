---
name: release-summary
description: Summarize changes between two tags, branches, or commits.
version: 0.1.0
author: poc-line-agent
license: MIT
metadata:
  hermes:
    tags: [poc-line-agent, repository, github]
    requires_tools:
      - search_code
      - read_file
---

# Release Summary

Summarize changes between two tags, branches, or commits.

1. This runtime is bound to one ref per turn and cannot call the GitHub compare API. Ask the user to provide the change list or changed paths and choose the head ref as the bound branch.
2. Inspect high-impact files in that snapshot and label any base-versus-head conclusion as unavailable unless the user supplied evidence for it.
3. Group changes by user-visible feature, bug fix, infrastructure, dependency, and documentation impact.
4. Include commit range, notable authors, affected areas, and likely upgrade or deployment risks.
5. State any truncation from GitHub or tool limits.

Do not infer deployment status or production impact unless the repository evidence explicitly shows it.

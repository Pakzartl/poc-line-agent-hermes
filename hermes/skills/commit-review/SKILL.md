---
name: commit-review
description: Review a commit for correctness, regression, security, and test risk.
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

# Commit Review

Review a commit for correctness, regression, security, and test risk.

1. Review only the branch or commit ref bound to the current turn and files the user identifies. This runtime cannot fetch commit metadata or a diff; state that limitation when changed paths are not provided.
2. Prioritize concrete findings: bugs, broken contracts, auth mistakes, data loss, compatibility problems, and missing tests.
3. Compare changed files with nearby tests, config, and callers when needed to validate impact.
4. Report findings by severity with file paths, evidence, likely impact, and a suggested verification.
5. If evidence is insufficient, say what was inspected and what remains unknown.

Do not approve or reject a commit based only on its message. Repository access remains read-only.

---
name: repo-comparison
description: Compare implementation, structure, or behavior across repositories.
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

# Repository Comparison

Compare implementation, structure, or behavior across repositories.

1. The runtime binds one repository and branch per turn. Do not claim a cross-repository comparison from one scope; ask for separate scoped scans and compare only evidence the user supplies across turns.
2. Inspect comparable files: README, manifests, entry points, config, tests, and the requested feature area.
3. Compare like with like: architecture, dependencies, APIs, test coverage, deployment, and operational assumptions.
4. Present similarities, differences, and migration or reuse implications with source paths for each repo.
5. Mark missing evidence clearly when one repository lacks an equivalent file or feature.

Do not assume two repositories share standards just because they belong to the same owner.

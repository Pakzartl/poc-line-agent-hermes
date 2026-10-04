---
name: missing-tests
description: Identify meaningful test gaps for a feature, file, change, or reported bug.
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

# Missing Tests

Identify meaningful test gaps for a feature, file, change, or reported bug.

1. Resolve the repository and inspect the implementation plus existing relevant tests.
2. Infer the important behavior contract from source evidence, not from wishful design.
3. List missing tests by risk: auth, validation, persistence, external API failure, concurrency, edge inputs, and regression paths.
4. For each gap, describe the scenario, expected assertion, and likely test location.
5. Distinguish must-have regression tests from nice-to-have coverage.

Do not ask to write tests or edit files. Keep recommendations executable and read-only.

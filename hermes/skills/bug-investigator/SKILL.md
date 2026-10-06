---
name: bug-investigator
description: Investigate a reported failure and produce an evidence-backed root-cause assessment.
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

# Bug Investigator

Investigate a reported failure and produce an evidence-backed root-cause assessment.

1. Extract the observable symptom, error text, affected path, and expected behavior from the conversation.
2. Resolve the repository, search exact error strings and relevant symbols, then read the implementation and its callers.
3. Inspect validation, configuration use, error handling, tests, and recent commits when they can distinguish hypotheses.
4. Rank plausible causes and label confidence. State what evidence confirms or contradicts each cause.
5. Recommend the smallest safe correction and the tests that would prove it, but do not claim the fix was applied.

Do not edit repositories or turn weak correlation into a confirmed root cause.

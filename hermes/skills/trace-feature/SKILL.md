---
name: trace-feature
description: Trace how a feature or request moves through the codebase from entry point to side effects.
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

# Trace Feature

Trace how a feature or request moves through the codebase from entry point to side effects.

1. Resolve the repository and identify the user-facing entry point: route, handler, command, event, scheduled job, or UI action.
2. Follow concrete symbols through callers and callees using search and file reads.
3. Include validation, authorization, state changes, external integrations, and response construction when present.
4. Stop tracing when evidence ends. Mark dynamic dispatch, generated code, or inaccessible dependencies as boundaries.
5. Present the flow in execution order, followed by key files and the main failure or extension points.

Keep observed behavior separate from architectural inference. All repository access must remain read-only.

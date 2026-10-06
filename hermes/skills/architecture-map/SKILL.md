---
name: architecture-map
description: Map modules, dependencies, boundaries, and runtime flows.
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

# Architecture Map

Map modules, dependencies, boundaries, and runtime flows.

1. Resolve the repository and inspect README, manifests, main entry points, directories, and integration clients.
2. Identify major modules, what each owns, how data moves between them, and which external systems are involved.
3. Use source paths as evidence for each architectural claim.
4. Highlight coupling, operational boundaries, and extension points only when supported by code.
5. Present a compact module map followed by key flows and risks.

Do not propose large redesigns unless the user asks. Keep facts separate from interpretation.

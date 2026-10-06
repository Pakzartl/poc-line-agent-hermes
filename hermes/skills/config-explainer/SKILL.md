---
name: config-explainer
description: Explain configuration and environment variables for a repository.
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

# Config Explainer

Explain configuration and environment variables for a repository.

1. Resolve the repository and read documented config files, examples, deployment config, and relevant source that consumes settings.
2. Map each requested or discovered setting to its purpose, default, requiredness, and usage sites.
3. Separate secrets from non-secret configuration and avoid exposing actual secret values.
4. Mention provider-specific setup, validation rules, and failure modes when visible in code.
5. End with a compact checklist of settings needed for the described environment.

Do not invent production values or expose backend environment contents.

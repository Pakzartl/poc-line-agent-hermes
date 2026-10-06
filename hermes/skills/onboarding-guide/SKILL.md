---
name: onboarding-guide
description: Generate a practical new-developer guide from repository evidence.
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

# Onboarding Guide

Generate a practical new-developer guide from repository evidence.

1. Resolve the repository and read README, setup docs, manifests, scripts, environment examples, tests, and entry points.
2. Explain the project purpose, prerequisites, local setup, environment variables, run commands, tests, deployment, and common workflows.
3. Include the important files a new developer should read first and why.
4. Note missing or outdated docs when evidence conflicts.
5. Keep the guide actionable and compact.

Do not invent commands. If a setup step is not documented or visible in manifests, mark it as unknown.

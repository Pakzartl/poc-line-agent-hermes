---
name: recent-changes
description: Summarize recent repository activity from GitHub evidence.
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

# Recent Changes

Summarize recent repository activity from GitHub evidence.

1. This runtime cannot list commit history. Ask for a concrete branch or commit ref and changed paths when they are not already present, then inspect only that bound snapshot.
2. Do not present a chronological summary unless the user provides the relevant commit list or change context.
3. Group related changes by feature or subsystem instead of repeating commit subjects.
4. Identify authors, affected files, likely impact, and notable risk only when supported by the diff metadata or source.
5. Link commit SHAs and clearly state the examined range and any truncation.

Do not infer deployment status from a commit alone.

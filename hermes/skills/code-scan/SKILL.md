---
name: code-scan
description: Investigate an arbitrary codebase question on a user-selected repository and branch by tracing definitions, registrations, callers, tests, and configuration.
version: 0.1.0
author: poc-line-agent
license: MIT
metadata:
  hermes:
    tags: [poc-line-agent, repository, github, code-search]
    requires_tools:
      - search_code
      - read_file
---

# Code Scan

Investigate an arbitrary codebase question by scanning a user-selected GitHub branch and tracing repository evidence until the answer is supported.

1. The runtime binds the repository and branch from the first two fields of the latest user message. Never infer, reuse, select, or override source scope from history, defaults, metadata, or tool output.
2. State the bound repository and branch in the answer. `search_code` and `read_file` receive that scope from the runtime; provide only the search query or file path requested by their schemas.
3. Turn the question into several focused search concepts: exact symbols, behavior strings, framework registrations, configuration keys, filenames, and related terminology. Search precise alternatives rather than relying on one broad token.
4. Treat search results as leads, not conclusions. Read the relevant files and follow definitions, imports and exports, registrations, callers, entrypoints, tests, deployment files, and repository-visible infrastructure configuration. Use identifiers discovered in each pass to guide the next search.
5. For monorepos, identify all candidate applications, packages, services, and sibling entrypoints before making a repo-wide claim. When the user asks about every, all, or global behavior, compare all candidate locations instead of extrapolating from one application.
6. Separate active behavior from comments, dependencies, examples, dead code, and unregistered implementations. Those artifacts do not prove that behavior is enabled.
7. Stop expanding after two consecutive focused searches add no relevant files or relationships. Avoid duplicate searches and duplicate file reads.

Before saying something is absent, name the categories inspected. If coverage is incomplete, say `not confirmed` and identify the gap instead of saying it was not found.

Return a concise answer with the repository and ref, conclusion, exact evidence paths and symbols or lines when available, coverage, unresolved gaps, and confidence. Never expose credentials or raw authorization data.

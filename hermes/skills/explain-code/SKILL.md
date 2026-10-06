---
name: explain-code
description: Explain a file, function, module, or flow in plain language.
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

# Explain Code

Explain a file, function, module, or flow in plain language.

1. Resolve the repository and requested path, symbol, or behavior. If only a vague target is provided, search before explaining.
2. Read the relevant source file and nearby callers or tests when they change the meaning.
3. Describe what the code does, what inputs it expects, what it returns, and which side effects or external services it touches.
4. Call out important edge cases, error handling, and assumptions, but label inferences clearly.
5. Use repository-relative paths and line-oriented descriptions when possible so the user can verify the explanation.

Do not paraphrase code you have not read, and do not reveal secrets or environment values.

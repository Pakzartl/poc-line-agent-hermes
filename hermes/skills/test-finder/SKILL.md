---
name: test-finder
description: Find tests relevant to a feature, file, symbol, endpoint, or bug.
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

# Test Finder

Find tests relevant to a feature, file, symbol, endpoint, or bug.

1. Resolve the repository and target. Search for the target file name, exported symbols, route strings, and behavior keywords.
2. Separate direct unit tests, integration or end-to-end tests, fixtures, mocks, and unrelated examples.
3. Read the most relevant test files before claiming coverage.
4. Explain how each test connects to the target behavior and what command or suite name is implied when visible.
5. Mention important gaps only when supported by the files inspected.

Do not claim that no tests exist until you have searched both source-adjacent names and behavior keywords.

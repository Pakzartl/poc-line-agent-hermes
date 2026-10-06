---
name: pr-review
description: Review a GitHub pull request using read-only evidence.
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

# Pull Request Review

Review a GitHub pull request using read-only evidence.

1. Review only the branch bound to the current turn and changed paths the user supplies. This runtime cannot fetch PR metadata, a diff, comments, or CI status; state that limitation instead of inferring them.
2. Focus first on correctness, security, data integrity, backward compatibility, and test coverage.
3. Identify high-risk areas from the supplied paths and branch snapshot without inventing base-branch or author metadata.
4. Return actionable findings ordered by severity. Include paths and concise reasoning.
5. Summarize residual risk and tests that should be run or added.

Do not mutate the PR, post comments, approve, request changes, or infer CI status unless you read it from GitHub.

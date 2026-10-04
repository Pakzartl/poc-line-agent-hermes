---
name: dependency-check
description: Inspect dependencies, versions, and usage sites in a repository.
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

# Dependency Check

Inspect dependencies, versions, and usage sites in a repository.

1. Resolve the repository and read manifests such as package files, lockfiles, requirements, Gemfile, go.mod, Cargo.toml, or build config.
2. Search for imports or usage of the requested dependency, package family, or runtime integration.
3. Identify declared versions, direct versus transitive evidence, important scripts, and runtime entry points.
4. Note risk signals that can be proven from files: deprecated packages, duplicated libraries, missing lockfile, or unused-looking dependencies.
5. Recommend safe next checks, but do not claim a package is vulnerable without authoritative advisory evidence.

All repository access must stay read-only, and package manager commands are not available inside the target repository.

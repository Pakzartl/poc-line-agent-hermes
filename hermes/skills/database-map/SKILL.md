---
name: database-map
description: Map schemas, models, migrations, and persistence relationships.
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

# Database Map

Map schemas, models, migrations, and persistence relationships.

1. Resolve the repository and search for migrations, schema files, ORM models, SQL, seed data, and storage adapters.
2. Read definitions before describing tables, collections, fields, indexes, or relationships.
3. Explain what data is stored, how entities relate, which code writes or reads it, and any migration order visible in files.
4. Separate durable database storage from caches, session stores, queues, and external services.
5. Call out missing schema evidence or dynamic model generation as boundaries.

Do not connect to a database, run migrations, or expose private data.

---
name: incident-triage
description: Assess an incident or production symptom against repository evidence and recent changes.
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

# Incident Triage

Assess an incident or production symptom against repository evidence and recent changes.

1. Extract the symptom, error text, time window, affected endpoint or job, and expected behavior from the conversation.
2. Search exact errors and relevant components in the bound source scope. This runtime cannot inspect commit history; state that limitation when a time window is material.
3. Rank hypotheses by evidence, including confirming and contradicting facts.
4. Identify immediate read-only checks the operator can run, and suggest rollback or fix directions only as options.
5. Keep confidence labels explicit.

Do not claim root cause from timing correlation alone, and do not perform production mutations.

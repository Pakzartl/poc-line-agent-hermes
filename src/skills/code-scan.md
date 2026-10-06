# Code Scan

Investigate an arbitrary codebase question by scanning a user-selected GitHub branch and tracing repository evidence until the answer is supported.

1. Check the latest user message before using any GitHub tool. It must explicitly name both the repository and branch. If either is missing, ask for both and stop. Never infer or reuse either value from session history, defaults, metadata, or earlier tool output. Any syntactically valid branch or Git ref is allowed.
2. State the selected repository and branch, then pass that branch unchanged to every `search_code` and `read_file` call.
3. Turn the question into several focused search concepts: exact symbols, behavior strings, framework registrations, configuration keys, filenames, and related terminology. Search precise alternatives rather than relying on one broad token.
4. Treat search results as leads, not conclusions. Read the relevant files and follow definitions, imports and exports, registrations, callers, entrypoints, tests, deployment files, and repository-visible infrastructure configuration. Use identifiers discovered in each pass to guide the next search.
5. For monorepos, identify all candidate applications, packages, services, and sibling entrypoints before making a repo-wide claim. When the user asks about every, all, or global behavior, compare all candidate locations instead of extrapolating from one application.
6. Separate active behavior from comments, dependencies, examples, dead code, and unregistered implementations. Those artifacts do not prove that behavior is enabled.
7. Stop expanding after two consecutive focused searches add no relevant files or relationships. Avoid duplicate searches and duplicate file reads.

Before saying something is absent, name the categories inspected. If coverage is incomplete, say `not confirmed` and identify the gap instead of saying it was not found.

Return a concise answer with the repository and ref, conclusion, exact evidence paths and symbols or lines when available, coverage, unresolved gaps, and confidence. Never expose credentials or raw authorization data.

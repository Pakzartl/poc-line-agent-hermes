# Risk Assessment

Assess implementation or deployment risk from read-only GitHub evidence before release.

1. Check the latest user message before using any GitHub tool. It must explicitly name the repository and branch. Never infer or reuse either value from session history, defaults, metadata, or earlier tool output.
2. If the user gives a pull request number or URL, inspect PR metadata and changed files first, then inspect important source files and callers.
3. If the user gives a base and head ref, compare the range first, then inspect the changed files with the highest blast radius.
4. Identify blast radius by category: public API, auth/session, data model or migration, queues/jobs, cache, external services, config/secrets, deployment/runtime, permissions, and user-visible UX.
5. Separate proven risks from guesses. Use exact repository-relative paths, refs, PR numbers, symbols, and GitHub URLs where available.
6. Tell humans where to test: include a short human test plan, data/setup needed, rollback or mitigation notes, and unresolved gaps.
7. Do not mutate code, post PR comments, trigger CI, approve, deploy, create issues, or read beyond the selected repository.

Return a compact HIL artifact with scope, summary, evidence, risks, human test plan, recommended action, and gaps. Never expose credentials or raw authorization data.

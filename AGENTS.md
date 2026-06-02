# MakeADemo

## Project Introduction

`MakeADemo` helps builders turn a runnable web app, codebase context, and product description into a short demo video.

The codebase should remain minimal and adaptable while preserving clean seams between frontend UI, backend APIs, auth, persistence, integrations, and background processing.

## Product Stack

MakeADemo uses:

- Vite + React + TypeScript for the frontend
- Tailwind CSS for styling
- TanStack Query for server state, caching, loading states, and mutations
- TanStack Table for structured tables
- FastAPI for the backend
- Postgres for durable state
- Redis-backed workers for async jobs
- Clerk for authentication

Keep stack-specific code behind clear seams where practical. Avoid scattering vendor SDK calls, database access, queue logic, or auth logic through unrelated product code.

## Main Objectives

- Keep the codebase minimal: add the smallest correct module or interface that solves the current need.
- Keep the codebase aligned to the MakeADemo Pipeline: Context Gathering, Project Validation, Script Generation, Footage Capture, Compositing, and final output.
- Prefer deep modules: put meaningful product behavior behind small interfaces, and avoid shallow pass-through helpers.
- Maintain clear seams between pipeline stages, external services, persistence, sandbox execution, browser automation, and rendering.
- Preserve full test coverage for behavior that defines a seam, adapter, or user-visible flow.
- Prioritize readability: direct imports, explicit names, small files, and domain vocabulary over clever abstractions.

## Development Practice

Always use the `tdd` skill for code changes. Follow TDD best practices:

- Write one failing behavior test first.
- Implement the smallest change that makes that test pass.
- Refactor only after tests are green.
- Prefer tests through public interfaces and real seams rather than implementation details.
- Add regression tests for bugs before fixing them when a correct seam exists.
- When exporting a new interface, add a docstring that explains what implementations should do and the invariants they must uphold.
- Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run knip`, and `bun run graph:deps` before considering code changes complete.

## Testing Guidelines

- Test behavior through public interfaces and real seams; avoid tests that depend on private functions, storage internals, or incidental implementation order.
- Keep each test focused on one behavior. If a test needs many assertions, split it unless the assertions describe one observable flow.
- Prefer short setup helpers when they remove noise, but keep the behavior under test visible in the test body.
- Name tests as specifications of observable behavior, not implementation steps.
- Cover failure cases at seams: invalid lifecycle transitions, missing records, provider failures, malformed persisted data, sandbox failures, browser automation failures, and rendering failures.
- Use integration-style tests for core product flows where practical, especially pipeline orchestration, repo validation, script generation, capture, and compositing.
- Add regression tests before fixing bugs, and keep them focused on the bug's externally visible behavior.
- Avoid over-mocking. Use small fakes at external seams when real adapters would make the test slow, flaky, or dependent on network/auth state.
- Refactor tests after they pass: remove duplicated setup, split broad tests, and keep assertions specific enough to catch real regressions.

## Agent skills

### Domain docs

You should always take a look at this info in the beginning to facilitate better communication. This is a single-context repo. See `docs/agents/domain.md`.

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels. See `docs/agents/triage-labels.md`.

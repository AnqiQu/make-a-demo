# seed

## Project Introduction

`seed` is a minimal Bun/TypeScript coding-agent template. It is intended to be copied into new projects and adapted quickly, while keeping the core Agent independent from concrete storage, auth, model client, tool, and CLI decisions.

## Main Objectives

- Keep the codebase minimal: add the smallest correct module or interface that solves the current need.
- Keep the codebase extensible: make future Memory, model client, auth, and tool adapters easy to add without rewriting the Agent.
- Prefer deep modules: put meaningful behavior behind small interfaces, and avoid shallow pass-through helpers.
- Maintain clear seams: `*.interface.ts` files define stable interfaces; adapters provide concrete implementations; feature modules provide runtime behavior and orchestration.
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
- Cover failure cases at seams: invalid lifecycle transitions, missing records, provider failures, tool failures, malformed persisted data, and adapter boundary errors.
- Use integration-style tests for core flows where practical, especially Agent, Memory, Conversation, model, and tool interactions.
- Add regression tests before fixing bugs, and keep them focused on the bug's externally visible behavior.
- Avoid over-mocking. Use small fakes at external seams when real adapters would make the test slow, flaky, or dependent on network/auth state.
- Refactor tests after they pass: remove duplicated setup, split broad tests, and keep assertions specific enough to catch real regressions.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

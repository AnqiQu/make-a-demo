---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when building features, fixing bugs, writing integration tests, or making runtime-code changes.
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means like querying a database directly instead of using the interface. The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

## Anti-Pattern: Horizontal Slices

**Do not write all tests first, then all implementation.** This is horizontal slicing: treating RED as "write all tests" and GREEN as "write all code."

This produces brittle tests:

- Tests written in bulk test imagined behavior, not actual behavior.
- Tests end up checking the shape of things rather than user-facing behavior.
- Tests become insensitive to real changes: they pass when behavior breaks and fail when behavior is fine.
- You outrun your headlights by committing to test structure before understanding the implementation.

Correct approach: vertical slices via tracer bullets. One test, one implementation, then repeat. Each test responds to what you learned from the previous cycle.

```text
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED->GREEN: test1->impl1
  RED->GREEN: test2->impl2
  RED->GREEN: test3->impl3
```

## Workflow

### 1. Planning

When exploring the codebase, use the project's domain glossary so that test names and interface vocabulary match the project's language, and respect ADRs in the area you're touching.

Before writing runtime code:

- Confirm what interface changes are needed.
- Confirm which behaviors matter most when the user has not already made that clear.
- Identify opportunities for deep modules with small interfaces and meaningful implementations.
- Design interfaces for testability.
- List behaviors to test, not implementation steps.

Ask a short clarification question when behavior or interface expectations are genuinely ambiguous. Otherwise, proceed with the smallest useful tracer bullet.

### 2. Tracer Bullet

Write one test that confirms one behavior.

```text
RED:   Write test for first behavior; test fails.
GREEN: Write minimal code to pass; test passes.
```

This tracer bullet proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```text
RED:   Write next test; it fails.
GREEN: Minimal code to pass; it passes.
```

Rules:

- One test at a time.
- Only enough code to pass the current test.
- Do not anticipate future tests.
- Keep tests focused on observable behavior.

### 4. Refactor

After all tests pass, look for refactor candidates:

- Extract duplication.
- Deepen modules by moving complexity behind simple interfaces.
- Apply SOLID principles where natural.
- Consider what new code reveals about existing code.
- Run tests after each refactor step.

Never refactor while RED. Get to GREEN first.

## Checklist Per Cycle

```text
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

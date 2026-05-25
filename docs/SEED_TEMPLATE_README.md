# Seed

## Intro

`seed` is a minimal Bun/TypeScript coding-agent template. It provides a small reusable core Agent with replaceable seams for config, memory, model clients, auth token storage, conversation storage, and tools.

The included CLI is an implementation around the core, not the core product surface. It wires the Agent to Codex subscription auth, the OpenAI Responses API, JSONL conversation storage, and a small example math tool so the template can run end-to-end locally.

## Quickstart

```bash
bun install
bun run agent # run the CLI
```

On first run, the CLI starts a Codex OAuth flow and stores local state in `.agent/`, which is gitignored.

Useful commands:

```bash
bun run agent --headless-auth
bun run lint
bun run typecheck
bun run test
bun run knip
bun run arch:deps
bun run graph:deps
```

## Architecture

The architecture separates reusable agent behavior from concrete runtime choices:

```text
src/core/      Reusable agent kernel and public seams
src/adapters/  Concrete implementations of core seams
src/apps/cli/  Replaceable CLI app and its composition root
```

### Core

```text
src/core/
  agent/          Turn orchestration
  conversations/  Linear conversation lifecycle and replay context
  config/         Agent config interface and schema module
  memory/         Agent-facing memory interface
  model/          Model-client interface
  auth/           Token-store interface
  settings/       Model-facing Settings contract
  tools/          Tool interfaces, runtime seam, and registry
  errors/         Shared agent errors
```

Core owns:

- `Agent`, which records user messages, streams model output, executes tools, records tool results, and performs one recovery pass.
- `ConversationManager`, which creates/resumes conversations, records messages, updates settings, undoes turns, and builds replay context.
- `ToolRegistry`, which lists registered tool definitions and dispatches tool calls by exact name.

Public seams that extend the core include:

- `AgentMemory.interface.ts` for preparing model context and recording conversation events.
- `AgentConfigStore.interface.ts` for loading initial Agent defaults.
- `ModelClient.interface.ts` for streaming normalized model events.
- `ConversationRuntime.interface.ts` for conversation lifecycle, context reading, and recording seams.
- `ConversationStore.interface.ts` for persisting complete conversation records.
- `TokenStore.interface.ts` for local auth token persistence.
- `OAuthFlow.interface.ts` for provider OAuth login flows.
- `Tool.interface.ts` for executable model tools.
- `ToolRuntime.interface.ts` for the Agent-facing tool catalog and dispatcher.

Naming conventions:

- `*.interface.ts` files are type-only seams.
- `*.schema.ts` files export runtime validation schemas or schema constants.
- Runtime errors use explicit runtime names such as `AgentError.ts`.

### Adapters

```text
src/adapters/
  codex/          Codex auth and Responses model client
  file-system/    JSON config, JSONL conversations, and token storage
  memory/         Simple linear memory adapter
  tools/          Example tools
```

Included adapters are:

- `SimpleLinearMemory` is a placeholder `AgentMemory` implementation backed by one linear conversation timeline.
- `JsonAgentConfigStore` loads and validates `agent.config.json`.
- `JsonlConversationStore` stores conversations as JSONL records.
- `JsonFileTokenStore` stores local Codex auth tokens.
- `CodexModelClient` calls the Codex Responses endpoint.
- `CodexAuthClient` refreshes and exchanges Codex tokens.
- `MathTool` demonstrates adding a concrete tool.

Adapters depend only on public core interfaces, schemas, and runtime error values.

### CLI App

```text
src/apps/cli/
  main.ts                CLI loop and command dispatch
  composeCliRuntime.ts   CLI composition root
  CliRuntime.interface.ts
  commands.ts
  conversationHistory.ts
  conversationSelection.ts
  render.ts
```

The CLI app is replaceable. `composeCliRuntime.ts` is the CLI-owned composition root that creates concrete adapters and wires them to core modules. Other CLI presentation modules depend on CLI seams rather than importing core or adapters directly.

## Dependency Graphs

Dependency Cruiser enforces the module boundaries:

```bash
bun run arch:deps
```

The generated graphs live in `docs/`:

- `dependency-runtime-graph.svg` shows runtime/value imports.
- `dependency-type-graph.svg` shows type-only imports.

Regenerate them with:

```bash
bun run graph:deps
```

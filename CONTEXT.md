# seed Context

`seed` is a single-package Bun/TypeScript coding-agent template.

## Domain Terms

- **Agent**: The core orchestrator that runs turns through injected interfaces.
- **Interface**: A stable replaceable contract, such as memory, token storage, model client, or tool execution.
- **Schema module**: A public runtime validation boundary, named `*.schema.ts`, that exports schemas, codecs, or schema constants used to validate external data before it enters core types.
- **Runtime error module**: A public runtime error boundary, such as `AgentError.ts`, that exports error values callers construct or catch at runtime.
- **Adapter**: A concrete implementation of an interface shipped for local template use.
- **Feature module**: Runtime behavior or orchestration code, such as the Agent, ConversationManager, config loader, or CLI harness.
- **Conversation**: A user-facing chat history that can be resumed, displayed, and extended.
- **Memory**: The agent-facing module that prepares model context and records conversation events. The Agent must not depend on JSONL or another concrete conversation implementation directly.
- **Agent defaults**: The current system prompt, Settings, and tool catalog supplied to the Agent runtime as standard agent inputs, without requiring them to be collapsed into one core module.
- **Settings**: Latest model settings for a conversation.
- **Tool catalog**: The tools available to the Agent, including their names, descriptions, and input schemas.
- **CLI harness**: The runnable command used for local E2E development, not the stable downstream product interface. It owns CLI composition and can be replaced by a more robust app around core.
- **CLI composition**: The CLI-owned module that wires core modules to concrete adapters. Presentation modules in the CLI should depend on CLI seams, not on core or adapters directly.
- **KV cache optimization**: A core design goal of preserving stable model request prefixes across turns so model providers can reuse cached attention state.

## Architectural Intent

Keep the core library modular and dependency-injected. Concrete file stores and the Codex model client exist to make the template runnable, but downstream projects should be able to replace them without changing agent orchestration.

Core interfaces should support KV cache optimization as much as possible without over-specifying provider behavior or reducing adapter flexibility.

When a Conversation is resumed, core should explicitly decide how current Agent defaults are applied rather than leaving that behavior to adapters.

Resumed Conversation sync policy belongs in Conversation lifecycle core modules, not in the CLI harness, Agent turn orchestration, or Memory adapters.

Every path that makes an existing Conversation active should share one Conversation activation flow so current system prompt and Settings are applied consistently.

Core should treat the tool catalog as structured Agent defaults. Model client adapters remain responsible for serializing tools through each provider's dedicated tool protocol rather than treating tools as ordinary prompt text.

The CLI harness is an implementation wrapped around core. Keep CLI composition in `src/apps/cli`, and keep reusable Agent behavior in `src/core` so another app can replace the CLI without carrying CLI-specific wiring.

Use `*.interface.ts` only for type-only seams. Public runtime validation belongs in `*.schema.ts`, and public runtime error values should use explicit runtime names such as `AgentError.ts` rather than the broader term "contract".

# MakeADemo Context

`MakeADemo` is a single-package Bun/TypeScript product for generating short demo videos from runnable web apps, codebase context, and product descriptions.

## Domain Terms

- **MakeADemo Pipeline**: The linear product flow that turns a submitted project into a demo video through intake, validation, script generation, footage capture, and compositing.
- **Context Gathering**: The stage where the maker submits the GitHub repo URL and key product features to demo.
- **Project Intake**: The data captured during Context Gathering.
- **Project Validation**: The stage where MakeADemo verifies that the submitted project satisfies the demo run contract and is capturable in a browser.
- **Demo Run Contract**: The requirement that the submitted repo can start a deterministic browser-accessible demo inside an isolated sandbox, with no inbound or outbound network communication across the sandbox boundary after dependency installation.
- **MakeADemo Config**: A `makeademo.config.json` file in the submitted repo that is the source of truth for the demo command and local URL MakeADemo should validate.
- **Sandbox**: The isolated execution environment that runs the submitted app, Playwright validation, and Playwright capture with the network boundary sealed after dependency installation.
- **Script Generation**: The stage where MakeADemo turns validated project context and key product features into a Video Script.
- **Video Script**: A structured plan for the demo video that organizes what the video will communicate over time.
- **Script Section**: A top-level part of the Video Script, such as intro, feature demonstration, or use case, that groups related scenes.
- **Scene Description**: A script item that summarizes one web-based scene and lists the browser actions needed to capture it.
- **Browser Action**: One explicit interaction or wait condition in a Scene Description, such as clicking a button, typing into an input, or waiting for streamed output to finish.
- **Capture Script**: A Playwright script generated from a Scene Description that performs the Browser Actions needed to record its Scene.
- **Scene**: The raw captured video clip produced by running a Scene Description's Capture Script in a Docker sandbox.
- **Companion Video**: The user-facing view of a Scene shown alongside its Scene Description during review.
- **Footage Capture**: The stage where MakeADemo records raw browser footage needed by the approved script.
- **Compositing**: The stage where MakeADemo assembles captured footage into the final demo video with text, transitions, and other presentation effects.

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

## Relationships

- The **MakeADemo Pipeline** runs linearly from **Context Gathering** to **Project Validation**, **Script Generation** with **Footage Capture**, **Compositing**, and final output.
- **Project Validation** and **Footage Capture** run Playwright inside the **Sandbox** rather than from the backend host.
- **MakeADemo Config** supplies the demo command and local URL used by **Project Validation**.
- A **Video Script** contains one or more **Script Sections**, and each **Script Section** contains one or more **Scene Descriptions**.
- A **Scene Description** contains one or more **Browser Actions**.
- A **Capture Script** mirrors the Browser Actions in one Scene Description.
- Each **Scene Description** maps to exactly one **Scene** during **Footage Capture**.
- Each **Scene Description** has one **Scene**, shown to the user as its **Companion Video** and later used by **Compositing**.

## Architectural Intent

Keep the core library modular and dependency-injected. Concrete file stores and the Codex model client exist to make the template runnable, but downstream projects should be able to replace them without changing agent orchestration.

Core interfaces should support KV cache optimization as much as possible without over-specifying provider behavior or reducing adapter flexibility.

When a Conversation is resumed, core should explicitly decide how current Agent defaults are applied rather than leaving that behavior to adapters.

Resumed Conversation sync policy belongs in Conversation lifecycle core modules, not in the CLI harness, Agent turn orchestration, or Memory adapters.

Every path that makes an existing Conversation active should share one Conversation activation flow so current system prompt and Settings are applied consistently.

Core should treat the tool catalog as structured Agent defaults. Model client adapters remain responsible for serializing tools through each provider's dedicated tool protocol rather than treating tools as ordinary prompt text.

The CLI harness is an implementation wrapped around core. Keep CLI composition in `src/apps/cli`, and keep reusable Agent behavior in `src/core` so another app can replace the CLI without carrying CLI-specific wiring.

Use `*.interface.ts` only for type-only seams. Public runtime validation belongs in `*.schema.ts`, and public runtime error values should use explicit runtime names such as `AgentError.ts` rather than the broader term "contract".

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
- **Video Script Package**: The handoff artifact produced by Script Generation before footage capture begins, containing the Video Script, Script Sections, Scene Descriptions, Browser Actions, and validation context.
- **Script Section**: A top-level part of the Video Script, such as intro, feature demonstration, or use case, that groups related scenes.
- **Scene Description**: A script item that summarizes one web-based scene and lists the browser actions needed to capture it.
- **Browser Action**: One explicit interaction or wait condition in a Scene Description, such as clicking a button, typing into an input, or waiting for streamed output to finish.
- **Capture Script**: A Playwright script generated from a Scene Description that performs the Browser Actions needed to record its Scene.
- **Scene**: The raw captured video clip produced by running a Scene Description's Capture Script in a Docker sandbox.
- **Companion Video**: The user-facing view of a Scene shown alongside its Scene Description during review.
- **Footage Capture**: The stage where MakeADemo records raw browser footage needed by the approved script.
- **Compositing**: The stage where MakeADemo assembles captured footage into the final demo video with text, transitions, and other presentation effects.

- **Pipeline Stage**: One user-visible step in the MakeADemo Pipeline with clear inputs, outputs, and failure states.
- **Pipeline Job**: One execution of the MakeADemo Pipeline for a submitted project.
- **External Seam**: A stable boundary around infrastructure or third-party behavior, such as sandbox execution, browser automation, model calls, artifact storage, auth, or rendering.
- **Schema Module**: A public runtime validation boundary, named `*.schema.ts`, that exports schemas, codecs, or schema constants used to validate external data before it enters product types.

## Relationships

- The **MakeADemo Pipeline** runs linearly from **Context Gathering** to **Project Validation**, **Script Generation** with **Footage Capture**, **Compositing**, and final output.
- **Project Validation** and **Footage Capture** run Playwright inside the **Sandbox** rather than from the backend host.
- **MakeADemo Config** supplies the demo command and local URL used by **Project Validation**.
- A **Video Script** contains one or more **Script Sections**, and each **Script Section** contains one or more **Scene Descriptions**.
- A **Video Script Package** is the handoff from Script Generation to Footage Capture.
- A **Scene Description** contains one or more **Browser Actions**.
- A **Capture Script** mirrors the Browser Actions in one Scene Description.
- Each **Scene Description** maps to exactly one **Scene** during **Footage Capture**.
- Each **Scene Description** has one **Scene**, shown to the user as its **Companion Video** and later used by **Compositing**.

## Architectural Intent

Organize product code around the linear MakeADemo Pipeline.

Keep pipeline stages explicit and testable. Each stage should expose clear inputs, outputs, failure states, and dependencies on external seams.

Keep infrastructure-specific code behind seams so sandbox execution, browser automation, model providers, artifact storage, auth, persistence, and rendering can evolve without rewriting pipeline orchestration.

Use `*.interface.ts` for type-only seams when a boundary has multiple implementations or external behavior. Public runtime validation belongs in `*.schema.ts`.

# MakeADemo Stage 1 PRD

## Problem Statement

Makers need a fast way to turn a JavaScript/TypeScript web app into the foundation of a demo video, but most repos are not immediately safe or deterministic enough for MakeADemo to run and capture. They may depend on secrets, hosted databases, external APIs, OAuth, remote assets, or manual setup. If MakeADemo tries to infer and repair arbitrary project setup, the product becomes expensive, unreliable, and permission-heavy before proving the core workflow.

Makers also need a clear way to provide enough product context for a useful demo script without filling out a long production brief. For Stage 1, MakeADemo should guide the maker to prepare their repo, validate that it is runnable inside an isolated sandbox, then generate a read-only Video Script with one raw Scene per Scene Description.

## Solution

MakeADemo Stage 1 starts with a preparation-first flow. Before submitting repo details, the maker receives a copy-paste prompt for their own coding agent. That prompt asks the coding agent to add a deterministic demo run command and a tiny MakeADemo Config file to the repo. The maker then submits the GitHub repo URL and key product features to demo.

MakeADemo clones the repo, reads the MakeADemo Config, installs dependencies using lockfile-based package manager inference, seals the sandbox network boundary, runs the demo command, and validates the app with Playwright inside the sandbox. Validation is programmatic and LLM-free. Any inbound or outbound network communication across the sandbox boundary after dependency installation is a hard failure.

After Project Validation succeeds, MakeADemo generates a read-only Video Script organized into Script Sections and Scene Descriptions. Each Scene Description includes Browser Actions and a generated Playwright Capture Script. MakeADemo runs each Capture Script inside the sandbox to produce one raw Scene, displayed to the user as a Companion Video alongside its Scene Description.

## User Stories

1. As a maker, I want to see a preparation prompt before entering repo details, so that I know exactly how to make my repo compatible with MakeADemo.
2. As a maker, I want to paste the preparation prompt into my coding agent, so that my own tools can add the demo command without MakeADemo modifying my repo.
3. As a maker, I want the preparation prompt to explain the Demo Run Contract, so that I understand why external services and secrets cannot be required.
4. As a maker, I want the preparation prompt to ask for a single demo command, so that the repo has one obvious entry point for MakeADemo.
5. As a maker, I want the preparation prompt to ask for a tiny MakeADemo Config, so that MakeADemo knows which command and URL to validate.
6. As a maker, I want the MakeADemo Config to stay small, so that I do not need to learn a complex configuration format.
7. As a maker, I want to submit only a GitHub repo URL and key product features after preparing the repo, so that intake stays quick.
8. As a maker, I want MakeADemo to read the demo command from the MakeADemo Config, so that I do not need to retype configuration that already lives in the repo.
9. As a maker, I want MakeADemo to read the local URL from the MakeADemo Config, so that browser validation opens the intended app page.
10. As a maker, I want MakeADemo to validate my repo programmatically, so that I get deterministic feedback before any script generation happens.
11. As a maker, I want validation to avoid LLM API calls, so that validation remains cheap and repeatable.
12. As a maker, I want dependency installation to use the network when needed, so that normal JavaScript/TypeScript package installation works.
13. As a maker, I want demo runtime to be offline after dependency installation, so that demos do not depend on hosted services.
14. As a maker, I want validation to fail on external runtime requests, so that the generated demo is deterministic and safe to capture.
15. As a maker, I want MakeADemo to explain blocked network requests, so that I know what my coding agent needs to mock or remove.
16. As a maker, I want validation to run in an isolated sandbox, so that untrusted submitted code is contained.
17. As a maker, I want Playwright to run inside the sandbox, so that validation and capture do not require network access into the sandbox from the backend host.
18. As a maker, I want MakeADemo to infer the install command from standard lockfiles, so that I do not need to configure dependency installation.
19. As a maker, I want repos without lockfiles to be allowed with a warning, so that early projects can still be evaluated.
20. As a maker, I want validation to fail if no JavaScript/TypeScript package manifest exists, so that the product scope is clear.
21. As a maker, I want validation to confirm the app loads in a browser, so that script and capture generation are based on a reachable web app.
22. As a maker, I want validation to reject blank pages and framework error screens, so that later output is not based on broken footage.
23. As a maker, I want validation to capture screenshot proof, so that I can see what MakeADemo was able to load.
24. As a maker, I want validation logs and failure reasons, so that I can fix the repo with my coding agent.
25. As a maker, I want MakeADemo to generate a Video Script only after validation succeeds, so that the script is grounded in a runnable app.
26. As a maker, I want the Video Script to be organized into Script Sections, so that the structure of the demo is easy to understand.
27. As a maker, I want each Script Section to contain Scene Descriptions, so that I can see the sequence of the demo.
28. As a maker, I want each Scene Description to summarize one web-based scene, so that I understand what that raw Scene will show.
29. As a maker, I want each Scene Description to include Browser Actions, so that I can understand how MakeADemo intends to interact with the app.
30. As a maker, I want each Browser Action to be readable, so that I can audit the intended clicks, typing, and waits.
31. As a maker, I want MakeADemo to generate a Capture Script for each Scene Description, so that raw Scene footage can be produced from the script plan.
32. As a maker, I want each Scene Description to map to exactly one Scene, so that I know exactly how many clips MakeADemo will shoot.
33. As a maker, I want each Scene to appear as a Companion Video, so that I can review the raw footage alongside the script.
34. As a maker, I want Stage 1 script output to be read-only, so that the first buildout can avoid premature editing semantics.
35. As a maker, I want later buildout to add script editing and compositing, so that Stage 1 can stay focused on repo readiness, script generation, and raw footage.
36. As a MakeADemo operator, I want submitted repos to be JavaScript/TypeScript web apps in V1, so that sandbox images, install inference, and validation behavior stay tractable.
37. As a MakeADemo operator, I want the Demo Run Contract to forbid secrets and external services, so that validation and capture do not depend on user-specific infrastructure.
38. As a MakeADemo operator, I want artifacts to be copied out after sandbox execution, so that runtime isolation is preserved.
39. As a MakeADemo operator, I want validation failures to be explicit and structured, so that they can drive helpful user-facing messages and future issue triage.
40. As a MakeADemo operator, I want the preparation prompt to avoid asking MakeADemo to modify user repos, so that GitHub permissioning, branch management, and PR UX stay out of Stage 1.

## Implementation Decisions

- Build product modules around the MakeADemo Pipeline stages rather than around infrastructure capabilities.
- Context Gathering collects the GitHub repo URL and key product features to demo.
- The preparation prompt appears before repo submission and asks the maker's coding agent to add a compatible demo command and MakeADemo Config.
- The MakeADemo Config is the source of truth for validation command and URL.
- The MakeADemo Config is deliberately tiny in V1 and requires only `demoCommand` and `url`.
- The Demo Run Contract requires a deterministic browser-accessible demo inside an isolated sandbox.
- Dependency installation may use network access.
- After dependency installation, all inbound and outbound communication across the sandbox boundary is blocked and treated as a hard validation failure.
- Project Validation is programmatic and does not use LLM API calls.
- Project Validation runs in backend Docker sandboxes, not in the web server process, the maker's browser, or a local-only CLI architecture.
- Playwright validation and capture run inside the Sandbox rather than from the backend host.
- Artifacts such as screenshots, logs, and raw Scene footage are copied out after sandbox execution rather than fetched over the network during runtime.
- V1 supports JavaScript/TypeScript web apps with `package.json` and standard JS package managers.
- Dependency installation is inferred from lockfiles: Bun, pnpm, Yarn, npm lockfile, then npm fallback.
- Repos without lockfiles are allowed with a validation warning rather than rejected.
- Project Validation must confirm that the configured URL loads in a browser, is not blank, avoids obvious runtime/framework error screens, and is interactable enough for browser capture.
- Script Generation runs only after Project Validation succeeds.
- The Video Script is read-only in Stage 1.
- A Video Script contains Script Sections.
- A Script Section contains Scene Descriptions.
- Each Scene Description contains Browser Actions and maps to exactly one Scene.
- Each Scene Description gets one generated Playwright Capture Script.
- Each Scene is raw captured video generated by running the Capture Script in the Sandbox.
- Each Scene is shown to the user as a Companion Video.
- Compositing, script editing semantics, and production-ready transitions/effects are deferred to later buildout.
- Deep modules to build include Preparation Prompt Generator, MakeADemo Config schema/loader, Project Intake, Install Plan inference, Sandbox Runner, Network Isolation Policy, Project Validation, Browser Validation, Artifact Store, Script Generator, Capture Script Generator, Scene Recorder, and Pipeline Job Orchestrator.
- Preparation Prompt Generator should expose a simple interface that returns the prompt text from the current Demo Run Contract.
- MakeADemo Config schema/loader should expose a small validation boundary for reading and validating `demoCommand` and `url`.
- Install Plan inference should expose a simple repo-inspection interface that returns the install command and warnings.
- Sandbox Runner should encapsulate clone/install/runtime isolation/artifact extraction behind a small job interface.
- Network Isolation Policy should make runtime network blocking explicit and testable.
- Project Validation should return structured success/failure results, logs, warnings, screenshots, and blocked network attempts.
- Browser Validation should encapsulate Playwright page-load, blank-page, runtime-error, screenshot, and interactability checks.
- Script Generator should consume validated project context and key product features and return a structured Video Script.
- Capture Script Generator should consume Scene Descriptions and produce Playwright Capture Scripts.
- Scene Recorder should run Capture Scripts in the Sandbox and return Scene artifacts.
- Pipeline Job Orchestrator should coordinate the linear flow without owning the implementation details of each deep module.

## Testing Decisions

- Tests should verify external behavior through public interfaces and real seams, not private implementation details.
- Good tests should describe observable outcomes such as generated preparation prompts, config validation failures, install inference warnings, validation failures, and produced script structures.
- Preparation Prompt Generator should be tested for required contract content without snapshotting incidental formatting too tightly.
- MakeADemo Config schema/loader should be tested for valid minimal config, missing required fields, invalid local URL values, and extra-field tolerance or rejection depending on the chosen schema behavior.
- Install Plan inference should be tested across Bun, pnpm, Yarn, npm lockfile, and package-only fallback cases.
- Project Validation should be tested with fake sandbox adapters that simulate install success, install failure, command failure, page-load failure, blocked network attempts, blank pages, runtime error pages, and successful validation.
- Network Isolation Policy should be tested as a pure boundary decision where any post-install sandbox-boundary network attempt fails validation.
- Browser Validation should be tested with Playwright-style fakes or integration fixtures that prove the validator distinguishes reachable pages, blank pages, and obvious framework/runtime errors.
- Artifact Store should be tested through public artifact write/read/list behavior for logs, screenshots, and Scene videos.
- Script Generator should be tested for producing Video Scripts organized into Script Sections and Scene Descriptions from key product features and validated project context.
- Capture Script Generator should be tested for producing one Capture Script per Scene Description with Browser Actions represented in a way the Scene Recorder can consume.
- Scene Recorder should be tested with a fake Sandbox Runner to ensure each Scene Description produces exactly one Scene artifact or a structured capture failure.
- Pipeline Job Orchestrator should be tested through an integration-style happy path and representative failure paths, using fakes at external seams rather than mocking internal functions.
- Prior test patterns in the current codebase include focused behavior tests for core seams, adapter boundary tests, and CLI flow tests; Stage 1 tests should follow that integration-through-public-interface style.

## Out of Scope

- Non-JavaScript/TypeScript repos.
- Mobile apps, desktop apps, API-only projects, and CLI-only projects.
- Voiceover videos.
- Directly modifying maker repos, creating branches, opening pull requests, or committing fixes on behalf of users.
- LLM-based validation of repo runnability.
- External APIs, hosted databases, OAuth, paid services, secrets, or manual setup during demo runtime.
- Script editing by the user.
- Fine-grained user control over Playwright Capture Scripts.
- Multiple autonomous capture sub-agents.
- Bare-bones final video compositing.
- Production-ready compositing with polished text, transitions, effects, and timeline editing.
- Supporting arbitrary package manager or language runtime installation beyond standard JavaScript/TypeScript package manager inference.

## Further Notes

- This PRD follows ADRs 0005 through 0011 and the current MakeADemo glossary.
- The initial buildout should remain stage-first while extracting deep capability modules behind small interfaces.
- The preparation-first flow is central: MakeADemo explains the Demo Run Contract before asking for repo details.
- Validation is a gate before any expensive LLM work.
- The tiny MakeADemo Config keeps repo preparation clear and avoids configuration sprawl.
- Future buildout can add script editing semantics and compositing once Stage 1 proves repo preparation, validation, script generation, and raw Scene capture.

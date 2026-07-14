# 0020 Use an Artifact-Driven Agent Harness

## Status

Accepted, amended 2026-07-10

### External resource replay amendment (2026-07-14)

Runtime Network Lockdown continues to physically block submitted-app egress. App Exploration and Capture Path Validation may inventory credential-free public HTTPS GET requests and ask a backend-owned hydrator to snapshot eligible browser resources into a content-addressed External Resource Cache. App Exploration, Capture Path Validation, and Footage Capture fulfill exact cached URLs from hash-verified local bytes; they never reopen Sandbox networking for replay.

Uncached traffic remains blocked and is retained as validation evidence. A suppressed request is not by itself proof that a demo is broken: observable page, feature, action, and resource-hydration failures determine whether repair is required. Authenticated requests, mutations, private destinations, and WebSockets are never hydrated. This preserves original product assets without asking Repo Preparation to remove or substitute presentation code.

## Amendment

The original decision remains valid about durable artifacts, backend-owned validation, stage-specific agent work, and the separation between agent and submitted-code sandboxes. Its earlier description of a generated Playwright script as part of the agent-facing contract is no longer optimal and is superseded by this amendment.

In particular, the current architecture does not ask an agent to author `demoPlaywrightScript`, does not treat Capture SDK source as the agent's primary output, and does not assume that every Scene is browser footage. The backend now compiles grounded, typed Browser Actions into the versioned Capture SDK and Playwright program. Demo Scripts may also contain compositor-native Synthetic Scenes.

Legacy parsers may continue accepting earlier raw-script artifacts for compatibility. That compatibility is not the current generation contract and must not be presented to agents as an allowed shortcut.

### Feature completeness and narrative assembly amendment (2026-07-12)

The Preparation Manifest now contains source-backed Product Context and a Feature Inventory. Repo Preparation must map every maker-requested feature exactly once, retain its submitted text, cite screened repository source paths, provide local browser entry paths, and record whether the ephemeral demo runtime uses no authentication preparation, a demo-only bypass, or a deterministic demo identity. App Exploration visits those feature entry paths before ordinary link crawling and tags observed routes and Action Catalog actions with their prepared feature IDs. Unexpected authentication walls, including same-route login forms, and missing requested feature evidence route back to Repo Preparation Repair; authentication UI remains observable when signing in is itself requested.

Flow Spec is feature-scoped rather than a single preferred-flow summary. When the maker provides features, a successful Flow Spec contains exactly that normalized set with no skipped or convenience-based omissions. When the maker provides none, Flow Planning selects up to three source-backed features with grounded browser evidence. Every selected feature must retain distinguishing Action Catalog evidence.

The Script Writer emits feature-tagged Browser Scenes. The backend owns Demo Narrative Assembly and deterministically inserts a product intro, one Full-Screen Text Scene before each selected feature, and a product outro. Script Repair cannot remove requested features or these structural Scenes. Typed scrolling is part of the Browser Action vocabulary; the backend compiles its fixed implementation, so agents still cannot author arbitrary page JavaScript.

## Context

MakeADemo must turn an untrusted submitted web app into a validated, capture-ready Demo Script without allowing an agent to self-certify success. Repo Preparation, exploration, flow planning, Script Generation, validation, capture, and rendering need durable handoffs so a failed stage can be diagnosed or retried without depending on hidden model-session state.

Allowing the Script Writer to emit arbitrary Playwright creates an unnecessarily broad executable-code boundary. It also duplicates backend concerns such as Capture SDK syntax, marker lifecycle, browser ownership, humanized interactions, runtime network controls, and supported Playwright version. App exploration already produces an App Map and Action Catalog, while Flow Planning selects evidence-backed actions. The safer and more deterministic handoff is therefore a typed action plan that the backend compiles.

The final video timeline is broader than browser automation. Intro cards, interstitial text, and trusted static images do not need a browser or a captured clip. Treating these as fake Playwright scenes would add failure modes and obscure which stages own their rendering.

## Decision

MakeADemo will use a backend-owned, artifact-driven agent harness from Context Intake through Capture Path Validation.

The harness runs these stages in order:

Context Intake -> Static Repo Security Screen -> Repo Profiler -> Run Plan Synthesis -> Repo Preparation Agent Loop -> Preparation Preflight Validation -> App Exploration -> Flow Planning -> Script Writing -> Static Script Contract Validation -> Dynamic Capture Path Validation -> Repair Router -> Script Repair or Repo Preparation Repair -> Final Artifacts.

Every meaningful handoff is a typed JSON artifact. The core artifacts are `RepoProfile`, `RunPlan`, `PreparationManifest`, `ValidationReport`, `AppMap`, `ActionCatalog`, `FlowSpec`, `DemoScriptContract`, `ScriptCandidate`, and `PipelineRunManifest`.

Repo Preparation and Script Generation are separate contracts. Repo Preparation may mutate the ephemeral submitted workspace and must emit a validated `PreparationManifest`. App Exploration, Flow Planning, Script Writing, Script Repair, and Capture Path Validation consume durable artifacts and must not depend on hidden OpenCode session memory for correctness.

App Exploration and Flow Planning happen before Script Writing. The Script Writer may only select flows grounded in the running prepared app, App Map, Action Catalog, and Flow Spec.

OpenCode remains the agent runtime. Reusing an OpenCode session across stages is allowed as a context cache, but OpenCode memory is never the source of truth. Prompts are stage-specific and artifact-path-oriented.

### Demo Script contract

The agent-facing output path is exactly `/workspace/.makeademo/demo-script.json`. The current Demo Script is declarative JSON with an ordered list of explicitly typed Scenes:

- A `playwright-recording` Browser Scene declares typed Browser Actions and an expected visible outcome. Its optional human-readable description is explanatory metadata, not executable behavior.
- A `full-screen-text` Synthetic Scene declares text, styling, background color, and duration.
- A `static-image` Synthetic Scene declares a trusted asset identifier, alternative text, and duration. The backend resolves the identifier through an explicit asset registry; the agent cannot supply an arbitrary file path or URL.

Optional `setupActions` prepare browser state off camera before Browser Scenes begin. On-camera Browser Actions carry stable action identifiers and source-action references so validators can prove that they correspond to Action Catalog evidence selected by the Flow Spec. Each Browser Scene includes an explicit visible assertion action.

The backend validates the Demo Script JSON, evidence grounding, supported action and locator vocabulary, local-only navigation, Scene ordering, and presentation constraints. It then compiles Setup Actions and Browser Actions into the versioned Capture SDK and Playwright program. The compiler, not the agent, owns Capture SDK imports, setup and Scene wrappers, step markers, browser lifecycle, assertion instrumentation, humanized interactions, and generated source formatting.

Current Script Writing and Script Repair must not return `demoPlaywrightScript`. A derived `demoPlaywrightScript` may exist inside a parsed or runtime value after backend compilation, but it is not agent-authored source and is not the durable current-generation handoff.

Presentation music, text overlays, and transitions are optional. Omitted transitions mean direct adjacency in timeline order. Synthetic Scenes are first-class timeline entries and do not need Browser Actions, Playwright assertions, or captured video files.

### Validation and execution

Static Script Contract Validation checks the declarative Demo Script before any browser execution. It verifies the strict JSON shape, current contract versions, grounded action references, meaningful Browser Scenes, local-only paths, safe presentation inputs, and the absence of agent-authored browser source.

The backend compiles the validated browser plan and runs Dynamic Capture Path Validation through the same Capture SDK and Playwright path used by Footage Capture. Validation runs only the Browser Scene subset under Runtime Network Lockdown. It requires well-formed setup, Scene, step, action, assertion, and network protocol events and ties failures back to stable Scene and action identifiers. Synthetic-only Demo Scripts do not launch Playwright merely to manufacture browser evidence.

Footage Capture starts from fresh deterministic app state after validation. It records one continuous browser take for the ordered Browser Scenes so state can flow across their boundaries, then derives one clip per Browser Scene from backend-owned markers. Setup Actions remain outside visible Scene footage. Synthetic Scenes produce no captured clips.

Compositing rebuilds the full Demo Script order. It pairs Browser Scenes with their captured clips and renders Synthetic Scenes natively, then applies overlays, transitions, and optional music. Missing Browser Scene footage or an unregistered Static Image Scene asset is a hard failure rather than an opportunity to read an agent-controlled path.

### Sandbox and network boundaries

Daytona remains the execution substrate. The harness keeps a two-boundary model:

- The agent/OpenCode sandbox may receive provider credentials and may edit the ephemeral repo only during stages that allow mutation.
- The submitted-code sandbox runs install, build, runtime, browser exploration, validation, and capture with a scrubbed environment and no agent, model, or provider secrets.

Dependency installation may open network only through a backend-controlled, allowlisted package-manager install window. The dependency network window reseals in `finally`. Runtime and capture network are blocked by default. External browser or app network attempts are logged as validation evidence; exact External Resource Cache hits are fulfilled locally, while uncached traffic remains blocked and fails only when it prevents the required observable flow from passing.

The backend owns success and failure. Agents may propose plans, workspace edits, declarative Demo Scripts, and repairs, but backend validation decides whether a stage may proceed.

### Repair routing

Repair is routed by typed validation failures:

- Script failures, including unknown or stale action evidence, invalid locators, assertion failures, action-state failures, Scene protocol failures, presentation contract failures, and invalid typed actions, route to Script Repair.
- Preparation failures, including auth walls, missing fixtures, missing environment, external runtime network requirements, route crashes, empty app state, install, build, or start failures, and incorrect manifest commands, route to Repo Preparation Repair.
- Unsupported, unsafe, compiler, transfer, sandbox-lifecycle, and other harness-internal failures fail fast unless a specific policy classifies them as transient.

Script Repair changes typed Setup Actions, Browser Actions, Scene metadata, or presentation inputs; it does not patch generated Playwright. Repo Preparation Repair may invalidate App Map, Action Catalog, Flow Spec, and Demo Script artifacts when the prepared app changes.

Script Writing and Script Repair are read-only with respect to app setup. The harness captures a workspace diff and status boundary and fails Script Writing if files outside approved `.makeademo` artifacts change.

## Consequences

The harness is easier to debug because each stage emits durable artifacts, validation reports, contract versions, stage statuses, network transitions, sandbox IDs, OpenCode session IDs, stable Scene and action IDs, and repair attempts.

Agents operate over a smaller, evidence-grounded action language instead of arbitrary executable browser code. The backend can evolve Playwright, Capture SDK instrumentation, and browser-hardening behavior without changing the agent-facing Demo Script shape on every runtime revision.

Browser capture failures and compositor-only Scene failures remain separate. Synthetic Scenes avoid unnecessary browser work, while mixed timelines preserve a single narrative order through Compositing.

Prompt quality still matters, but prompts do not encode the product contract by themselves. Typed artifacts, backend validators, the action compiler, the runtime protocol, and Compositing's trusted asset boundary encode the contract.

Downstream stages can be rerun from durable artifacts even when an OpenCode session is unavailable. Repairs can invalidate and regenerate downstream artifacts deliberately when Repo Preparation changes the prepared app.

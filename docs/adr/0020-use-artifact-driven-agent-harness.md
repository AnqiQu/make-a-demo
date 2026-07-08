# 0020 Use an Artifact-Driven Agent Harness

## Status

Accepted

## Context

MakeADemo must turn an untrusted submitted web app into a validated capture-ready Demo Script without letting an agent self-certify success. The previous architecture spread Repo Preparation, Script Generation, runtime preflight, capture path validation, Daytona concerns, OpenCode prompts, dependency network gates, and Demo Script contracts across several stage-specific ADRs. Those ADRs no longer describe the target harness.

There is no reference Playwright scene that generated scripts should mimic. The contract for `/workspace/.makeademo/demo-script.json` is defined by the Capture SDK, the Demo Script JSON schema, the generated script output path, backend validators, and future golden examples.

## Decision

MakeADemo will use a backend-owned, artifact-driven agent harness for the pipeline from Context Intake through Capture Path Validation.

The harness runs these stages in order:

Context Intake -> Static Repo Security Screen -> Repo Profiler -> Run Plan Synthesis -> Repo Preparation Agent Loop -> Preparation Preflight Validation -> App Exploration -> Flow Planning -> Script Writing -> Static Script Contract Validation -> Dynamic Capture Path Validation -> Repair Router -> Script Repair or Repo Preparation Repair -> Final Artifacts.

Every meaningful handoff is a typed JSON artifact. The core artifacts are `RepoProfile`, `RunPlan`, `PreparationManifest`, `ValidationReport`, `AppMap`, `ActionCatalog`, `FlowSpec`, `DemoScriptContract`, `ScriptCandidate`, and `PipelineRunManifest`.

Repo Preparation and Script Generation are separate contracts. Repo Preparation may mutate the ephemeral submitted workspace and must emit a validated `PreparationManifest`. App Exploration, Flow Planning, Script Writing, Script Repair, and Capture Path Validation must consume durable artifacts and must not depend on hidden OpenCode session memory for correctness.

App Exploration and Flow Planning happen before Script Writing. The Script Writer may only script flows grounded in the running prepared app, the `AppMap`, the `ActionCatalog`, and the selected `FlowSpec`.

OpenCode remains the agent runtime. Reusing an OpenCode session across stages is allowed and useful as a context cache, but OpenCode memory is never the source of truth. Prompts must be stage-specific and artifact-path-oriented.

Daytona remains the execution substrate. The harness keeps a two-boundary model:

- The agent/OpenCode sandbox may receive provider credentials and may edit the ephemeral repo only in stages that allow mutation.
- The submitted-code sandbox runs install, build, runtime, browser exploration, validation, and capture with a scrubbed environment and no agent/model/provider secrets.

Dependency installation may open network only through a backend-controlled allowlisted package-manager install window. The dependency network window must reseal in `finally`. Runtime and capture network are blocked by default. External browser or app network attempts are logged as validation evidence and fail unless explicitly local and allowed.

The Demo Script output path is exactly `/workspace/.makeademo/demo-script.json`. Static script validation checks JSON shape, Capture SDK usage, manifest `baseUrl` usage, meaningful scenes/assertions, forbidden browser ownership, forbidden runtime network APIs, forbidden external URLs, placeholders, and output path. Dynamic Capture Path Validation then dry-runs the generated script through the production capture path under Runtime Network Lockdown.

The backend owns success and failure. Agents may propose plans, edits, scripts, and repairs, but backend validation decides whether a stage may proceed.

Repair is routed by typed validation failures:

- Script failures, including locator failures, assertion failures, timing/state issues, Capture SDK violations, and script contract failures, route to Script Repair.
- Preparation failures, including auth walls, missing fixtures, missing env, external runtime network requirements, route crashes, empty app state, install/build/start failures, and wrong manifest commands, route to Repo Preparation Repair.
- Unsupported, unsafe, and harness/internal failures fail fast unless a future policy explicitly allows recovery.

Script Writing and Script Repair are read-only with respect to app setup. The harness captures a workspace diff/status boundary and fails Script Writing if files outside approved `.makeademo` script artifacts change.

## Consequences

The harness is easier to debug because each stage emits durable artifacts, validation reports, stage statuses, network transitions, sandbox IDs, OpenCode session IDs, and repair attempts.

Prompt quality still matters, but prompts no longer encode the product contract by themselves. Typed artifacts and backend validators encode the contract.

Downstream stages can be rerun from durable artifacts even when an OpenCode session is unavailable.

Repair can invalidate and regenerate downstream artifacts deliberately when Repo Preparation changes the prepared app.

Golden examples can be added later as contract fixtures without blocking this rebuild.

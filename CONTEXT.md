# MakeADemo Context

`MakeADemo` is a single-package Bun/TypeScript product for generating short demo videos from runnable web apps, codebase context, and product descriptions.

## Domain Terms

- **MakeADemo Pipeline**: The linear product flow that turns a submitted project into a demo video through context gathering, repo screening, repo preparation, script generation, capture path validation, footage capture, and compositing.
- **Context Gathering**: The stage where the maker submits the GitHub repo URL and key product features to demo.
- **Project Intake**: The data captured during Context Gathering.
- **Supporting Document**: A non-image, non-video document uploaded or provided by the maker during Context Gathering to help Repo Preparation and Script Generation understand the product, setup, audience, and demo goals.
- **Normalized Supporting Document**: A text artifact extracted from a Supporting Document before Repo Preparation begins, preserving source metadata while giving agent and non-agent stages a consistent document representation.
- **Repo Security Screen**: The non-agent, deterministic pipeline stage that performs a fast, static-only rough safety pass on a cloned submitted repo before any agent or runtime preparation work begins.
- **Repo Preparation**: The pipeline stage where MakeADemo works in a locked-down ephemeral cloud workspace to discover existing demo setup, prepare a deterministic demo runtime, and gather context for later script and capture stages without modifying the maker's source repo.
- **Preparation Fallback Prompt**: A targeted prompt generated when Repo Preparation fails, giving the maker and the maker's coding agent the blockers and context needed to prepare the demo manually.
- **Demo Runtime Preflight**: The project-level checks inside Capture Path Validation that verify the prepared app can start, load in a browser, remain basically interactable, and satisfy Runtime Network Lockdown before a backend-compiled Capture Script runs.
- **Demo Run Contract**: The requirement that the prepared app can start a deterministic browser-accessible demo inside an isolated sandbox, with no inbound or outbound network communication across the sandbox boundary after dependency installation.
- **MakeADemo Config**: A legacy-compatible `makeademo.config.json` file that may describe a demo command and local URL, but is no longer the primary Stage 1 source of truth once Repo Preparation produces a Preparation Manifest.
- **Preparation Manifest**: The durable internal pipeline artifact produced by Repo Preparation that records the prepared demo command, local URL, existing demo evidence, workspace changes, mocks, assumptions, risks, and context for later script and capture stages.
- **Product Context**: The source-backed portion of a Preparation Manifest that records the product name, summary, repository evidence paths, and Feature Inventory used by App Exploration and Flow Planning.
- **Feature Inventory**: The ordered set of product capabilities identified during Repo Preparation. Each prepared feature has a stable ID, display label, source evidence, browser entry paths, local fixture notes, and an authentication strategy. Maker-requested features retain their exact submitted text.
- **Feature Flow**: One feature-scoped entry in a Flow Spec. It binds exactly one prepared feature to observed App Map routes, feature-tagged Action Catalog actions, visible outcomes, required app state, and ordered demo steps.
- **Runtime Network Lockdown**: The pipeline boundary where the prepared app runtime is sealed from external network access after setup. Attempted boundary traffic is blocked and recorded; validation fails when an unresolved network dependency prevents the required observable flow.
- **External Resource Cache**: A backend-owned, content-addressed Pipeline Job artifact containing credential-free public presentation resources discovered by the browser or app runtime during App Exploration and Capture Path Validation. Cached responses are replayed locally during exploration, validation, and capture without opening the Sandbox network boundary.
- **Sandbox**: The isolated execution environment that runs the submitted app, browser validation, capture path validation, and Playwright capture with the network boundary sealed after dependency installation.
- **Script Generation**: The stage where MakeADemo turns prepared repo context, explored app evidence, a selected Flow Spec, and key product features into a declarative Demo Script.
- **Video Script**: A structured narrative plan for what the demo video will communicate over time. This term belongs to the legacy Video Script Package flow; the current capture-ready artifact is the Demo Script.
- **Video Script Package**: The legacy structured artifact produced by Script Generation before Footage Capture, containing the Video Script, Script Sections, Scene Descriptions, Browser Actions, and validation context.
- **Demo Script**: The capture-ready, declarative timeline artifact produced by Script Generation, replacing Video Script Package as the handoff into Capture Path Validation, Footage Capture, and Compositing. It contains ordered Browser Scenes and Synthetic Scenes, optional off-camera Setup Actions, and presentation metadata. Current agent output contains typed actions rather than agent-authored Playwright source.
- **Capture Path Validation**: The deterministic dry-run validation stage that runs Demo Runtime Preflight and then runs the backend-compiled browser path against the prepared app under Runtime Network Lockdown before Footage Capture accepts the Demo Script.
- **Script Section**: A top-level part of the Video Script, such as intro, feature demonstration, or use case, that groups related scenes.
- **Scene Description**: One ordered, discriminated Scene object in a Demo Script. It declares either a Browser Scene or a Synthetic Scene; its human-readable description is optional and is not executable behavior.
- **Scene**: One ordered segment in the final demo timeline. A Scene may be backed by captured browser footage or generated directly by the compositor.
- **Browser Scene**: A Scene with type `playwright-recording`. It declares typed Browser Actions, an expected visible outcome, and the boundary of footage that Footage Capture must record.
- **Synthetic Scene**: A Scene rendered directly by Compositing rather than recorded by Playwright. Current Synthetic Scene types are Full-Screen Text Scene and Static Image Scene.
- **Full-Screen Text Scene**: A Synthetic Scene that declares text, styling, background color, and duration for compositor-native rendering.
- **Static Image Scene**: A Synthetic Scene that declares a trusted asset identifier, alternative text, and duration. Its asset identifier is resolved through a backend-supplied asset registry; it is not an arbitrary path or URL.
- **Browser Action**: One typed, declarative browser interaction or assertion in a Browser Scene, such as navigation, clicking, filling, selecting, pressing a key, scrolling grounded content, or asserting visible state. On-camera Browser Actions are grounded in Action Catalog and Flow Spec evidence and are compiled by the backend; they are not raw Playwright statements.
- **Demo Narrative Assembly**: The backend-owned operation that wraps feature-tagged Browser Scenes with a product intro, one Full-Screen Text Scene before each selected feature, and a product outro in canonical Flow Spec order.
- **Setup Action**: An optional typed Browser Action that prepares browser state before recorded Browser Scenes begin. Setup Actions execute off camera and are not Synthetic Scenes.
- **Capture Script**: The backend-owned, versioned Capture SDK and Playwright program compiled from a Demo Script's Setup Actions and Browser Actions. Current agents do not author or return this source directly; accepting agent-authored `demoPlaywrightScript` is legacy compatibility behavior, not the current contract.
- **Captured Scene Clip**: The trimmed browser video clip produced for one Browser Scene from the continuous Footage Capture take. Synthetic Scenes do not have Captured Scene Clips.
- **Companion Video**: The user-facing preview of a Scene shown during review. A Browser Scene preview uses its Captured Scene Clip; a Synthetic Scene preview is compositor-rendered.
- **Footage Capture**: The stage where MakeADemo runs the backend-compiled Capture Script in the Sandbox and records only the browser footage required by Browser Scenes.
- **Compositing**: The stage where MakeADemo assembles Captured Scene Clips and compositor-native Synthetic Scenes, in Demo Script order, into the final demo video with overlays, transitions, music, and other presentation effects.
- **Draft Composite**: A temporary composited demo video produced for quality review before MakeADemo accepts it as the final output.

- **Pipeline Stage**: One user-visible step in the MakeADemo Pipeline with clear inputs, outputs, and failure states.
- **Pipeline Job**: One execution of the MakeADemo Pipeline for a submitted project.
- **External Seam**: A stable boundary around infrastructure or third-party behavior, such as sandbox execution, browser automation, model calls, artifact storage, auth, or rendering.
- **Schema Module**: A public runtime validation boundary, named `*.schema.ts`, that exports schemas, codecs, or schema constants used to validate external data before it enters product types.

## Relationships

- The **MakeADemo Pipeline** runs linearly from **Context Gathering** to **Repo Security Screen**, **Repo Preparation**, **Script Generation**, **Capture Path Validation**, **Footage Capture**, **Compositing**, and final output.
- **Context Gathering** accepts the repo URL, structured demo intent, and broad document uploads for **Supporting Documents**, but excludes videos and pictures in Stage 1.
- **Supporting Documents** are normalized into text artifacts before **Repo Preparation** begins.
- **Repo Security Screen** runs before **Repo Preparation** and does not use an agent.
- **Repo Security Screen** does not install dependencies or execute submitted repo code.
- Repository snapshots quarantine committed private environment files and private-key material from every agent and submitted-code archive while retaining only safe environment variable names as preparation hints. Static rejection is terminal only for unsafe content that remains executable or otherwise cannot be safely quarantined.
- **Repo Preparation** happens in an ephemeral cloud workspace and does not modify the maker's source repo.
- During **Repo Preparation**, the preparation agent may edit and execute the ephemeral workspace, but the prepared output must still pass non-agent **Capture Path Validation** before Footage Capture trusts it.
- During **Repo Preparation**, the preparation agent may use controlled network access for setup and research, but the prepared app runtime must pass **Runtime Network Lockdown** before Footage Capture trusts it.
- **App Exploration**, **Demo Runtime Preflight**, and **Capture Path Validation** may ask the backend resource broker to fetch an exact, credential-free public HTTPS GET after public-address resolution. The controller fetches eligible presentation bytes without submitted-app headers, cookies, or Sandbox egress, then pins them into the hash-verified **External Resource Cache**.
- Browser requests and supported server-side asset loaders replay exact cached URLs and controller-observed redirects locally. Discovery repeats offline to collect nested stylesheet, font, image, and media dependencies. **Footage Capture** uses only the frozen cache: uncached traffic remains blocked and observable, and a required visual resource that cannot be replayed fails validation.
- The preparation agent can invoke **Runtime Network Lockdown** as an iterative tool/check; app runtime network attempts return structured tool-call failures so the agent can mock or remove dependencies before retrying.
- **Repo Preparation** first checks whether the submitted project already contains a prepared demo command, MakeADemo Config, or existing demo flow before creating a new one.
- **Repo Preparation** mutates the ephemeral workspace directly and stores the resulting diff as an artifact for auditability, fallback prompts, and future apply-to-repo flows.
- **Repo Preparation** may gather context for later script and capture stages, but **Script Generation** remains a separate stage.
- **Repo Preparation** records source-backed **Product Context** and makes every maker-requested feature browser-reachable in its ephemeral demo runtime. Authentication prerequisites may use a demo-only bypass or deterministic local identity, while authentication remains visible when it is itself requested.
- In a supported monorepo, backend Runtime Target Resolution keeps dependency installation at the lockfile owner while restricting it to the selected browser workspace and the internal workspace closure proven by package metadata, source imports, or missing-module preflight evidence. Scoped runtimes execute the selected workspace's own scripts; unrelated workspaces are not installed or repaired merely because they share the repository.
- If **Repo Preparation** cannot produce a plausible deterministic demo runtime, MakeADemo returns a **Preparation Fallback Prompt** and does not proceed to Script Generation.
- **Capture Path Validation** and **Footage Capture** run Playwright inside the **Sandbox** rather than from the backend host.
- **Preparation Manifest** supplies the prepared demo command and local URL used by **Capture Path Validation**.
- Later pipeline stages may consume the **Preparation Manifest** directly, including non-agent stages and coding-agent stages that access it through tools or skills.
- A legacy **Video Script** contains one or more **Script Sections**, and each **Script Section** contains one or more **Scene Descriptions**. The current **Demo Script** is the capture-ready timeline contract.
- A **Demo Script** is accepted for Footage Capture only after **Capture Path Validation** succeeds.
- A **Demo Script** contains an ordered mix of **Browser Scenes** and **Synthetic Scenes**. It can cover multiple Browser Scenes in one continuous demo flow so Setup Actions happen outside the final visible footage.
- Current Script Generation emits typed **Browser Actions**. The backend validates their Action Catalog and Flow Spec grounding, compiles them into the versioned **Capture Script**, and retains ownership of Playwright, Capture SDK calls, recording, and runtime protocol markers.
- When the maker submits key product features, the Flow Spec contains exactly that feature set and cannot treat duration or convenience as permission to omit one. When no features are submitted, Flow Planning selects up to three source-backed, browser-grounded Feature Inventory entries.
- Every Browser Scene identifies one **Feature Flow**. Script validation rejects missing, unknown, cross-feature, and ungrounded Scene actions. **Demo Narrative Assembly** adds canonical intro, feature-introduction, and outro Scenes after the agent writes the feature demonstrations.
- Raw agent-authored `demoPlaywrightScript` is not part of the current Demo Script contract. Legacy parsing support must not be treated as permission for current agents to write executable browser source.
- **Footage Capture** executes an accepted **Demo Script** from a fresh deterministic starting state, then preserves browser and app state across its Browser Scenes.
- **Capture Path Validation** first runs **Demo Runtime Preflight** to prove the prepared app can load without external network access, then proves that the backend-compiled browser path in a **Demo Script** can run while **Runtime Network Lockdown** is enforced.
- **Capture Path Validation** does not produce final browser footage; **Footage Capture** records one continuous presentation-oriented take for Browser Scenes, including human-like typing and cursor movement, and derives their Captured Scene Clips from that take.
- **Footage Capture** starts from fresh deterministic app state after **Capture Path Validation** succeeds, so validation dry-runs cannot pollute the final recorded take.
- Every repaired **Capture Path Validation** attempt also starts from a freshly synchronized app runtime, so one failed dry-run cannot make a later retry pass or fail because of leftover state.
- If **Capture Path Validation** fails, the agent may repair the prepared workspace or **Demo Script**, but the full **Capture Path Validation** stage must rerun before **Footage Capture** trusts the result.
- If **Capture Path Validation** still fails after repair attempts are exhausted, the **Pipeline Job** fails and tells the user to report the issue to MakeADemo rather than returning a partially trusted script or preparation fallback.
- If **Draft Composite** review requires changing the prepared workspace, **Capture Path Validation** must rerun before **Footage Capture** records a new take.
- A **Browser Scene** contains one or more Browser Actions, including a visible assertion that proves its expected on-camera outcome. A **Synthetic Scene** contains no Browser Actions.
- The backend compiles Setup Actions and all Browser Scene actions into one **Capture Script** so browser and application state can flow across recorded Scene boundaries.
- **Footage Capture** emits one **Captured Scene Clip** per Browser Scene and no clip for a Synthetic Scene.
- **Compositing** resolves every ordered Scene by pairing Browser Scenes with their Captured Scene Clips and rendering Synthetic Scenes natively. It fails closed when a Browser Scene clip or trusted Static Image Scene asset is missing.
- Presentation transitions default to direct adjacency when omitted; an explicit transition only changes how two adjacent Scenes overlap or cut.
- Each **Scene** is shown to the user as its **Companion Video** and is later used by **Compositing**.
- **Compositing** produces a **Draft Composite** before final output acceptance, so the full video can be reviewed for narrative, timing, presentation, and capture quality.

## Architectural Intent

Organize product code around the linear MakeADemo Pipeline.

Keep pipeline stages explicit and testable. Each stage should expose clear inputs, outputs, failure states, and dependencies on external seams.

Keep infrastructure-specific code behind seams so sandbox execution, browser automation, model providers, artifact storage, auth, persistence, and rendering can evolve without rewriting pipeline orchestration.

Use `*.interface.ts` for type-only seams when a boundary has multiple implementations or external behavior. Public runtime validation belongs in `*.schema.ts`.

# Use Prepared Agent Workspace Images

Daytona agent workspaces will start from a prepared image or template that includes the OpenCode agent runtime, Docker-in-Docker support, the Context7 CLI, Context7 OpenCode skill configuration, and required non-secret agent tooling. We chose this over installing agent tooling on every workspace creation because prepared images make Repo Preparation, Script Generation, Capture Path Validation repair, and audit capture faster, more consistent, and less dependent on repeated setup-time network access.

Submitted repo code must run in an inner submitted-code container rather than directly in the outer Daytona agent workspace. The outer workspace runs OpenCode and MakeADemo-controlled tooling; the inner container runs all submitted repo commands, including dependency installation, build, demo runtime, Project Validation, Capture Path Validation, and Footage Capture. This adds a second runtime boundary, but keeps agent credentials, OpenCode state, and MakeADemo control tooling out of the submitted-code process environment.

OpenCode edits the shared repo workspace from the outer agent environment. The same repo directory is mounted into the inner submitted-code container, so submitted commands execute the exact files the agent edits without running OpenCode inside the submitted-code container or syncing a second copy.

The inner submitted-code image should provide a separate `.makeademo/` path for MakeADemo control artifacts. Per-run manifests, scripts, and logs are populated there at runtime, separately from the submitted repo path. The inner container may expose this as `/workspace/.makeademo`, but that path must be backed by a distinct outer control directory rather than the repo workspace's `.makeademo` directory. Agent configuration, provider credentials, raw OpenCode state, and unredacted transcripts must not be written into or mounted through the inner submitted-code control path.

The inner submitted-code container should have write access only to the mounted repo workspace, the separate `.makeademo/` control directory, and necessary temporary or package-cache locations. Other filesystem state should be read-only or disposable container-local state.

The first inner submitted-code image should be one generic Node/browser runtime image. Stage 1 is currently JavaScript/TypeScript-oriented, so language-specific submitted-code images can wait until MakeADemo supports broader runtime families.

The outer agent workspace and inner submitted-code container have separate network policies. Agent tooling may use the outer workspace network for OpenCode, Context7, and research. The inner submitted-code container has outbound network blocked by default, and only the dependency-install tool may open a dependency-install-only network window for the inner container.

The inner submitted-code container should be long-lived for the whole pipeline run rather than recreated per command or stage. Keeping one inner container preserves installed dependencies, dev-server state, browser and capture state where needed, and prepared workspace diffs without repeated container setup.

Browser automation for Project Validation, Capture Path Validation, and Footage Capture should also run inside the inner submitted-code container. Playwright executes generated repo-facing scripts against untrusted app behavior, so it follows the same submitted-code execution boundary as dependency installation, build, and demo runtime.

Secrets must not be baked into the image. OpenCode web search should be enabled for the agent with `OPENCODE_ENABLE_EXA=1`, which does not require an EXA API key for the built-in web search path. LLM provider credentials and any future agent-only credentials should be injected at runtime only into the OpenCode agent environment. Submitted repo build, runtime, validation, and capture commands should execute with a scrubbed environment, no inherited agent secrets, and no outbound network access except for mechanically approved dependency-install-only windows.

The OpenCode agent may run fully autonomously inside the disposable workspace copy, including destructive file operations needed to prepare the demo. That autonomy must not extend to the maker's source repo, host infrastructure, or persisted artifacts except through explicit product-level APIs.

The prepared OpenCode configuration should allow all OpenCode permissions for the agent session to avoid interactive blockers. Network access, runtime isolation, secret scoping, timeouts, and workspace teardown are enforced by the backend Daytona seam and nested runtime controls rather than by OpenCode permission prompts.

The prepared image does not need predefined advisory-review agent configurations for Repo Preparation. After the deterministic Repo Security Screen passes, the OpenCode preparation agent works directly inside the disposable workspace, while backend seams enforce network policy, secret scoping, timeouts, teardown, and non-agent validation.

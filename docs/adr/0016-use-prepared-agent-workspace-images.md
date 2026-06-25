# Use Prepared Agent Workspace Images

Daytona agent workspaces will start from a prepared image or template that includes the OpenCode agent runtime, the Context7 CLI, Context7 OpenCode skill configuration, and required non-secret agent tooling. We chose this over installing agent tooling on every workspace creation because prepared images make Repo Preparation, Script Generation, Capture Path Validation repair, and audit capture faster, more consistent, and less dependent on repeated setup-time network access.

The prepared image should rely on Daytona sandbox isolation for submitted app build and runtime commands rather than requiring Docker-in-Docker. This keeps Stage 1 tied to the Daytona external seam instead of maintaining a second container runtime path.

Secrets must not be baked into the image. OpenCode web search should be enabled for the agent with `OPENCODE_ENABLE_EXA=1`, which does not require an EXA API key for the built-in web search path. LLM provider credentials and any future agent-only credentials should be injected at runtime only into the OpenCode agent environment. Submitted repo build, runtime, validation, and capture commands should execute with a scrubbed environment, no inherited agent secrets, and no outbound network access except for mechanically approved dependency-install-only windows.

The OpenCode agent may run fully autonomously inside the disposable workspace copy, including destructive file operations needed to prepare the demo. That autonomy must not extend to the maker's source repo, host infrastructure, or persisted artifacts except through explicit product-level APIs.

The prepared OpenCode configuration should allow all OpenCode permissions for the agent session to avoid interactive blockers. Network access, runtime isolation, secret scoping, timeouts, and workspace teardown are enforced by the backend Daytona seam and nested runtime controls rather than by OpenCode permission prompts.

The prepared image does not need predefined advisory-review agent configurations for Repo Preparation. After the deterministic Repo Security Screen passes, the OpenCode preparation agent works directly inside the disposable workspace, while backend seams enforce network policy, secret scoping, timeouts, teardown, and non-agent validation.

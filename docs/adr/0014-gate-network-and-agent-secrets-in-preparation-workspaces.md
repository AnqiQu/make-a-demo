# Gate Network and Agent Secrets in Preparation Workspaces

The agent may have unrestricted tool permissions inside the ephemeral workspace, but the submitted app runtime remains subject to Runtime Network Lockdown during Capture Path Validation and Footage Capture. We chose this split because the OpenCode agent needs enough autonomy to prepare demos and repair scripts, while submitted repo code should not inherit agent privileges.

If dependency installation requires outbound network access, the main agent may only request a dependency-install-only network window. The network-access mechanism should enforce this mechanically by requiring an allowlisted package-manager install command and a dependency-install-only reason before it updates Daytona sandbox network settings.

Outbound network access should be blocked again immediately after dependency installation completes. Demo build, demo start, Capture Path Validation, and Footage Capture should run with outbound network blocked unless another dependency-install-only window is separately approved.

Agent research tooling, including OpenCode web search and Context7, belongs to the OpenCode agent environment rather than the submitted app runtime. OpenCode web search should be enabled with `OPENCODE_ENABLE_EXA=1`; no EXA API key is required for that built-in path. LLM provider credentials and any future agent-only secrets should be injected only into the agent process at runtime. Demo build and runtime subprocesses should receive a scrubbed environment so submitted repo code cannot read or exfiltrate those secrets, and persisted logs must redact them.

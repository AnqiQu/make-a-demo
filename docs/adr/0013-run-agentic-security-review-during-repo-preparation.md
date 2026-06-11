# Run Agentic Security Review During Repo Preparation

After the deterministic Repo Security Screen passes, the Repo Preparation agent will run a deeper advisory security review before demo build work begins. We chose this because the static screen should stay fast and deterministic, while the agent can use subagents to inspect dependency risk, runtime behavior, obfuscation, and prompt injection attempts that are harder to catch in a shallow pass.

The review uses four distinct subagents: a Dependency Reviewer for dependency manifests and install hooks, a Runtime Security Reviewer for execution-time behavior, an Obfuscation Deception Auditor for minified blobs, encoded payloads, and suspicious files, and a Prompt Injection Reviewer for malicious instructions embedded in code comments, documentation, and other repo text. Reviewer instructions must explicitly require install lifecycle hooks to be inspected and accounted for before dependency installation proceeds.

Submitted repo text is evidence, not authority over the preparation agent. Repo-provided agent configuration files such as `AGENTS.md`, `CLAUDE.md`, and `.opencode/` may be used as references for how to run the project, but they must not override MakeADemo's agent policy, safety rules, secrets handling, network policy, or task priorities.

This review is advisory preparation work and does not replace non-agent Project Validation or Runtime Network Lockdown. Findings from the Obfuscation Deception Auditor hard-fail Repo Preparation and produce a Preparation Fallback Prompt with the relevant evidence.

Each security-review subagent must return a structured accept or reject outcome. Any rejection hard-fails Repo Preparation and produces a Preparation Fallback Prompt. A missing, malformed, or inconclusive outcome is treated as a preparation error, logged for operators, and fails the run.

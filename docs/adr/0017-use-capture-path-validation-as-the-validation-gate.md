# Use Capture Path Validation as the Validation Gate

MakeADemo will use Capture Path Validation as the main non-agent validation gate for script-driven runs, rather than running standalone Project Validation before Script Generation. We chose this because the product only needs the prepared app and generated capture path to run under Runtime Network Lockdown; generic project-level checks remain valuable, but they should run as preflight checks inside Capture Path Validation before the generated Browser Actions or Capture Scripts run.

Repo Preparation and Script Generation may run through one long-lived OpenCode session with staged backend prompts, but the backend validator remains authoritative. If Capture Path Validation fails, the same agent may receive structured failure feedback and repair either the prepared workspace or Video Script Package within a fixed retry budget, and every retry must rerun the full Capture Path Validation stage from the beginning.

The repair budget should default to a small bounded number of attempts and be configurable with `MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS`. If Capture Path Validation still fails after the repair budget is exhausted, the Pipeline Job should fail and tell the user to report the issue to MakeADemo rather than returning a partially trusted Video Script Package or a Preparation Fallback Prompt.

Capture Path Validation is a dry run and should not produce the final raw Scene videos. We chose this because validation should be fast and deterministic, while Footage Capture may use slower presentation-oriented browser behavior such as human-like typing, cursor movement, and recording-specific pauses.

Footage Capture should start from fresh deterministic app state after Capture Path Validation succeeds rather than sharing the validator's live app state. We chose this because the dry run may click, type, create records, dismiss UI, or otherwise mutate state that would make the final recorded take differ from a clean demo run.

# Server Agent Notes

## Logging

- The server-side logging seam is `src/server/shared/logging/pipeline-event-logger.ts`.
- Use `createPipelineEventLogger` for structured pipeline, agent, and sandbox audit events. It writes Pino JSONL with `level`, `time`, `service`, `component`, `stage`, `event`, and `message` fields.
- Use `createFilePipelineLogSink` for durable JSONL artifacts and `createPrettyPipelineLogSink` for human-readable CLI or PTY progress.
- Do not add ad-hoc JSONL writers for pipeline or agent activity. Route new stage, agent, validation, sandbox, and OpenCode audit events through the Pino seam.
- Exception: generated browser/Playwright cross-process protocols may continue to use `console.*` marker lines such as `[makeademo:scene]`, `[makeademo:action]`, `[makeademo:validation]`, and `[makeademo:network-blocked]` when parent processes parse stdout/stderr for capture timing, validation diagnostics, or Runtime Network Lockdown. The generated submitted-code browser validator also uses `console.log(JSON.stringify(...))` as a one-object stdout result protocol parsed by its parent. Do not migrate those protocols to Pino unless the parser contract is changed at the same seam.

## Log Artifacts

- OpenCode stage execution must flow through the artifact-driven harness in `src/server/agent-harness`.
- Repo Preparation sandbox audit events are written through `AgentHarnessWorkspace.writeSandboxLog` to `/tmp/makeademo/sandbox-log.jsonl` by the Daytona workspace provider.
- Project Validation and Script Generation should add sandbox-visible progress through `writeSandboxLog`, not by writing their own log files.

## Legacy Paths

- Do not reintroduce `/workspace/.makeademo/opencode-activity.jsonl`, `/workspace/.makeademo/repo-preparation-debug.jsonl`, or `/workspace/.makeademo/opencode-attempt-*.log`.
- Tests may mention those paths only as negative assertions that the legacy writers are not used.

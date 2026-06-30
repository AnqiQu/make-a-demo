# Pipeline Modules

Product code in this directory is organized around the linear MakeADemo Pipeline from `CONTEXT.md`.

- `00-orchestration/` coordinates Pipeline Jobs and CLI/worker entry points across stages.
- Numbered stage folders own stage-specific product behavior, handoff artifacts, failure states, and tests.
- Stage modules may depend on external seams through interfaces, but provider-specific adapters belong under `src/server/shared/integrations/`.
- Shared handoff contracts should use domain names from `CONTEXT.md`; avoid generic or legacy names such as "stage 1" in active product code.

# Pipeline fixture repos

Three tiny runnable web-app repos used as the regression matrix for the MakeADemo pipeline
(see `docs/audits/2026-07-27-remediation-plan.md`, Phase 0). Each one exists to pin a
distinct repo shape the pipeline must handle:

| Fixture | Shape | What it pins |
|---|---|---|
| `vite-spa` | Single-package Vite SPA, npm | The simplest happy path: one package, one dev server, no workspaces |
| `pnpm-monorepo` | pnpm workspaces: `apps/web` + `docs` decoy + `packages/shared`, root `prepare` script | Workspace target selection, scoped installs that keep the root `prepare`, workspace-protocol deps, docs-role exclusion |
| `npm-express-static` | npm, static client built to `dist/`, `start: serve -s dist`, separate express API | Build-before-serve detection (`serve -s dist` is not a dev server), port extraction from `-l`, script-role disambiguation |

## How they are used

1. **Unit tests** import these directories (or init temp git repos from them) to exercise
   the repo profiler, run planner, and preparation seams against real layouts.
2. **End-to-end matrix runs** (`bun scripts/run-pipeline-matrix.mts`) run the full pipeline
   against them. The pipeline only accepts `https://github.com/owner/repo` URLs, so to
   include a fixture in a matrix run, push it to a GitHub repo you own:

   ```
   cd tests/fixtures/repos/vite-spa
   git init && git add -A && git commit -m "fixture" \
     && git remote add origin https://github.com/<you>/makeademo-fixture-vite-spa.git \
     && git push -u origin main
   ```

   then set the URL in `tests/fixtures/pipeline-matrix.json` (or the corresponding
   `MAKEADEMO_MATRIX_REPO_*` environment variable).

## Rules for editing fixtures

- Keep them deterministic from a fresh page load: no persistence, no network calls, no
  randomness. Exploration evidence must not depend on earlier interactions.
- Keep every interactive control labelled (`<label>`/`aria-label`) so exploration can
  ground actions.
- These directories are excluded from this repo's typecheck, lint, and knip — they are
  foreign repos, not project code. Do not import project code into them.
- If you change a fixture's layout (not just content), re-push the GitHub mirror before
  the next matrix run.

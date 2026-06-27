# MakeADemo Benchmarking

Use this benchmark to measure how far submitted repos get through the MakeADemo Pipeline, how long each run takes, and which repos fail early versus late.

## First Pass

Start with the example manifest:

```bash
bun scripts/run-benchmark.mts benchmarks/repos.example.json
```

Then summarize the JSONL result file printed by the runner:

```bash
bun scripts/summarize-benchmark.mts .makeademo-benchmark-runs/<run>/benchmark-results.jsonl
```

Required environment:

```bash
DAYTONA_API_KEY=...
OPENAI_API_KEY=...
```

The first benchmark should use `mode: "stage1"` so the run focuses on Repo Security Screen, Repo Preparation, Project Validation, and Script Generation. Switch selected repos to `mode: "full"` after Stage 1 behavior is stable.

## Success Levels

| Level | Meaning |
| --- | --- |
| `L0` | Repo rejected safely, Repo Preparation failed, or no trusted stage output exists. |
| `L1` | Repo Preparation produced enough output to reach Project Validation, but validation failed. |
| `L2` | Reserved for explicit Project Validation success when Script Generation is skipped. |
| `L3` | Script Generation produced a Video Script Package. |
| `L4` | Footage Capture produced Scene artifacts. |
| `L5` | Compositing produced the final video artifact. |
| `L6` | Human review says the final demo is useful. |

## Repo Classes

Use categories to make failures explainable. The example manifest includes:

| Class | Why it matters |
| --- | --- |
| `frontend` | Baseline browser app, usually easiest to prepare. |
| `fullstack` | Requires API/backend setup in addition to browser validation. |
| `monorepo` | Tests package-manager discovery and workspace command selection. |
| `database` | Tests seed data, migrations, and local service setup. |
| `auth` | Tests whether the preparer can create or bypass deterministic auth flows. |
| `external-services` | Tests Runtime Network Lockdown and mock generation. |
| `legacy` | Tests older dependency and build assumptions. |
| `large` | Tests clone, dependency install, and agent context pressure. |
| `hard` | Expected to fail or require a useful Preparation Fallback Prompt. |

## Current Suggested Bank

The example manifest starts with the six requested repos and adds nine more:

| Repo | Classification | Expected first-pass result |
| --- | --- | --- |
| `TonyMckes/conduit-realworld-example-app` | RealWorld full-stack React/Express/Postgres app | `L3` |
| `calcom/cal.diy` | Scheduling SaaS, monorepo, auth/external-service pressure | `L3` |
| `dubinc/dub` | Link analytics SaaS, monorepo, database/external services | `L3` |
| `twentyhq/twenty` | Large CRM, database/auth-heavy monorepo | `L3` |
| `typehero/typehero` | TypeScript education platform, Next.js monorepo | `L3` |
| `midday-ai/midday` | Finance SaaS, monorepo, auth/database/external services | `L3` |
| `alan2207/bulletproof-react` | Medium React architecture sample | `L3` |
| `gothinkster/react-redux-realworld-example-app` | Legacy frontend RealWorld app | `L3` |
| `oldboyxx/jira_clone` | Full-stack seeded project-management app | `L3` |
| `formbricks/formbricks` | Survey SaaS, Next.js monorepo | `L3` |
| `documenso/documenso` | Document workflow SaaS, auth/database/file flow | `L3` |
| `openstatusHQ/openstatus` | Monitoring/status-page app, external-service pressure | `L3` |
| `boxyhq/saas-starter-kit` | Enterprise SaaS starter, auth/database setup | `L3` |
| `medusajs/nextjs-starter-medusa` | Commerce frontend that expects a Medusa backend | `L1` |
| `bluesky-social/social-app` | Large React Native/web app, intentionally hard | `L1` |

Adjust `expectedLevel` after the first run. The expected level is not a claim that the repo definitely works; it is the benchmark's current hypothesis.

## Result Files

Each run writes:

```text
.makeademo-benchmark-runs/
  benchmark-.../
    benchmark-manifest.snapshot.json
    benchmark-results.jsonl
    <repo-id>-r1/
      stdout.log
      stderr.log
      pipeline/
```

`benchmark-results.jsonl` is the durable result table. Token usage is currently recorded as `null`; wire structured model usage into the agent/model seam before using the benchmark for cost conclusions.

## Next Instrumentation

The current backbone measures process-level runtime and inferred success level. The next useful additions are:

- Parse or emit structured token usage from Repo Preparation and Script Generation.
- Record per-stage duration from `PipelineObserver` output for Stage 1 runs.
- Add a human `L6` review file with a 0-5 usefulness score per final video.
- Pin repo commit SHAs once Repo Preparation supports checkout after clone.

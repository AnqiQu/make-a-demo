# Remediation Plan — 2026-07-27

Implementation plan for every finding in [2026-07-27-pipeline-audit.md](./2026-07-27-pipeline-audit.md).
Organized as eight workstreams in dependency order, each a series of small TDD commits (failing
behavioral test first, per `docs/agents/tdd.md`). Finding IDs (C1–C7, H1–H9, M/L) reference the audit.

**Design stance.** Optimal-and-minimal here means: fix classes, not instances (one shared predicate
module instead of four patched regexes); prefer deletion over addition (~1,500 lines net removed);
never add an abstraction with one caller; and make every generality fix *fail closed with an
actionable error* rather than guess — a pipeline that says "ambiguous target, set `preferredAppDir`"
works across arbitrary repos in a way a smarter heuristic never will. Nothing below is tuned to
Midday; Midday is only the first regression gate.

---

## Phase 0 — Settle the working tree (blocks everything)

The uncommitted `anqi-dev` diff contains both active regressions (C1: deleted
`preservesNonDemoBehavior`; C1-FP: config files newly require demo gates) and unrelated good work.
Do not commit it as-is.

| Step | Change | Test first |
|---|---|---|
| 0.1 | Split the WIP diff into reviewable commits; hold back `preparation-fidelity.ts` until WS3 lands its fixes | — |
| 0.2 | Build the **fixture-repo matrix**: three tiny runnable repos committed under `tests/fixtures/repos/` — (a) single-package Vite SPA, (b) pnpm monorepo with `docs/` + `apps/web` + shared package + root `prepare` script, (c) npm express+client with `serve -s dist`. Used by unit tests in WS3/WS5 and by an opt-in end-to-end script | The fixtures **are** the tests |
| 0.3 | Add `scripts/run-pipeline-matrix.mts` (opt-in, costs Daytona/agent money): runs the pipeline against Midday + the three fixtures, writes a pass/fail table. This is the acceptance gate for every later phase | — |

## Phase 1 — WS1: Failure semantics & transparency (C5, H8, M-routing, M-fingerprint)

Smallest workstream, biggest observability payoff. Do first so every later phase's failures are
diagnosable.

| # | Fix (finding) | Files / change | Test first |
|---|---|---|---|
| 1.1 | Rethrow infra errors instead of converting to validation failures (C5) | `default-harness-dependencies.ts` reset + app-start catches: `if (isAgentHarnessInfrastructureError(error)) throw error;` — mirror the existing `:2045` pattern | Fake workspace throws `AgentHarnessSandboxUnavailableError` → pipeline throws infra error, **no** `preparation-fallback.json` written |
| 1.2 | Success survives cleanup failure (C5) | `default-demo-pipeline.ts`: when `primaryFailure === undefined`, log + attach `cleanupFailure` and return `completedResult`. Delete the unreachable `cleanupFailure` block in `agent-harness.ts` | Cleanup throws after successful composite → result returned, warning logged |
| 1.3 | Retry `"transient infrastructure failure"` (C5) | Capture-validation loop in `agent-harness.ts`: bounded retry (2) before falling through; count in run manifest | Transfer error once → stage retried and passes; thrice → fails with original error |
| 1.4 | Route `"listen failure"` to preparation; accept `"missing dependency"` for scope expansion (H8, M) | `repair-router.ts` classification lists; delete it from `dependencyFailureClassifications` | Router unit tests for both classifications end-to-end through `classifyRepairRoute` |
| 1.5 | Kill the stderr-keyword routing lottery (M) | `repair-router.ts`: heuristic only on missing classification, matched against the summary's first line; unmatched → explicit `unclassified` → fail with that reason | Preparation failure whose stderr contains "AssertionError" routes to preparation, not script |
| 1.6 | Stable repeat-failure fingerprint (M) | `agent-harness.ts`: fingerprint = `stage + failureClassification + attemptedCommand + firstLine(logsSummary)`; count install-scope expansions against `totalAttempts`; hoist `attemptedInstallScopes` | Same failure with different temp paths/ports fingerprints identically |
| 1.7 | Realistic runtime budgets (H8) | Named constants: port-bind readiness exponential backoff to 180s cold-start; explicit `timeoutMs` for install (20 min) and build (15 min) instead of the implicit provider default | Probe test: server binds at 90s → preflight passes |
| 1.8 | Log collection that survives failure (C5) | Provider: drop the per-line full-file `cp` mirror; give `collectSandboxLogs` a size-scaled budget (or stream) | Large log collected within budget; no O(n²) writes |
| 1.9 | Bounded, redacted agent-failure feedback (H6, M-redaction) | One `formatAgentCommandFailure(result)` (tail 2 KB + content redactor exported from `json-artifact-diagnostic.ts`) at all six `${result.stderr \|\| result.stdout}` sites, `writeAgentStageLog`, and the fallback-prompt path | Multi-MB stdout → prompt/log excerpt ≤ 2 KB, `Bearer …` redacted |

**Gate:** Midday run; whatever fails must now fail with the true stage, classification, and evidence.

## Phase 2 — WS2: Exploration correctness (C2, H7)

The largest single cause of observed run failures. All changes in
`app-explorer/submitted-app-explorer.ts` unless noted; extract pure helpers
(`normalizeCrawlTarget`, `shouldEnqueue`, `classifyExplorationFailure`) so the generated-script
logic becomes unit-testable instead of substring-asserted.

| # | Fix | Behavior | Test first |
|---|---|---|---|
| 2.1 | Scoped failure gate (C2) | New `unreachableRoutes` field for navigation failures. Exploration fails only when: a feature entry route is unreachable, a feature has zero grounded evidence, or an auth wall blocks a non-auth feature. Everything else stays as report evidence | Unrelated route times out, feature routes ground → **passed** with evidence retained |
| 2.2 | Navigation budget matching reality (C2) | First `goto` per route 60s + one retry; subsequent 20s. Justification: pipeline's own probe measured 26.5s first-compile | Slow-first-compile fake → route explored |
| 2.3 | Robust result protocol (C2) | Generated script: `try/finally` emits `\n[makeademo:exploration] {json}\n` **and** writes `exploration.json`; global wall-clock deadline at 70% of command timeout; parent parses by marker with file fallback; exit≠0/parse-failure → *repairable* ValidationReport carrying stderr excerpt, never a bare throw | Corrupted stdout + intact file → results recovered; exit 1 → repairable report |
| 2.4 | Honest route identity (H7) | Normalize before enqueue (fragment, tracking params, trailing slash); re-check `seen` against post-redirect `page.url()`; slug + short path-hash for screenshots; split budgets (entries + 8 crawl), prefer `primaryNavigation` links; enqueue same-origin post-interaction URLs | Two paths redirecting to one login page → one route entry |
| 2.5 | Real feature grounding (H7) | No feature-ID inheritance across crawl hops; grounding requires ≥1 `exercised` non-navigate action; `matchCount > 1` → landmark-scoped retry or explicit `nth`+reason instead of silent drop | Entry page that merely loads → feature *not* grounded |
| 2.6 | Auth-wall precision (H7) | `password + identity` fields sufficient (same-route login FN); path keywords require a corroborating form (marketing FP); auth-barrier check ordered before the error gate | Login form on `/` detected; pricing page with footer SSO button not flagged |
| 2.7 | Bounded, safer interaction (M) | Cap error/attempt arrays; readiness poll replaces fixed 500 ms; skip controls inside forms that match the auth heuristic; origin-check manifest entry paths before `goto`; set `locale`/`timeZoneId` on context | Entry path `https://evil.com` rejected at target creation |

**Gate:** Midday run reaches flow-planning; explorer unit suite covers gate scoping, dedup, protocol
corruption — none by source-substring assertion.

## Phase 3 — WS3: Fidelity & preparation contract (C1, C6-isWithin, H5, prep S-series)

Rebuild `validatePreparationFidelity` around one structural principle: **parse the patch once, judge
structure over text, gate on what executes.** All bypasses and false positives trace to violating it.

| # | Fix | Change | Test first (adversarial) |
|---|---|---|---|
| 3.1 | Single patch parse (S7) | Line-anchored `^diff --git ` parser → `Map<path,hunk>`, rename-aware; replaces every `indexOf` lookup | Fake header in added content no longer masks; renames judged |
| 3.2 | Restore non-demo preservation (C1) | Reinstate removed-line reconciliation for auth/integration patches: every removed non-blank line recoverable from added lines modulo the gate token | Deleting `redirect("/login")` under a gate → **fail** |
| 3.3 | Real demo gates (C1) | Strip comments before gate detection; gate identifier must be imported/declared *in the patched file* and bound to the flag by direct comparison | Comment gate, global `env` identifier → **fail** |
| 3.4 | Created files are not exempt (C1) | Run auth/integration+gate checks over created executable files and new dotenv files; drop the seam-name exemption when a created file becomes the resolved start target (resolve `startCommandUsed` through the script table) | Seam-named replacement server → **fail**; `.env.local` with `AUTH_DISABLED` → **fail** |
| 3.5 | Stop punishing legitimate prep (C1-FP) | Framework/build config (`*.config.*`, `tsconfig*`, `.env.example`) exempt from the gate requirement; CSS `url()` unquoted forms accepted in asset localization | Port change in `vite.config.ts` → **pass** |
| 3.6 | Cheap failure, useful hints (C1-FP, S12) | First fidelity failure → targeted repair with per-violation `{message, hint}` pairs and real `retryCount`; full `materializeScreenedRepo` only after repeated failure | One violation → workspace preserved, distinct hint |
| 3.7 | Gitignored paths visible (H5) | Snapshot/diff via `git ls-files -co` (no `--exclude-standard`) minus `.git`/`node_modules`/pm caches, both for the prep diff and the script-writing boundary; a created ignored file reachable from the start command is a violation | Agent writes `dist/index.html` → detected |
| 3.8 | Enforcement is not optional (H5, S8, S9) | `captureWorkspaceDiff` + `capturePreparationWorkspaceDiff` required in the dependency types; `assertPreparedFeatureInventory` called from the orchestrator beside `assertPreparationRuntimeTarget`; script-writing violations produce the existing `"script modified app source"` classification (routable) instead of a hard throw | Dependency set without diff capture → construction error |
| 3.9 | `isWithin(".")` ownership (C6) | Root candidate owns nothing exclusively when used for sibling attribution — one line in `prepared-feature-inventory.ts` | Root app + `apps/docs` selected → no throw |
| 3.10 | One contract, two views (S10) | Propagate reader constraints (`entryPaths` `^[/#?]`, repo-relative patterns, `baseUrl` local-http) into the agent-facing JSON Schema; assert exact requested-feature text; reject residual template values in `id`/`description`; delete unread `contractVersion`; `repair` becomes a discriminated union (S13) | Agent writes `entryPaths: ["tracker"]` → schema tells it before a round-trip burns |

**Gate:** fidelity suite gains the adversarial cases above **plus** must-pass cases for legitimate
prep; matrix fixtures (b) and (c) pass preparation.

## Phase 4 — WS4: Security boundaries (C3, C4, H1, H2, H3)

Independent of Phases 1–3; can proceed in parallel after Phase 0.

| # | Fix | Change | Test first |
|---|---|---|---|
| 4.1 | One secret-predicate module (C3) | `repo-security/secret-predicates.ts`: env files (`^\.env($\|\.)`, `\.env$`, `.envrc`, `.npmrc`, `.netrc`, `.pgpass`, `*.tfvars`), broadened key detector (`[A-Z0-9 ]*PRIVATE KEY( BLOCK)?`, PuTTY, `.p8/.jks/.ppk`), content fallback (`^(export\s+)?[A-Z0-9_]{3,}=\S` non-placeholder). Consumed by quarantine, screen, profiler, snapshot — deletes the four drifted copies | `.envrc`/`prod.env`/`.npmrc` quarantined; `.env.example` kept |
| 4.2 | Prove the tar is screened (C3) | Post-`git archive` assertion: no excluded path among tar members. One integration test with a **real** temp git repo through the **real** `RepoSnapshotGit` | The only test of the only mechanism that removes secrets |
| 4.3 | No silent unscanned files (C3) | `scanned` flag from the reader; unscanned `package.json` → rejection; raised cap for package manifests; anchored script regexes (`rm -rf /(\s\|$)`, `\bmkfs\.\w+`); "no package.json" moves to the unsupported path; symlinks with any `..` component rejected; walk excludes `node_modules`/build output with a cumulative byte budget; clone gets `--filter=blob:limit` + timeout | 129 KiB package.json with `rm -rf /` → rejected, not passed |
| 4.4 | Install window without script execution (C4) | Gate *appends* the per-manager script-suppression flag (`--ignore-scripts` / `--mode=skip-builds` by detected yarn major) when absent; yarn path routed through `scoped()` (fixes the Berry/workspace-scope bug) | `bun install` arrives at the sandbox with `--ignore-scripts` |
| 4.5 | Verified reseal (C4) | Gate `finally`: catch close error, retry, read back network settings, attach as secondary; provider close-direction swallow removed | Close 502s once → resealed and verified; install failure preserved as primary |
| 4.6 | Nonce'd in-band protocols (H1) | Per-run random nonce templated into: runtime-network-guard marker (parser requires it), capture/validation markers, and the exit sentinel (unique + **last**-match). `screenshotPath` constrained to the known remote run dir. Undeclared-scene action marker → throw (align with scene/step) | Forged marker/sentinel in app stdout → ignored |
| 4.7 | Replay integrity (H2) | `sha256`+`sizeBytes` carried into browser replay entries and verified (memoized, mirroring the Node guard); admitted `resourceType` recorded per manifest entry and enforced against `request.resourceType()`; `x-content-type-options: nosniff` added to fulfillments and the header allowlist | Tampered cached file → blocked; image-URL-as-script → refused |
| 4.8 | Resolve-and-compare paths (H3) | Replace `readLocalPath` regex with `new URL(path, baseUrl).origin` equality; validate `route` shape in `readActionCatalog`; ground `assert-url` like `goto` | `/\evil.com`, `/\t\evil.com` → rejected |
| 4.9 | SSRF regression net (M) | Real redirect cases in the `node:https` mock (→ private IP, → `http:`, → raw IP, chain > max); address/redirect policy as a pure function applied to any fetcher's `finalUrl`; narrow the `TypeError` abort; `Object.hasOwn` in compositing guards; standard-port restriction on controller fetches | Redirect-to-private → `ExternalResourcePolicyError` even via injected fetcher |
| 4.10 | Sandbox lifecycle (M) | Agent sandbox gets `autoDeleteInterval` backstop; compensating deletes via `allSettled` + secondary attach; handle Daytona conflict-class errors; wire `onStderr` through the 4-arg SDK overload (or delete it from the seam) | Create-retry after response loss → no orphan |

**Gate:** red-team suite (forged markers, tampered replay, secret-shaped fixtures) green; these are
permanent regression tests.

## Phase 5 — WS5: Monorepo generality (C6, H-monorepo, M)

The "wide variety of repos" workstream. Principle: **deterministic evidence or fail-closed with the
candidate list** — never guess silently.

| # | Fix | Change | Test first (fixture layouts) |
|---|---|---|---|
| 5.1 | Token-delimited script matching (C6) | Delimited-name match + reject root scripts referencing any *other* workspace name | `@a/web` vs `dev:web-admin` → no match |
| 5.2 | Fail closed on zero candidates (C6) | Monorepo + empty `browserRuntimeCandidates` → `RuntimeTargetSelectionRequiredError` listing `candidateAppDirs`; evidence gate uses the existing (currently unreachable) `isStrongCustomBrowserEvidencePath` instead of the dir-name allowlist | App under `apps/web/lib/` → found; none → actionable error, never `appDir: "."` |
| 5.3 | Package-manager precedence (C6) | `packageManager` field → single lockfile → nearest declaration → manager-preference tiebreak; assumption recorded when lockfiles conflict | Stale `package-lock.json` + `"packageManager": "pnpm@9"` → pnpm |
| 5.4 | One `run-planner/package-commands.ts` (H, M) | Shared: port extractor (`--port[= ]`, `-p[= ]`, `PORT=`, `-l`, last match in the *selected* script), install/build/start builders (`<pm> run <script>` always — kills `bun build`), dev-server predicate over the script *body* (kills `serve -s dist`), `readPackageName`. Deletes the tri/duplicated copies; `baseUrl` port comes from the selected script | `vite --port=4300` → 4300; `serve -s dist` → build required |
| 5.5 | Correct install closure (H4/M6) | Filter closure to `isWorkspace !== false`; append root selector for pnpm when root declares `prepare`/`postinstall`; expansion scans stderr/stdout excerpts too | `file:`-dep never becomes `--filter`; husky root prepare survives scoping |
| 5.6 | Workspace-config parsing (H6) | `pnpm-workspace.yaml`: optional indent + brace-glob support (full YAML lib only if a real repo breaks the minimal parse); `lerna.json` packages read | Zero-indent YAML → monorepo detected |
| 5.7 | Role safety (M2/M3) | Non-`product` role not selectable while a `product` candidate exists; storybook/e2e evidence (`.storybook/`, `*.stories.*`, `cypress`, `@playwright/test`) feeds the profiler; single-candidate auto-lock escalates when its evidence looks docs/showcase; `resolvePreparationRuntime` returns `{status:"unresolved", reason, candidateIds}` | Storybook-only candidate → escalation, not silent lock |
| 5.8 | Delete `findBuildScopeViolation` (M ✓ Midday-shaped) | Scope builds via `runtimeTarget.build.cwd`, which already owns this generically | Turbo repo without `build:<name>` convention unaffected |
| 5.9 | Linear-time profiling (M8) | Bucket files by owning package in one pass (sorted dir list), then index — removes O(files×candidates×packages) | Synthetic 70k-file profile < 1s |

**Gate:** matrix run — all three fixtures select the right target, install scoped, start on the right
port. Then one **new real-world repo** (e.g. cal.com or a random OSS Next app) end-to-end.

## Phase 6 — WS6: Script contract & capture (C7, H4, H9)

| # | Fix | Change | Test first |
|---|---|---|---|
| 6.1 | Placeholder scan scoped (C7) | Run only over agent-authored free text (`humanReadableDescription`, `expectedVisibleOutcome`); never over maker labels or grounded values | Feature "Add a TODO" → full pipeline contract passes |
| 6.2 | Humanization in the compiler (H4) | `compileAction` emits `humanType`/`animatedClick`/`animatedScrollTo` directly; **delete** `stylizeBrowserActions` + both `chromium.launch` sniffs; `tsc` validation runs on the exact artifact that executes | Fill value containing `.fill(");` → correct program, injection test green |
| 6.3 | Evidence survives capture failure (H9) | Failure cleanup removes only `work/`+`raw-scenes/`; unique per-attempt capture run id + remote video-scratch cleanup (re-capture path works); `exitCode ?? 0` → missing code is failure; `137` classified as timeout alongside `124`; `context.close()` error attached, not substituted | Failed capture leaves `scene-markers.jsonl` + logs; second capture in one run succeeds |
| 6.4 | Unconditional reset proof (H9) | `captureRuntimeReset` validated at the top of `captureScenesFromScript` regardless of injected recorder | Injected recorder without proof → error |
| 6.5 | Truthful contract surface (M) | Canonical-narrative mode removes synthetic scenes/transitions from the agent-facing schema+examples; narrative rejects-with-message instead of silently filtering; `markUnresolved` gets `failureClassification: "external network attempted"`; validation timeout derived from a per-action cost model over the compiled plan | Agent-authored text scene → explicit error naming the rule |
| 6.6 | Delete legacy `demoPlaywrightScript` (audit deletion) | Remove the schema field, `capture-scenes` passthrough, and the now-redundant regex lint in `capture-sdk-contract.ts` (~150 lines) — closes the last disk-file→arbitrary-Playwright path | `parseDemoScript` rejects the field everywhere |
| 6.7 | Bounded failure output (H9/M) | Truncate in `formatSceneFailure` + `sanitizeObservabilityError`; reference retained log paths instead of inlining streams | Project record error ≤ 2 KB |

## Phase 7 — WS7: Agent-harness consolidation (H6)

One refactor resolves the loop-pathology class by construction.

1. **`runAgentArtifactStage({stage, artifactPath, prompt, parse, template?})`** replacing the six
   near-identical loops (~300 lines): uniform artifact-read-before-exit-code precedence, timeout →
   clear session + transport classification, malformed-JSON diagnose/preserve/reset/fingerprint for
   *all* artifacts, bounded error feedback (1.9), denial derived from backend permission state rather
   than agent prose. Test: the existing per-stage behavioral tests re-pointed at the helper, plus the
   previously-missing cases (valid FlowSpec written before crash → accepted; timeout → session
   cleared).
2. **Prompt transport by file** — `writeTextFile` + `opencode run "$(cat …)"`; removes the PTY
   `MAX_CANON` risk and the 4 KB single-line JSON hazard. (Verify the hazard first with one >4 KB
   probe against the real transport — audit uncertainty #4.)
3. **One stage→artifact-path map** consumed by runner permissions, prompts, and the orchestrator's
   manifest (deletes 4 divergent encodings).
4. **Real-OpenCode contract test** in the sandbox image: session-id recovery, denied write actually
   fails, large prompt intact. Decision point: if `--dangerously-skip-permissions` defeats the
   permission table, drop the flag; the explicit table is the contract.
5. **Job-level deadline** — one env-configurable wall-clock budget (default 90 min) checked in the
   orchestrator loop; converts the 7-hour worst case into a classified timeout with the accumulated
   evidence.
6. Prompt dedup into shared instruction constants (the `offCameraAuthenticationInstruction` pattern,
   extended).

## Phase 8 — WS8: Deletions & cleanup

Land the audit's deletion table as a short series of `refactor:`/`chore:` commits, each provably
behavior-neutral (suite green before/after): dead recorder + its 729-line test, `workspace.interface`
slimming (required core + explicit submitted-code sub-seam; drop `getPreviewUrl`/`downloadFiles`),
`submitted-code-execution.ts`, `approved-fonts/music` → single source, protocol wrapper twins,
byte-identical helper copies, `terminal-demo-runner` passthrough, unreachable throws, dead
`read-only-boundary` allowlist, AppMap flattening, explorer `createRouteLocatorCandidates`, unused
fonts. Add test-aware knip config so exported-but-only-test-used code counts as dead.

---

## Sequencing summary

```
Phase 0 (settle WIP, fixtures)
  ├─ Phase 1 WS1 failure semantics ──► Midday gate
  ├─ Phase 4 WS4 security (parallel track)
  ▼
Phase 2 WS2 exploration ──► Midday gate
  ▼
Phase 3 WS3 fidelity ──► Midday + fixture-prep gate
  ▼
Phase 5 WS5 monorepo ──► full matrix + 1 new real repo
  ▼
Phase 6 WS6 contract/capture ─► end-to-end video on 2 repos
  ▼
Phase 7 WS7 consolidation ─► suite green, cost ceiling in place
  ▼
Phase 8 WS8 deletions
```

Rationale for the order: 1 makes failures truthful (everything after debugs faster); 2+3 break the
observed failure spiral (highest run-success ROI); 4 is independent and safety-critical, so it runs
in parallel rather than waiting; 5 is the generality payload but needs 1–3 so matrix failures are
diagnosable; 6–8 are correctness-preserving hardening and shrinkage.

## Acceptance criteria (whole plan)

1. **Reliability:** 3 consecutive green Midday runs; all three fixture repos produce a final video.
2. **Generality:** one previously-unseen OSS repo passes end-to-end without code changes; every
   fail-closed path emits an error naming the ambiguity and the input that resolves it.
3. **Security:** red-team suite green — screened tar provably lacks quarantined paths; forged
   markers/sentinels ignored; tampered replay blocked; `/\evil.com`-class paths rejected; install
   runs with scripts suppressed; reseal verified.
4. **Truthfulness:** no code path converts an infra error into a repo-blaming artifact; success is
   never discarded by cleanup; every terminal failure carries stage + classification + evidence.
5. **Minimality:** net LOC change for the whole plan ≤ 0 excluding tests and fixtures.
6. Full `bun run lint && typecheck && test && knip` green per commit, per repo rules.

## Explicit non-goals

- No new orchestration framework, queue, or plugin layer — every fix lands inside an existing seam.
- No speculative repo-type support (Rails/Django/Go UIs remain out of scope until a fixture exists).
- No retry added anywhere a failure is deterministic (retries only for the classified-transient class).
- No prompt-text unit tests (per repo testing rules); prompts change only where a validator enforces
  the same rule.

## Addendum (2026-07-27, after three-repo validation runs)

Runs on memos (Go root + `web/` React app), homer (single-package Vite), and linkwarden (Yarn Berry
monorepo, `apps/web` + `apps/mobile`) — artifacts in `.makeademo-terminal-runs/terminal-2026-07-27T*`.

**Confirmations (no plan change).** Homer succeeded end-to-end — the first non-Midday final video;
the single-package path and workspace-yaml parse held. Memos was *not* security-rejected and the
profiler correctly selected `web/` in a Go-rooted repo — selection generality is better than the
worst case feared. Linkwarden's ambiguity error was exactly the actionable fail-closed behavior
Phase 5 aims for ("Set demoBrief.preferredAppDir to one of: apps/web, apps/mobile").

**New finding N1 (High) — flow-lock catch-22, no route back to Flow Planning.** Memos died in a
structurally unwinnable loop: FlowSpec selected `fill-interaction-2-1` (exploration-verified,
confidence 0.98), dynamic validation failed twice on the identical fresh-state locator timeout
(`getByLabel('Filter queries by query key')` never visible), locator-regrounding re-ran and
reproduced the same catalog entry, and when script repair dropped the failing action, static
validation correctly rejected the script for not covering a FlowSpec-selected action — until the
budget exhausted. The Action Catalog contained viable same-feature alternatives
(`select-interaction-2-2`, `click-link-2-5`) that nothing was allowed to swap in, because Flow
Planning never re-runs. **Plan change → new Phase 6.8:** when the same FlowSpec-selected action
fails dynamic validation twice (post-regrounding), deterministically re-plan that feature's flow —
prefer a backend swap to an alternative exercised same-feature action from the catalog; fall back to
one bounded Flow Planning re-run with the failing action excluded. This also subsumes the audit's
finding #8 (regrounding/reset lack repair paths) under one rule: every repeated validation failure
must have an escape that changes an *input*, not just a retry.

**New finding N2 (Medium) — exploration evidence is state-contaminated.** The failing locator was
"verified" during exploration only because exploration checks elements after earlier interactions
mutated page state; validation navigates fresh. **Plan change → extend Phase 2.5:** after a route's
interactions, re-navigate once and re-verify visibility of collected locators from fresh state; mark
each action `freshStateVisible`, and have Flow Planning prefer fresh-state actions (this is what
would have made memos pick the calendar select instead of the hidden filter input).

**New finding N3 (Medium) — native mobile workspaces count as browser candidates.** Linkwarden's
Expo `apps/mobile` blocked auto-selection of the only real browser app. **Plan change → extend
Phase 5.7:** exclude (or heavily downrank) workspaces whose dependencies mark them native
(`expo`, `react-native` without `react-native-web` entry, `.expo/`), so a lone remaining browser
candidate auto-selects.

**Reprioritization.** Phase 5's fail-closed selection work is partially validated (the ambiguity
error path already behaves well); N1 is now the highest-value single fix after Phase 1 — it killed
the only deep non-Midday run, on the pipeline's most common late-stage failure shape
(locator drift), and it converts a whole terminal-failure class into a self-healing one.

## Open decisions to confirm before Phase 4/7

1. **Lifecycle scripts** (4.4): suppress-always is the minimal safe default, but some apps need
   `postinstall` codegen (`prisma generate`). Proposed: suppress during the network window, then run
   a **network-closed** `rebuild`/`postinstall` pass only when preflight fails with a
   missing-artifact signature. Decide when the first fixture needs it.
2. **`--dangerously-skip-permissions`** (7.4): keep only if the contract test proves the permission
   table still binds; otherwise remove and accept slower OpenCode runs.
3. **YAML parsing** (5.6): stay with the minimal regex relaxation vs. adding a yaml dependency —
   decide on first real-repo failure, not preemptively.

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

## Addendum (2026-07-28, after the post-Phase-1 Midday run)

Run `terminal-2026-07-28T23-59-37-121Z`, the first Midday run with all nine Phase 1 fixes
in place. **Phase 1 gate: passed.** The run failed in 8.5 minutes (previously ~40) with a
truthful terminal error — real stage (`app-exploration`), real classification, the failing
route and error text preserved, per-attempt artifacts intact, no masked 502s. The causal
chain is fully readable from the artifacts for the first time.

**Confirmation — Phase 2 is exactly the Midday blocker.** The terminal failure is the C2
global error gate: exploration attempt 1 died on `goto: net::ERR_ABORTED` at `/` (dev
server mid-recompile) and attempt 2 on a Turbopack lazy-chunk load error at one deep route
(`/account/date-and-locale`), with only one grounded observation before the gate killed the
run and five preparation repairs were burned on browser-transient noise no repo edit can
fix. **Plan change → sharpen Phase 2.1:** dev-mode browser-transient errors (chunk-load
failures, HMR/dev-overlay errors, `ERR_ABORTED` during recompile) are route evidence,
never terminal, and must not enter the repair router at all; the scoped gate fails only on
ungrounded features or unreachable feature entry routes.

**New finding N4 (Medium) — non-registry dependency tarballs fail the install window as a
generic install failure.** Midday pins `xlsx` to `https://cdn.sheetjs.com/...`, and the
first install died with `ConnectionClosed downloading tarball`, costing two repair rounds
plus a failed lockfile reconciliation before a later install happened to succeed.
**Plan change → extend Phase 4.4 and the Phase 1.3 transient class:** (a) one bounded
in-gate install retry when the failure carries a network signature (`ConnectionClosed`,
`ECONNRESET`, registry 5xx) before any agent repair; (b) when the install-window network
policy itself blocks a lockfile-declared host, classify as
`external network required` naming the host instead of `install failure`, so the failure
states its actual cause. Lockfile-declared tarball hosts are part of the dependency
closure and must be permitted during the install window.

**New finding N5 (Low, bounded by landed fixes) — lockfile-edit rejection loop.** The
dependency-repair agent twice edited `bun.lock` and was correctly fidelity-rejected,
consuming two of five repairs. The landed 1.6 fingerprint now caps identical rejections at
two, and Phase 3.6's per-violation hints cover the feedback; additionally, the
dependency-repair prompt should state the already-validator-enforced rule that lockfiles
are backend-generated (allowed under the non-goals: the validator enforces it).

**Reprioritization.** Unchanged in substance — Phase 2 (with the sharpened 2.1) and Phase
6.8 remain the top two; this run moves Phase 2 ahead of 6.8 for Midday specifically, since
exploration now dies before any flow is planned. N4's bounded install retry is small and
belongs with the Phase 2 batch since Midday hits it first.

## Addendum (2026-07-29, after the post-Phase-2 Midday and homer runs)

Runs `terminal-2026-07-29T02-20-53-693Z` (midday) and `terminal-2026-07-29T02-40-31-919Z`
(homer), both with all Phase 1 + Phase 2 fixes. Both failed, both informatively.

**Phase 2 gate: passed on the evidence level.** Homer's exploration discovered the
hash-switched `/#additional-page` through the new post-interaction enqueue and
fresh-verified its controls — the Action Catalog was correct and reproducible. Midday
never reached exploration (see N7), so the exploration gate is untested there.

**New finding N6 (High) — a scene can pass static validation without navigating to its
route, and navigation cannot be added.** Homer's FlowSpec selected a fill and an assert on
`/#additional-page` but no navigate action. Static validation then (a) rejected the script
agent's attempts to add a goto ("was not selected for FlowSpec feature"; "type goto does
not match ActionCatalog kind assert") and (b) accepted the final scene that fills and
asserts without ever navigating there. Capture deterministically failed the assert from
`/` four times; five script repairs were spent inside the same catch-22 class as the memos
flow-lock — the fix required changing an input no repair path may change.
**Plan change → new Phase 6.9 (do before 6.8):** navigation is infrastructure, not
feature content — a scene's route is derivable from its actions' catalog routes. Either
the backend compiler inserts the goto when the next action's route differs from the
current one, or static validation always permits a goto targeting a selected action's
route (making Script Repair's rejected fix legal). Prefer whichever is smaller in the
compiler seam; the agent should never have to author navigation the catalog already knows.

**New finding N7 (Medium) — persistently unreachable dependency hosts need honest
classification, not retries.** Midday's `xlsx` tarball from `cdn.sheetjs.com` failed with
`ConnectionClosed` for the third consecutive run, including through N4's in-gate retry;
the install window opens egress fully (`networkBlockAll: false`), so the host is
unreachable from the sandbox itself (datacenter-IP blocking, most likely) and no retry
policy applies. Repairs never addressed the dependency; one eventually made the install
pass with the package absent, and the app 500'd at preflight as `missing dependency`.
**Plan change → extend N4:** when the post-retry install failure still carries a network
signature, classify it `external network required`, name the unreachable host and package
in the summary, and hint the repair agent to pin a registry-hosted version or vendor the
package. The repair prompt may state that rule because the classifier enforces it.

**Note on the homer regression.** Homer succeeded on 07-27 and failed now because the
Phase 2 grounding contract changed the catalog composition Flow Planning sees (features
now ground through exercised fills, and the agent stopped selecting navigate actions).
The latent N6 hole predates Phase 2; stronger evidence exposed it. This is the expected
direction: failures are moving later in the pipeline and getting more specific.

**Reprioritization.** 6.9 (navigation derivability) is now the single highest-value fix:
it is small, it unlocks homer end-to-end, and it removes one of the two legs of every
observed flow-lock. Then 6.8 (bounded re-planning escape), then N4's classification
upgrade for Midday, then Phase 3.

## Addendum (2026-07-29, after the 6.9/6.8/N7 gate runs)

Runs `terminal-2026-07-29T03-29-00-693Z` (homer) and `terminal-2026-07-29T03-43-31-621Z`
(midday), both with 6.9 + 6.8 + N7 on top of Phases 1–2.

**Homer: first fully clean end-to-end run.** `pipeline.succeeded`, `composite/final-video.mp4`,
~8 minutes, zero repair stages of any kind. All three browser scenes start with a
navigate-grounded goto — including `goto /#additional-page`, the exact scene N6 deadlocked —
and capture-path validation passed on the first attempt. 6.9 is validated in the wild; 6.8
never triggered (it remains an untested backstop, which is the desired state).

**Midday: N7 worked; the terminal blocker moved one layer down (N8).** The classification
fired verbatim ("Dependency install cannot reach cdn.sheetjs.com for package xlsx") and the
hint steered the repair agent to real fixes. The six-attempt trace: (1) fidelity rejection —
`layout.tsx` UI modification; (2) fidelity rejection — `next.config.ts` demo-gate wiring;
(3) fidelity pass → preflight fails on the CDN (first N7 hint); (4) fidelity rejection —
hand-edited `bun.lock` (the N5 guard, now costing one attempt instead of looping);
(5) **fidelity pass with the textbook fix** — root `"overrides": {"xlsx": "0.18.5"}` —
→ preflight still fails downloading the CDN tarball; (6) fidelity rejection — rewrote the
`export.ts` call site to drop `node-xlsx` (feature logic; correctly forbidden) → budget
exhausted after 5 repair attempts.

**New finding N8 (High) — bun downloads URL tarballs during resolution even when an
override discards them, so `overrides` cannot rescue an unreachable tarball host.**
Verified locally on bun 1.3.14 (the sandbox version) with registry-reachable/CDN-blocked
networking: `node-xlsx@0.24.0` + root override `xlsx → 0.18.5` fails with
`ConnectionRefused downloading tarball xlsx@https://cdn.sheetjs.com/...` on both a fresh
resolve and a stale-lockfile re-resolve. No lockfile-regeneration strategy on our side
changes this. The CDN reference lives in `node-xlsx`'s own manifest (`node-xlsx@0.24.0` pins
`xlsx: https://cdn.sheetjs.com/...`; `node-xlsx@0.22.0` still resolves registry
`xlsx: ^0.18.5`), so the only fidelity-legal, in-sandbox fix is **changing the direct
dependent's version in package.json** to one whose transitive graph is registry-only —
`node-xlsx@0.22.0` qualifies and keeps the same `build()` API.
Vendoring is not actionable from inside the sandbox: the host is unreachable, so the agent
cannot fetch the tarball to vendor it.
**Plan change → N8 (small, before Phase 3):** sharpen the `external network required`
hint in the same branch N7 added: (a) delete the "or vendor it into the repository"
clause; (b) state that `overrides`/`resolutions` cannot bypass an unreachable tarball URL
because the package manager still downloads it during resolution; (c) instruct the agent
to search the lockfile for the direct dependency whose manifest pins the unreachable URL
and change **that** package's version in package.json to one that resolves entirely from
the registry. Prompt-text only; no new mechanism.

**Budget shape observation (no change yet).** The 5-attempt global repair budget was split
across three unrelated threads (UI fidelity, demo gate, network dependency), leaving two
attempts for the real blocker. The N8 hint should collapse the network thread to one
attempt; restructure budgets only if a post-N8 run still exhausts.

**Priority confirmed.** Phase 3 next (this run is a live fidelity-contract specimen: three
of six rejections were fidelity calls, all accurate), Phase 4 still parallel-capable. One
new open decision added below.

## Addendum (2026-07-29, after the post-N8 Midday run)

Run `terminal-2026-07-29T04-31-15-410Z` (midday), with N8 on top of everything prior.

**N8 gate: passed completely.** The repair agent followed the sharpened hint to the letter:
pinned `node-xlsx: ^0.21.0` (resolving registry `xlsx@0.17.5`), the backend reconciled the
lockfile, fidelity passed, preflight passed with Runtime Network Lockdown active. The
dependency saga that consumed four generations of runs is closed. Midday reached App
Exploration for the first time.

**New finding N9 (High) — the submitted-code sandbox silently kills heavyweight dev
servers, and the death is misclassified as an app bug.** During exploration the app
(`next dev --turbopack`) exited code 0 with no stderr while serving pages (first Turbopack
route compile: 21.6s). The external-resource broker had just hydrated one blocked asset
(`openpanel.dev/op1.js`), restarted the app, and the restarted instance died the same
silent way mid-pass. The harness never stopped it; the sandbox stayed alive; sessions
stayed intact. The submitted-code sandbox is created from its snapshot with no explicit
cpu/memory sizing — a default-class Daytona sandbox is far below what a Turbopack monorepo
dev server needs, making cgroup OOM (which tears down the process tree with a clean session
end) the only hypothesis consistent with all evidence. Downstream, `app route crashes`
routed the failure to preparation repair, whose agent — shown the Next.js
`allowedDevOrigins` warning from the log excerpt — burned the remaining budget on
fidelity-illegal edits (`bun.lock` again, ungated `next.config.ts`, `layout.tsx`).
**Plan change → N9 (do before the next Midday gate, alongside Phase 3):**
(a) size the submitted-code sandbox explicitly for dev servers (cpu/memory via create
params or a larger snapshot class — confirm which the SDK supports at implementation);
(b) when the app exits during exploration or preflight, capture OOM evidence from the
sandbox (`/sys/fs/cgroup/memory.events` oom_kill counter, `free -m`) into the failure
report, and classify environment-killed apps as an infrastructure/capacity failure that
does **not** route to preparation repair — an agent cannot fix RAM by editing code.

**New finding N10 (Medium, fold into Phase 3) — repair prompts lack the standing rules the
validators enforce.** The repair agent hand-edited `bun.lock` twice more this run; both
rejections repeated "lockfiles must be generated by the backend package manager." That rule
(and the demo-gate requirement for config changes) lives only in the fidelity validator.
State both as standing constraints in the preparation-repair prompt context so attempts stop
dying on known-illegal moves.

**Priority.** N9 first (small, unblocks the next Midday gate), then Phase 3 with N10 folded
in. Phase 4 remains parallel-capable.

## Addendum (2026-07-30, after the post-N9/Phase-3 Midday run)

Run `terminal-2026-07-29T23-34-31-233Z` (midday), on the 4-cpu/8-GiB snapshot with all of
Phases 1–3 (through commit `204568f`; the 3.7/3.10 commits may have raced the run start).

**N9 gate: passed.** No OOM, no silent exit — the app served 22 crawled routes and stayed
healthy through the whole run. The capacity ceiling is gone.

**Phase 3 checks: no false positives.** All fidelity rejections were pre-existing rules
firing correctly (initial layout.tsx UI edit; two `bun.lock` hand-edits), and
`next.config.ts` never re-entered the failure set (the 3.5 exemption held). The N8
dependency chain was re-fixed by the agent in two attempts (each run starts from the
unfixed repo, so the xlsx cycle recurs by design).

**New finding N11 (High) — exploration cannot exercise interactions on hydration-heavy,
dense-UI apps, so strict grounding reports 0 features.** Exploration ran once, ~75s for 22
routes, `browserObservations: 0`, and failed as `prepared feature not observable` (0 of 3).
The interaction loop's guards filtered every candidate: (a) `getByRole("button", {name,
exact: false})` must match exactly one element — dense dashboards repeat button names and
`exact: false` widens matches, so `count() !== 1` skips almost everything; (b) icon-only
buttons carry empty accessible names and are skipped outright; (c) the click-outcome window
is a fixed 350ms — hydration-heavy pages have not attached handlers or finished animating,
so no visible outcome is observed and the interaction is dropped. The failure text blames
the preparation, but no repository change can fix explorer fragility — the two repairs the
budget would have granted were unwinnable (and in fact the budget was already exhausted by
the xlsx + fidelity threads, so the grounding failure got zero).
**Plan change → N11 (next implementation batch):** (a) wait for hydration before
interacting (readiness beyond `domcontentloaded` — e.g. bounded network-quiet or
mutation-settle instead of the fixed 250ms); (b) widen the outcome window to a bounded
mutation-aware wait (~1.5s) instead of 350ms; (c) resolve repeated-name buttons instead of
skipping: scope to the first match inside `main`/`nav` landmarks (the previously deferred
matchCount>1 work, now load-bearing); (d) on exploration failure, mirror
`exploration.json`, `app-map.json`, and `action-catalog.json` into local run artifacts —
this diagnosis required inferring from timing because none were persisted.

**New finding N12 (Medium) — prompt rules do not bind; salvage lockfile edits
deterministically.** The agent hand-edited `bun.lock` twice *despite* the N10 standing rule
in its prompt. The validator caught both (one attempt each). Since the backend regenerates
lockfiles anyway, a repair patch touching only-lockfiles-plus-legal-files should have the
lockfile hunks stripped and proceed, not burn an attempt.

## Addendum (2026-07-30, after the post-N11 Midday run)

Run `terminal-2026-07-30T00-18-52-089Z` (midday), with N11 and the `4be064d` gate fix.

**N11 evidence mirroring: validated immediately.** The run failed at grounding again, and
`attempt-1-observation.json` made the diagnosis a three-command read instead of a
timing reconstruction: 10 routes crawled, 0 interactions, and — decisively — 9 of 10
routes rendered **empty** (no headings, no text, no buttons) with 18 page errors all
reading `Module not found: Can't resolve 'use-stick-to-bottom'` plus 500s. The explorer
observed truthfully; the app was broken. The interaction changes remain unproven on a
healthy Midday (the one content-bearing route had 3 buttons, 0 exercised — insufficient
sample while 90% of the app was down).

**New finding N13 (High) — scoped workspace installs omit root-declared dependencies, and
grounding failure masks the runtime evidence.** `use-stick-to-bottom` is declared only in
midday's **root** package.json; dashboard source imports it relying on hoisting. The run
plan's `bun install --filter=@midday/...` list never includes the root workspace, so root
dependencies are structurally absent and every chat-widget route crashes. (Earlier runs
predate upstream's chat widget — each run clones HEAD, so upstream drift activated the
latent hole.) Downstream, the failure surfaced as `prepared feature not observable`, and a
repair agent was asked to fix feature observability when the real problem was a missing
module — unwinnable routing.
**Plan change → N13:** (a) include the root workspace in scoped bun installs (or drop the
filter when root dependencies exist); (b) exploration failure classification must prefer
load-breaking runtime evidence: when page errors carry module-not-found (or dominant 500s),
classify `missing dependency` naming the module — routing into the dependency-repair
machinery that already works — instead of `prepared feature not observable`.

**Infra note.** The run terminated on two consecutive OpenCode repair commands hanging
silently for 5 minutes (inactivity timeout) — provider stall, not pipeline logic. Watch for
recurrence before adding machinery.

## Addendum (2026-07-30, after the post-N13 Midday run)

Run `terminal-2026-07-30T05-27-19-277Z` (midday). Failed before any pipeline logic: the
very first agent stage (Runtime Target Selection) died three times in 12 seconds, each
OpenCode process exiting 1 within ~3.5s and emitting nothing but PTY prompt noise. The
OpenAI key is valid and the pinned model exists (verified from the workstation), and the
Daytona provider secret ensured successfully — the sandbox-to-provider path itself is the
suspect, consistent with the prior run's two 5-minute silent agent hangs (blackholed vs
refused egress through the secret-substitution path). N13's changes were never reached;
nothing here is midday-specific.

**New finding N14 (High, repo-agnostic) — agent-runner failures are undiagnosable and
unclassified.** (a) On nonzero OpenCode exit the harness excerpts the PTY stream, which
carries only escape codes — the runner's real error (provider status, auth, crash) is
never captured. Capture OpenCode's own error channel (its log file tail, or run headless
so stderr is meaningful) and include it in the failure. (b) Three identical sub-5s exits
retried within 12 seconds is thrashing: classify fast repeated agent-launch failures as an
infrastructure failure naming the agent runner (not "did not produce valid required
artifact", which mis-blames the artifact contract), and space the retries (30s+) so
transient provider blips can clear.

**Action.** Retry the run once before treating this as persistent; land N14 either way —
it is general diagnosability/robustness, applies to every repo, and the next such failure
should name its cause.

## Addendum (2026-07-30, after the post-N13-retry Midday run)

Run `terminal-2026-07-30T05-38-38-791Z` (midday). The provider blip cleared and N13 held:
root dependencies installed, no module-not-found errors, and grounding improved 0/3 → 1/3
across two exploration attempts — the deepest Midday run yet. The remaining ungrounded
features sat on display-only chart/widget routes that render no headings, no `main p`
text, and no named controls, so no assert evidence could exist for them.

**New finding N15 (High, general to display-heavy apps) — display-only routes cannot
produce assert evidence.** Landed as `c58a5e0`: when a route observes zero headings and
zero text, harvest assert candidates from the accessibility tree (`ariaSnapshot`) and
verify each as a unique visible text locator; on grounding failure, name the routes that
carry browser evidence so repairs reselect features onto them instead of guessing.

## Addendum (2026-07-30, after the pipeline-matrix run)

Matrix report `matrix-report-2026-07-30T06-16-23-886Z`: midday failed
(`terminal-2026-07-30T06-04-40-923Z`); vite-spa, pnpm-monorepo, and npm-express-static
were skipped — their `MAKEADEMO_MATRIX_REPO_*` repo URLs are not configured yet, so the
matrix currently gates nothing but Midday.

**This run is not an N15 gate.** The matrix process loaded the explorer module at
06:04:40Z; the session transcript shows the N15 harvest edit was written to
`submitted-app-explorer.ts` at 06:06:30Z (committed 06:07 local as `c58a5e0`). The run
executed the pre-N15 explorer — consistent with its failure message lacking the N15
steering suffix. Midday must be rerun to gate N15. The current script was verified
end-to-end locally instead: the real generated script, extracted from the upload command
and run under bun against a headings-free table page, produced harvest text, 4 verified
text asserts, and an exercised fill — a groundable route.

**New finding N16 (High) — three grounding gaps the run exposes in current code.**
(a) *Observation races streamed content.* `gotoRoute` settles on quiet DOM (300ms/2.5s),
but dev servers serve a DOM-quiet skeleton while compiling or streaming a first-hit route:
`/account` (visited first) observed title-only-empty while `/account/date-and-locale`
(same layout, seconds later) observed 5 verified headings; `/`, `/inbox/settings`, and
`/invoices/products` were empty the same way. Add a bounded content-presence wait
(visible link/heading/control or minimal body text, ~15s cap) between `readyState` and
the quiet settle — a no-op on pages that render immediately.
(b) *The per-feature `exercised` requirement is stronger than its own consumer.*
`/account/date-and-locale` carried 5 verified asserts for `date-locale-preferences` yet
stayed ungrounded: its only controls are combobox trigger buttons whose dropdown-open
produces no describable outcome. The FlowSpec seam already permits navigation + unique
visible assertion when no exercised action exists; exploration grounding should match —
ground on ≥1 verified assert action, keep exercised preferred downstream. Title-only pages
still fail (no verified content → no assert actions), so the 2.5 hole stays closed. Note
N15 alone is structurally insufficient without this: harvested asserts can never satisfy
the exercised leg on a display-only route.
(c) *N15's steering invites fidelity violations.* Post-exploration repairs edited
`layout.tsx` plus 6 settings components to "make features observable" — exactly what the
fidelity gate rejects (2 attempts burned, budget exhausted). The steering text's "or make
the missing features render observable content" clause must go; steer only toward
reselecting `featureInventory` entries onto evidence-bearing routes.
(d) *Latent: repos that ship `@playwright/test` shadow the explorer's runtime.* Verified
locally: bun resolves the explorer's `@playwright/test` import by walking up from
`/workspace/.makeademo/exploration` into the repo's `node_modules`, consulting `NODE_PATH`
only as a fallback. Midday escaped (its 1.58.2 is an uninstalled optional-peer
resolution), but any repo that materializes its own `@playwright/test` pins the explorer
to that version — whose browser revision is absent from the image (1.58 wants
`chromium_headless_shell-1208`; the image ships 1223). Move the explorer script outside
`/workspace` so resolution deterministically reaches the image's pinned install.

**N12 recurrence (priority raised Medium → High).** Two of the five repair attempts were
burned wholly or partly on hand-edited `bun.lock` hunks (attempt-2's rejection was
lockfile-only). The xlsx CDN dependency class makes lockfile edits near-inevitable in
dependency repairs; strip lockfile hunks deterministically instead of burning attempts.

**N16 landed (same day).** `5c8b568` (b + c — with one refinement over the sketch above:
grounding requires an exercised interaction **or** an assert whose visible text
token-matches the feature, not any assert, so a wrong entry route rendering unrelated
content still cannot ground), `353df6d` (d), `eaebf75` (a — applied to every navigation,
including interaction reloads and the fresh-state re-verification, which would otherwise
drop exercised evidence on skeleton-first apps). The explorer also gained its first
behavioral gate: `submitted-app-explorer.script.test.ts` builds the real generated script
and runs it under bun + chromium against a deferred-content page, proving the content
wait, aria harvest, text-locator verification, and fill exercise end-to-end.

## Addendum (2026-07-30, after the post-N16 homer + midday matrix run)

Matrix report `matrix-report-2026-07-30T21-58-31-099Z`. **Homer passed end-to-end**
(final video in ~8.5 min) — the N16 canary held: content wait, new grounding predicate,
and relocated explorer script did not regress the green path. Midday
(`terminal-2026-07-30T21-37-52-105Z`) produced its healthiest preparation yet — fidelity
attempt-1 passed clean for the first time, the xlsx CDN failure was repaired in two
attempts (one burned on an N12 `bun.lock` hand-edit — the recurrence class already
recorded above), and preflight passed with three of five budget attempts unused — then
failed at a new terminal blocker: the exploration command ran its full 300s without
returning (no marker, no artifacts), and the failure path consumed ~7 more minutes of
status reads and teardown.

**New finding N17 (High) — N16a's content wait can push the crawl past the exploration
command budget on streaming-SSR apps.** The wait (≤15s) applies to observation and every
interaction reload; on an app that re-streams each navigation this multiplies a ~90s
crawl several-fold. The script's 210s internal deadline only bounds *starting* new work —
a single in-flight navigation can cost ~150s (60s goto + one retry + readyState +
content wait), far beyond the 90s post-deadline headroom, and NODE_PATH/browser-launch
causes are ruled out (the fallback is proven in-sandbox by the 06-04 run, and the
behavioral test proves NODE_PATH beats bun auto-install in the relocated layout).
**Plan → N17:** (i) clamp the script's long waits — goto timeout, content wait, goto
retry — to the remaining deadline budget so the script always finalizes inside the
command budget, degrading to thinner tail evidence instead of a timeout; (ii) on
command timeout, attempt one read of the durable `exploration.json` before failing, so a
marginally late script still yields its result; (iii) resize
`explorationCommandTimeoutMs` 300s → 420s — the budget was calibrated before
per-navigation content waits existed, and feature entry routes are crawled first, so
added budget goes to feature evidence.

**N17 landed (same day).** `e262382` (ii — with a staleness guard: the run command now
`rm -f`s the durable protocol before the script starts, so a timed-out attempt can never
resurrect an earlier attempt's crawl), `f84db61` (i — gated behaviorally: the real
generated script against a 20s-slow server with a 2s deadline finalizes in ~2s instead
of being killed at 25s), `c39c515` (iii).

## Addendum (2026-07-31, after the post-N17 Midday run)

Run `terminal-2026-07-31T05-10-06-978Z`. **Every open exploration gate passed.**
Exploration completed inside its budget across 12 routes; 9 routes carry harvested text
evidence with exercised search fills (the previous generation observed near-universal
emptiness); grounding went 0/3 → **2/3** (`transaction-workspace`, `invoice-workspace`);
and the reselection steering worked end-to-end — the failure message named 6
evidence-bearing routes, and repair-5 correctly swapped the ungroundable
`dashboard-overview` (entry `/`, a chart page that renders nothing without data, where
the 15s content wait rightly expired) for `transaction-categories` on
`/transactions/categories`, a steered route with full evidence. The next exploration
pass would very likely have grounded 3/3.

**The sole terminal blocker is now N12.** Repair-5's patch also carried a `bun.lock`
hunk (the attempt-5 workspace diff had no lockfile entry; attempt-6 did — the agent's
session re-applied its earlier hand-pin), so fidelity rejected the winning repair and
the budget died. Third consecutive run burning attempts on lockfile hand-edits, this
time terminally. **Implement N12 now:** on a fidelity failure whose lockfile violation
is severable, deterministically restore the workspace lockfile(s) to the recorded
backend-generated content (the workspace-diff mechanism already distinguishes it — the
attempt-5/attempt-6 contrast is the proof) and re-validate, instead of burning a repair
attempt. Lockfiles are backend-owned: package.json drives reconciliation at the next
install window, so stripping agent lockfile edits never desynchronizes the runtime.

**N12 landed (2026-07-31) as `637df1c`, with a correction to the analysis above** (see
the addendum below for the gate result). The
repair-delta attribution is structurally unreliable: preflight-3's successful install ran
its lockfile reconciliation *between* the two diff captures, so the `bun.lock` delta
blamed on repair-5 was most likely the backend's own reconciliation write — the "agent
hand-edited despite the prompt rule" reading in this and earlier addenda was at least
partly misattribution. The landed fix is accordingly simpler and stronger than the
restore-and-revalidate sketch: lockfile paths are no longer fidelity violations at all —
not in repair deltas, not in the modified-original checks. Ownership is enforced where
it actually binds: frozen installation re-derives lockfile content from package.json at
every install window, and the runtime network policy bounds what any lockfile can reach.
No violation, no burned attempts, no attribution problem.

## Addendum (2026-07-31, after the post-N12 Midday run)

Run `terminal-2026-07-31T05-45-22-558Z`. **N12 passed its gate** — zero lockfile
rejections, and the xlsx dependency was repaired in a single attempt (previously two).
The run then regressed to 0/3 grounding through preparation nondeterminism, not code:
same upstream SHA as the 2/3 run, but this preparation selected **all three features on
`/`** and its manifest claimed the overview renders "local deterministic data" — false.
`/` served its title and streamed no body content, so every crawl target normalized into
one blank page with zero links; the frontier collapsed after a single route, nothing
could ground, and the steering had nothing to offer. Three repairs then flailed at
product-UI edits (`[locale]/layout.tsx` twice, `packages/events/src/client.tsx` once) —
all correctly rejected by fidelity — and the budget died.

**New finding N18 (High, general) — a blank-rendering app is classified as a feature
problem.** When exploration reaches routes that serve their document shell but render no
body evidence anywhere (the action catalog holds only `navigate` actions after the
content waits), the failure surfaces as `prepared feature not observable` with no
steering — pointing repairs at feature selection and UI when the defect is the prepared
runtime's rendering (data fixtures or demo gating blocking the whole tree).
**Plan → N18:** in the exploration failure classifier, detect the navigate-only catalog
(routes discovered, zero evidence actions) and classify it as
`empty/unmeaningful app state` — already registered in the repair router's preparation
list and currently emitted by nothing — with a message naming the runtime symptom and
directing the repair at the prepared runtime's fixtures/gating. Frontier-seeding
alternatives were examined and rejected for now: this run's `sourcePaths` all point at
the same page, the repo profile carries no route paths, and `appExplorationHints` is
prose; revisit seeding only if a run shows evidence-bearing routes going unvisited.

**N18 landed (same day) as `2ad4b66`.** The empty-shell predicate is "routes discovered,
catalog holds only structural actions (navigate/scroll)", guarded so unreachable feature
routes keep their sharper own classification.

## Addendum (2026-07-31, after the post-N18 Midday run)

Run `terminal-2026-07-31T06-28-13-825Z`. **The deepest Midday run ever — every agentic
stage passed for the first time**: preparation converged in 4 repairs, exploration
grounded, flow planning and script writing produced a 8-scene script ("Midday
Transaction Workflows"), static and capture-path validation passed, the continuous take
recorded, and two of three scene clips trimmed and probed cleanly. The pipeline is now
failing in compositing-input handling — territory only Homer had reached.

**New finding N19 (High) — capture trusts sandbox-side encodes it cannot verify, and
destroys the evidence when they fail.**
(a) The third remote VP9 trim (`create-transaction.webm`) exited 0 yet left a ~5KB
structurally-corrupt file (ffprobe: "exceeds containing master element… End of file"),
discovered only by the next command. Leading mechanism, matching the N9 precedent
exactly: Daytona session commands report exit 0 for OOM-killed processes, and the third
sequential VP9 encode ran beside the dev server and a just-finished browser recording in
the 8 GiB sandbox. Two clips passing first also fits accumulating memory pressure.
(b) `captureScenesFromScript`'s catch block `rm`s the local capture run directory on
failure with `keepTemp=false`, deleting stdout, scene markers, and downloaded clips
exactly when they are the diagnosis (the 1.8 principle, unapplied to capture).
**Plan → N19:** (i) retain the capture run directory on failure — delete only on
success; (ii) move scene trimming and probing local: always download the raw take
(~tens of MB), reuse the existing local `trimSceneClipWithFfmpeg` +
`probeVideoDurationSeconds`, and delete the remote trim block and
`probeRemoteVideoDurationSeconds` — a net code reduction that removes encoder memory
pressure from the sandbox entirely, unifies the local and remote recorder flows, and
probes the exact artifacts compositing consumes. Rejected alternative: keeping remote
trims and adding OOM classification (N9b pattern) — it diagnoses the failure without
removing it, and local trimming subsumes it.

**N19 landed (same day).** `75f0def` (i — the failure-path `rm` in
`captureScenesFromScript` is gone, and its rethrow-only try/catch with it),
`a6366b3` (ii — the marker-range → clip-range → trim loop both recorders duplicated is
now one shared `trimRecordedScenes` helper; the remote recorder downloads the raw take
and trims through the same injectable `clipTrimmer` seam as the local one; no ffmpeg or
ffprobe command reaches the sandbox anymore). The rewritten remote-flow test pins the
new contract, including that the sandbox-bound output archive carries only the raw take
and that the local raw-take copy is dropped after trimming unless retention is on.

## Addendum (2026-07-31, after the post-N19 Midday run)

Run `terminal-2026-07-31T21-24-39-296Z` (719s). Preparation nondeterminism produced a
different demo shape than the capture-reaching run — this prep scoped Midday to its
auth + MFA surface (a demo-gated `proxy.ts` redirects every other route to
`/mfa/setup`) — and the run died back in exploration repair. Every individual repair
was correct: fidelity attempt-1 was a true positive (the prep agent had rewritten
`mfa-settings-list.tsx` and two sibling components; the repair reverted to a minimal
gated-auth set that then passed three consecutive checks), preflight repairs fixed the
network-blocked `xlsx` CDN tarball (repinned to a registry-resolvable version) and a
307 redirect loop, and exploration completed inside budget. `/mfa/setup` rendered and
grounded `mfa-setup` on assert evidence; `/login` served its title but streamed no body
content (N18's blank-render class, now route-scoped with a healthy sibling route as
contrast), so `sign-in` and `sign-in-providers` never grounded → 1/3, correctly
classified "prepared feature not observable" with reselection steering.

**New finding N20 (Critical) — the fidelity presentation rule vetoes the exact
demo-gated adaptation its own hints prescribe, and burned the run's remaining budget
rejecting a correct repair twice.** The runtime repair agent, acting on the only
network evidence in the observation (openpanel.dev `op1.js` blocked as a script on both
routes), made the textbook edit in the root layout: `+import { isDemoMode } …` plus
`-<Analytics />` / `+{!isDemoMode && <Analytics />}`. Replaying
`validatePreparationFidelity` against the run's own artifacts (attempt-5 diff +
screened sources + manifest) reproduces the verdict exactly, and probing the internal
predicates isolates the branch: the patch adds no presentation by the checker's own
detector (`addsProductPresentation: false`), preserves every removed line
(`readUnpreservedRemovedLine: undefined`), and conditionally uses the bound gate
identifier — but the file's patch carries no auth/integration trigger terms, so it
lands in the `isProductPresentationPath` branch, whose only escape is external-asset
localization. The gated-adaptation contract the hints prescribe ("conditionally select
the demo path while preserving the normal behavior") is structurally unreachable for
any presentation-path file without those terms. The agent, correctly convinced its fix
was right, resubmitted `layout.tsx` byte-identically (attempt-6 differs only in
`proxy.ts`), was rejected identically, and the global budget (5) was exhausted — two of
five attempts consumed vetoing one correct edit. The class is general: analytics
beacons, chat widgets, consent banners, and error reporters live in layouts and pages
across most real apps, and they are precisely what sandboxed demos must gate off.

**Plan → N20:** accept a **gated wrap** in the presentation branch: a patch that (i)
adds no *foreign* presentation, (ii) preserves every removed line
(`readUnpreservedRemovedLine === undefined`), and (iii) conditionally uses the active
demo gate (`hasConditionalDemoGate`) — three existing predicates, no new machinery. For
(i), make the presentation detector original-aware: skip added lines whose trimmed
content already exists in the original file, so the multiline wrap form
(`{!isDemoMode && (` / `<Analytics />` / `)}`) — which the current detector flags —
counts as preservation rather than authorship; the auth/integration adaptation branch
shares the detector, fixing the identical fragility there. The change is
widening-only: the filtered detector can only match less, and the acceptance only adds
a pass lane, so no currently-green repo can regress. Verified by replaying the run's
artifacts against a prototyped fix: attempt-5 flips to passed; attempt-1's true
positive stays failed; a multiline wrap passes; a gated wrap introducing foreign markup,
an ungated re-arrangement of existing markup, and a gated deletion all stay rejected
(CSS files cannot satisfy the gate leg — a flag mention in a comment is stripped, and
CSS cannot express a conditional flag read).

**Secondary finding N20b (Medium) — exploration evidence dies with the sandbox.** The
exploration verdict references `/workspace/.makeademo/exploration/*.png` and
`*.aria.yml` for both routes, but only `writeArtifact` JSONs are mirrored locally, so
the screenshots that would show *why* `/login` streamed no body were destroyed with the
sandbox. Why `/login` blanks while `/mfa/setup` renders (same root layout, same blocked
script; the login page's own server work is demo-gated off) is therefore still open —
the N19 evidence-retention principle, unapplied to exploration. Plan: mirror the
exploration directory into the local artifacts when the exploration verdict fails.

**N20 + N20b landed (same day).** `5d4c135` (N20 — the presentation branch accepts a
gated wrap: no foreign presentation, every removed line preserved, conditional use of
the active demo gate; `addsProductPresentation` now ignores added lines whose content
already exists in the original file, so wrap formatting cannot flip the verdict, and
the adaptation branch shares the same detector). Four new tests pin the lane: the
Midday-shaped single-line wrap and the multiline form pass; a gated wrap introducing
foreign markup and an ungated re-arrangement stay rejected. The run's own artifacts
replay correctly against the landed code: attempt-5 passes, attempt-1's true positive
still fails. `83a113e` (N20b — on a failed exploration, `exploreApp` downloads
`/workspace/.makeademo/exploration` into `exploration-evidence/` in the run directory,
following the wiring's existing `external-resources/` local-evidence pattern rather
than the `artifacts/` JSON mirror; best-effort with `exploration.evidence.persisted` /
`exploration.evidence.unavailable` events, so evidence transfer can never turn a
diagnosable failure into an infrastructure error — the pre-existing failed-exploration
tests, whose fake workspaces lack download support, now pin the swallow path).
Generality verified beyond Midday by replaying framework-diverse scenarios through the
real validator: a CRA Intercom widget wrap (`REACT_APP_` flag), a Vue
`<template v-if>` session-recorder gate (`VITE_` flag), and a SvelteKit `{#if}`
error-reporter gate all pass, while an ungated Vue re-arrangement and a gated React
wrap that injects a new banner stay rejected. Known conservative boundaries fail
closed: reformat-while-wrapping and attribute-level gates (`<div v-if>`) keep the old
strict rejection, and static-HTML script tags have no gate lane at all.

## Addendum (2026-07-31, after the first passing Midday run)

Run `terminal-2026-07-31T22-44-31-689Z` **passed end-to-end in 871s and produced
Midday's first final video** — preparation converged in 2 attempts (one `node-xlsx`
dependency repair), every gate green on the first try, 8 scenes composited. The N20
lane held: the prep's demo gates in layouts and the tRPC client passed fidelity as
gated adaptations. But the video shows an empty application: chrome, headings, and
settings copy render; every data surface is blank.

**New finding N21 (Critical) — a hollow-shell run passes every gate.** Two halves:

*The prep's bug (the class our gates must catch):* the agent authored complete fixture
data (`trpc-fixtures.ts`: three invoices, three transactions, team, user) and a
same-origin `/api/demo-trpc` fixture endpoint — then pointed the browser tRPC client at
the **relative URL** `"/api/demo-trpc"` inside a `"use client"` module that also
executes during SSR, where Node fetch cannot parse a relative URL. Eleven
`TypeError: Failed to parse URL` throws sit in `capture/submitted-app-runtime.log`;
zero successful fixture requests occurred all run. Server-side prefetch was gated off
entirely (`if (isDemoMode) return;`), so nothing hydrated from that side either. Data
subtrees threw — the harvested evidence contains neither fixture literals ("Aperture",
"Figma", "INV-", amounts: grep zero across app-map and action-catalog) nor empty-state
copy ("No transactions": also zero), the signature of a thrown render, not empty data.

*Why every gate passed (the systemic gap, general to any repo):*
(a) Exploration passed as "explored 12 route(s)": nine routes harvested only the
identical 6-string sidebar, two harvested nothing at all, and grounding succeeded
because `exercised` fills count unconditionally — search fills whose outcome is the
self-referential "field contained the observed demo value". The N18 empty-app branch
requires *all* actions to be navigate/scroll and was defeated by those same fills.
(b) The flow spec declared `requiredAppState: ["Invoice fixtures are loaded."]` and
asserted only the sidebar link "Categories" — text present on every route;
`assertFlowSpecGrounded` checks referential integrity, never assert-target quality.
(c) All three script asserts target chrome; capture-path validation passed each in
under 500ms (server-rendered, present on arrival).
(d) The SSR errors sat in stderr no gate reads: preflight reads a curl exit code
(`/invoices` → 200 on the shell), exploration reads browser pageErrors, capture reads
browser consoleErrors.
(e) N20b retains exploration screenshots only on failed exploration; this one passed,
so the 5-second human tell was discarded. Bonus defect: `/tracker?create=true` leaked
raw `number-flow-react` CSS into harvested `headings` (textContent includes `<style>`
text).

**Plan → N21 (a–d), pulled ahead of Phase 4 (which is explicitly parallel):** shared
concept: **navigation chrome** = union of per-route `primaryNavigation` strings plus,
when ≥4 routes exist, strings appearing on more than half the routes;
**route-distinct content** = a route's harvested headings/text minus chrome (buttons,
inputs, and links excluded — controls exist identically in hollow and healthy apps).
(N21a) grounding additionally requires ≥1 feature-tagged route with route-distinct
content; when features fail only on that, classify `empty/unmeaningful app state`
(already routed to preparation repair) naming the chrome-only routes, else keep
reselection steering; emit up to 3 distinct-first text asserts per route (today:
exactly one, first-verified — how "Categories" became the only candidate); broaden the
N15 aria-harvest trigger to "all harvested text ⊆ the route's own nav/link names" and
harvest with `innerText` so stylesheet text cannot fake distinctness. (N21b)
`assertFlowSpecGrounded` requires per feature ≥1 assert targeting non-chrome text —
enforced only when the catalog offers one, so the retry loop cannot wedge; rejection
steering names the qualifying asserts. (N21c) the grounding-failure path attaches a
~2KB managed-app stderr tail as evidence (not a gate — dev servers log benign errors);
repair prompts already interpolate stderr excerpts. (N21d) persist exploration
evidence on success too. Rejected: preflight body/data-endpoint probing (the hollow
shell returns rich 200 HTML; content truth belongs to the browser stage), prose
reconciliation of `requiredAppState` (a fuzzy validator tuned like a prompt — its
checkable shadow is N21b), stderr-content gating (framework whack-a-mole), a
scene-level chrome check in the script contract (`assertBrowserActionsGrounded`
already propagates N21b), and fixture-literal or absolute-URL checks (overfit).
Acceptance: Midday either renders data or fails at exploration with the empty-app
classification and SSR evidence; homer stays green.

**N21 landed (same day).** `5904113` + `b9f2b38` (N21a — `readRouteDistinctContent`
computes Navigation Chrome vs Route-Distinct Evidence, both now CONTEXT.md glossary
terms; grounding additionally requires a feature-tagged content-bearing route; the
hollow case classifies `empty/unmeaningful app state` when no route has content, and
reselection steering names only content-bearing routes otherwise; headingless routes
emit up to three text asserts distinct-first; the aria harvest fires whenever selector
text is only the route's own nav/link names — proven against a real chromium table
page — and all text harvesting moved to `innerText`, killing the stylesheet-in-headings
leak). `b535381` (N21b — `assertFlowSpecGrounded` rejects chrome-only asserts whenever
the catalog offers a route-distinct one, naming the qualifying asserts; contract
invariant added). `64efe7c` (N21c — failed exploration verdicts attach a 2KB
managed-app stderr tail with an inspect-stderr hint; excerpts raised from 500 chars so
one full SSR error survives). `23eb620` (N21d — exploration evidence mirrors to
`exploration-evidence/` on success as well as failure). Replay verification against
the hollow run's own app-map + action-catalog: the artifacts that passed every gate
now fail as "prepared feature not observable" with steering naming exactly the two
routes that genuinely rendered content (`/account/date-and-locale`,
`/tracker?create=true`) — the empty-app classification is reserved for the
no-content-anywhere case, and on a live rerun the verdict additionally carries the
`Failed to parse URL` stderr evidence pointing at the data path.

## Addendum (2026-08-01, after the post-N21 homer + midday matrix run)

Homer failed (`terminal-2026-07-31T23-57-37-519Z`, 417s); Midday "passed"
(`terminal-2026-08-01T00-04-34-456Z`, 1232s) with data still broken. Neither failure
is an N21 regression, and the N21 machinery visibly worked: homer's exploration passed
under the new grounding on its real 2-route crawl, Midday's exploration evidence is
now mirrored locally on success (the screenshots that diagnosed this run), and every
accepted assert targets route-distinct content.

**New finding N22 (High) — flow planning burns its budget on constraints the catalog
cannot satisfy, then dies with a misclassified error.** Homer's prep listed two
features (`dashboard-service-cards`, `display-preferences`) whose tagged evidence
pools are byte-identical: both may reference only `navigate-route-1` +
`assert-heading-1-1`. The uniqueness rule ("at least one action not reused by another
feature") is therefore unsatisfiable — replay confirms attempt 1 died on it, attempt 2
(agent added the untagged `assert-heading-1-2`/`fill-interaction-1-1` differentiators)
died on "not grounded for feature", attempt 3 reverted and died on uniqueness again.
The doomed loop ended worse than it started: somewhere in attempt 3's session an
OpenCode permission denial appeared, and `throwIfRequiredArtifactWriteWasDenied` —
which matches a denial line anywhere in output that mentions the artifact name
anywhere — converted three honest validation rejections into "harness configuration
failure: required artifact write was denied", suppressing the real error. (The full
session stdout is not persisted, only a 2KB tail, so the actual denied call is
unrecoverable — the evidence-bounding class again.) **Plan → N22:** (a) like N21b's
never-demand-the-impossible rule, `assertFlowSpecGrounded`'s caller should detect
before spending agent attempts that the tagged action pools cannot satisfy uniqueness
(or assert+interaction coverage) for the selected inventory, and fail with a
repairable preparation classification: "browser evidence cannot distinguish prepared
features X and Y; merge them or reselect distinct entry routes"; (b) the write-denied
classifier must correlate the denial to the artifact (same line), and an
attempts-exhausted failure must carry the last validation error, never be preempted.
An earlier repo-preparation attempt also failed with a PTY-echo hang (`stty -echo`
prompt garbage, exit 1) — recovered by the 1.3 retry; infra flake, recorded only.

**New finding N23 (Critical) — under gate pressure, preparation shrinks the demo
scope instead of fixing the data path.** This Midday prep selected as its three
features: locale preferences, date/time formatting (both on
`/account/date-and-locale`) and the tracker create-project modal — the only surfaces
that render without data — and confessed in its own manifest: "The prepared demo
covers account date-and-locale preferences only; banking, invoices, inbox, reports…
still require their normal services", while its own product summary calls Midday a
financial/invoicing/time-tracking platform. The relative-URL SSR bug recurred a third
time (`Failed to parse URL from /api/trpc/trackerProjects.get`; this prep created no
fixture route at all), `/` renders a literally blank page (screenshot evidence), and
the tracker page's project table is permanent skeleton loaders. Every gate passed
honestly — the selected features genuinely ground on route-distinct content — so the
gap is feature-selection accountability, not evidence truthfulness. The requested-
feature machinery that would force data surfaces never engaged because the matrix
submits `importantFeatures: []`. **Plan → N23:** (i) config, no code: the matrix's
midday entry must request data-bearing features (e.g. invoicing and transactions) the
way a real maker would — requested-feature grounding then forces the prep onto data
routes, where hollow rendering fails exploration and the N21c stderr evidence steers
repair directly at the SSR fetch bug; (ii) record the open design question for
feature-free briefs — whether preparation's inventory must cover the workflow domains
its own productContext.summary enumerates — rather than inventing a fuzzy relevance
gate now; (iii) optional one-line preparation standing rule: fixture endpoints fetched
by browser code that also runs during SSR must use absolute same-origin URLs or be
gated to client-only execution (third recurrence of this exact bug class).

**N22 + N23 landed (same day).** `d942ce7` (N23i — the matrix midday entry now submits
a product summary and `importantFeatures: ["invoicing", "transactions"]` like a real
maker; requested-feature coverage forces preparation onto the data routes). `c377889`
(N23iii — the preparation standing rule that said "browser clients may use relative
same-origin routes" now warns that data-fetching layers shared with SSR cannot fetch
relative URLs and must gate to client-only execution or call the fixture module
directly server-side — the prior wording actively pointed agents into the recurring
bug). `24b6767` (N22a — exploration now fails features forced onto identical tagged
evidence — exactly one shared assert and one shared interaction each — with "browser
evidence cannot distinguish…" steering to merge or reselect, before flow planning can
burn attempts on unsatisfiable uniqueness; requested-feature collisions fail the same
way, and a collision is tolerated when enough distinguishable features remain. Replay:
homer's deadlocked run now fails at exploration naming `dashboard-service-cards` and
`display-preferences`). `5593d9f` (N22b — the write-denied classifier requires the
denial line itself to name the artifact, so a denial about another path no longer
suppresses the attempts-exhausted error, which already carries the last validation
message; the misclassification and fail-fast paths are both now test-pinned).
N23ii (feature-free-brief inventory coverage) remains a recorded open design question.

## Addendum (2026-08-01, after the post-N22/N23 matrix run — infrastructure incident)

Both entries failed in under 90 seconds (`terminal-2026-08-01T01-11-17-607Z` homer,
`terminal-2026-08-01T01-12-15-631Z` midday): every OpenCode agent command — six of
six across two fresh sandboxes — exited 1 after ~4 seconds emitting only PTY
bootstrap echo (`stty -echo`, bracketed-paste codes, bare `>` continuation prompts)
and not one byte of OpenCode output. **Diagnosis: Daytona platform-side PTY
regression, not pipeline code.** Evidence: (1) the identical signature first appeared
as a self-healing one-off in the 23:57 homer run — before N22/N23 existed — and the
00:04 midday run had 20 minutes of healthy agent commands after it; nothing that
touches the agent-command path landed since; (2) each run died on its *first* agent
stage (repo-preparation for homer, runtime-target-selection for midday) — different
repos, prompts, and stages, so no pipeline logic is in the frame; (3) the
`stty -echo` in the output is Daytona's own session bootstrap, and its echo
suppression visibly failed — the typed command lines are echoed back as `>`
continuations; (4) control-plane calls (secret ensure, sandbox create, log persist)
all succeeded; the opencode binary is frozen in the prebuilt snapshot, which nobody
rebuilt. Next step: verify cheaply with `scripts/verify-daytona-image.mts` (one
sandbox) before spending a matrix run; the 23:57 occurrence self-healed, so the
incident may pass on its own.

**Recorded finding N24 (Medium, not landed) — hardening against this class:**
(a) an agent command that exits nonzero having produced zero OpenCode output should
classify as an infrastructure failure (1.3 retry/backoff semantics and honest
reporting) instead of burning artifact attempts and surfacing as "did not produce
valid required artifact", which misdirects diagnosis at the artifact contract;
(b) the agent image installs OpenCode unpinned (`curl -fsSL https://opencode.ai/install | bash`)
while bun, pnpm, and yarn are all version-pinned — pin it and record it in
`tools-lock.json` so snapshot rebuilds are deterministic.

## Addendum (2026-08-01, after the post-incident matrix rerun)

The Daytona PTY incident cleared on its own, as the 23:57 self-heal predicted. Matrix
report `matrix-report-2026-08-01T02-02-59-335Z`: **homer passed end-to-end** in 538s
(`terminal-2026-08-01T01-34-09-109Z`) — the N22a collision gate did not deadlock —
and **midday failed honestly at app-exploration** in 1192s
(`terminal-2026-08-01T01-43-07-004Z`): "App Exploration found no browser evidence for
requested features: transactions", repair budget exhausted after 5 attempts. This is
the first run where the full N21/N22/N23 gauntlet was exercised, and every gate did
its job: N23's requested features forced the failure instead of a scope-evaded hollow
video; N21a refused to ground `/transactions*` routes that harvested only the
six-string sidebar; N21c's stderr tail captured the true root cause verbatim; N21d
persisted evidence for both exploration attempts.

**Run anatomy** (all reconstructed from `validation-attempts/` mirrors and stdout
tails; every claim below is verified against artifacts): prep → fidelity ✓ →
preflight ✗ (install: `xlsx` tarball pinned to unreachable `cdn.sheetjs.com`) →
repair 1 pins `node-xlsx@0.21.0` ✓ → preflight ✓ → **exploration 1 ✗** → repair 2 →
fidelity ✗ → repair 3 → fidelity ✗ → repair 4 → fidelity ✗ → repair 5 → fidelity ✓ →
preflight ✓ → **exploration 2 ✗** (identical failure) → budget exhausted. Five repair
attempts bought exactly two browser observations.

**Root cause in the prepared app** (visible in the N21c stderr tail of *both*
exploration reports): the browser tRPC transport throws before any request is made —
`getAccessToken` (`src/utils/session.ts`) constructs a Supabase browser client with
unset env inside the tRPC `headers()` callback (`src/trpc/client.tsx:54`), so every
non-hydrated query pends forever. `/transactions*` renders an eternal loading
skeleton (real column headers, ~40 empty shimmer rows — confirmed in the persisted
screenshot and aria tree); zero API network attempts were observed (only
`openpanel.dev` analytics was blocked). `/invoices` rendered `$NaN` tiles and
"No invoices" — the prep agent's `getDemoFixture` guesses response shapes by
`JSON.stringify(queryKey).includes(...)`, and its `{count, amount}` summary shape
does not match the UI's expectations.

**The pipeline's own failure — the loop destroyed the correct fix.** Repair 2 ran in
the *same* OpenCode session as preparation (full context, including the exploration
stderr) and produced the right root-cause fix: a textbook demo-gated wrap of
`getAccessToken` in `session.ts` (gate import + early `return null`, original
behavior preserved). That fix was present in vetoed attempts 3, 4, and 5 — and absent
from attempt 6, the one that finally passed fidelity and re-failed exploration
identically. Three mechanisms compounded:

- **N25a — misleading gated-wrap veto (Medium, bugfix).** Attempt 3's only `page.tsx`
  change was two added `trpc.*.queryOptions()` prefetch lines — no presentation, no
  removals — but the presentation-path branch (`preparation-fidelity.ts:168`)
  collapses all three gated-wrap conditions into one message: "modifies original
  product UI, styling, or brand assets instead of preserving them." The actually
  failed condition was only the missing demo gate. The adaptation branch directly
  above already emits per-condition messages; the gated-wrap branch should too
  (missing gate → gate hint; unpreserved removal → name the line). Counterfactual:
  an accurate message at attempt 3 means repair 3 gates two lines and *keeps*
  `session.ts`.
- **N25b+c — vetoes silently discard the candidate's correct parts (High,
  feature). [Mechanism corrected during implementation.]** Code investigation
  during landing corrected this addendum's original amnesia claim: evidence
  continuity already exists. When fidelity rejects a repair candidate, the
  orchestrator's `appendRepairRejection` (`agent-harness.ts`) merges the fidelity
  summary into the *original* episode failure — repairs 3–5 did receive the
  exploration classification, summary, and Supabase stderr — and
  `restorePreparationCandidate` restores the last *accepted* candidate (not the
  screened source) while deliberately resetting the OpenCode session, since the
  workspace was rewritten under the agent (the fresh session IDs on repairs 3–5
  confirm this path fired). What was actually missing: nothing told the fresh
  agent that its predecessor's whole candidate was reverted, that the vetoed
  diff remains readable at `preparation-workspace-diff.json`, or that only the
  files named in the rejection violated — so repair 5, fixated on three
  accumulated `page.tsx` complaints, rebuilt a minimal compliant patch and
  dropped `session.ts`, a file no veto ever named. Fix: `appendRepairRejection`
  prepends one deduplicated hint stating exactly that. (Rejected alternative:
  per-file acceptance — cross-file consistency risk for split gate/helper
  changes.)
- **N25d — requested-feature failures hide what routes showed (Medium, feature).**
  The exploration message says only "no browser evidence for requested features:
  transactions", and `browserObservations` is route→title pairs
  ("/transactions: Transactions | Midday"). The observation data already proves the
  routes rendered only navigation chrome; `readRouteDistinctContent` already
  computes it. Name the requested feature's entry routes and what they showed
  ("rendered only globally-repeated navigation chrome and structural placeholders")
  in the failure message so the repair agent learns the data never rendered — the
  same evidence a human gets from one glance at the screenshot.

**Considered and rejected:** softening the removed-line preservation check for
comment-only removals (attempt 5 was vetoed partly for dropping
`// Build query filters for both tabs`) — the exact-line message converged the wrap
in one attempt, and comment preservation guards directive pragmas; not worth the
vandalism-surface widening. Also rejected: teaching fidelity to recognize
"data-only" additions in presentation files as exempt — grading added lines by
content reintroduces the pre-N20 heuristic treadmill; accurate messages (N25a) get
the same benefit without weakening the gate.

N24 remains recorded and not landed; this run adds no new evidence for it (no
zero-output agent exits occurred).

**Landed (2026-08-01):** `d2c54fd` (N25a — the presentation-path branch now emits
per-condition messages: added presentation keeps the preserveUi veto, a missing or
non-conditional gate reuses the adaptation branch's gate messages via a widened
`readDemoAdaptationViolation` kind, and an unpreserved removal names the exact
line; regression tests reproduce the run's attempt-3 and attempt-5 shapes),
`c2d393e` (N25b+c — `appendRepairRejection` prepends one deduplicated hint telling
the fresh repair agent the candidate was reverted, where the vetoed diff remains
readable, and that only the files named in the rejection violated; merged hints
are now Set-deduplicated so accumulated rejections stop repeating themselves), and
`b143f4f` (N25d — when requested features lack browser evidence and all their
tagged routes are chrome-only, the failure message names the routes and steers at
the data path; content-bearing-route failures keep the existing message). Full
gauntlet green except the pre-existing Remotion renderer smoke test, which failed
environmentally during landing (delayRender 28s root-component timeout under
machine load; a stash-control run at the last-green commit reproduced the failure,
confirming it is unrelated — tracked as a spun-off hardening task).

## Addendum (2026-08-02, after the post-N25 matrix run)

Matrix report `matrix-report-2026-08-02T06-00-03-667Z`: **homer passed** (441s);
**midday failed honestly at app-exploration** (1770s,
`terminal-2026-08-02T05-30-33-679Z`) with the budget exhausted after 5 repairs —
but the run validates every N25 mechanism in production and sharpens the remaining
blocker considerably.

**N25 verified working.** The loop economics inverted: **four browser observations
from five repairs** (previous run: two from five). One OpenCode session survived
repairs 1–4 (a single fidelity veto all run, versus three); the veto message was
the new per-condition kind — it named the exact unpreserved line — and the repair
fixed it in one attempt; the N25d chrome-only route evidence appeared in every
exploration failure and in the final matrix detail. Real product progress inside
the run: **invoicing grounded for the first time** ($4,200/$3,200/$1,850 fixture
tiles visibly rendered — no more `$NaN`), and the recurring SSR relative-URL class
(4th occurrence, exploration attempt-1: `/api/demo-trpc/trackerProjects.get`
fetched during SSR) was **self-corrected within the run** — repair 2 replaced it
with a server-side fixture link resolving `getDemoResult(op.path, op.input)`
directly, exactly the N23iii rule shape.

**How the run still died** (all from `validation-attempts/` mirrors): repair 4
built the plausibly winning fix — make `batchPrefetch` awaitable in
`trpc/server.tsx` and `await` it in demo mode in the invoices and transactions
pages, so dehydration carries settled fixture data instead of never-settling
fire-and-forget promises. Fidelity vetoed that candidate (attempt-5) for exactly
one unpreserved removed line — the **comment**
`// Avoid unhandled promise rejections from fire-and-forget prefetches.` — in the
very block the fix restructured. The N25b hint then did its job for 11 of 13
files: the fresh repair 5 re-applied the whole candidate *except* the two
`page.tsx` files — which no veto had named, and which carried the load-bearing
`await`. Exploration 4 saw the same silent failure and the budget ran out.

**The blocker's new shape — silent-empty data regions.** The final `/transactions`
is past the skeleton stage: table headers and tabs render, the body is blank — the
data query **resolves empty/mis-shaped with zero observable signal** (no page
errors, no console errors beyond HMR noise, no failed or blocked data requests,
fixture contains 2 well-shaped rows). Meanwhile the 2KB stderr tails that steer
repairs were dominated by crashes in *non-requested* surfaces (tracker `row.id`,
a Supabase throw from an ungated non-feature path), misdirecting repairs 2–4.

**Recorded findings (N26, not landed):**

- **N26a (High, bugfix) — non-directive comment removals should not veto.** Second
  run-ending data point for comment strictness: the previous run's attempt-5 lost
  one repair to `// Build query filters for both tabs`; this run's veto of the
  winning candidate was for a removed comment alone. This reverses the N25
  "considered and rejected" decision under new evidence, narrowly:
  `readUnpreservedRemovedLine` should skip removed lines that are pure comments
  *unless directive* (eslint/biome/prettier-ignore, `@ts-*`, pragma-style) —
  behavior-bearing lines keep full preservation.
- **N26b (Medium, feature) — enumerate the preserved files in the rejection
  hint.** Prose ("re-apply the candidate's other changes") got 11/13; a concrete
  list gets 13/13. The orchestrator holds the vetoed diff's `changedPaths` and the
  violating paths appear in the fidelity summary; the hint should name the
  non-violating files to re-apply.
- **N26c (Medium, feature) — surface empty data containers as evidence.** When a
  requested feature's route renders a data container with headers/controls but
  zero populated body items, the failure message should say so — "empty data
  table (7 column headers, 0 rows), no errors and no data requests observed; the
  data query resolved empty or mis-shaped — verify the fixture shape against the
  consuming component" — derivable framework-agnostically from the aria snapshot
  already captured per route. Without it, the only steering signals are stderr
  crashes from unrelated surfaces.

**Landed (2026-08-02):** `4595e12` (N26a — `readUnpreservedRemovedLine` exempts
whole-line C-style comments unless they carry a tool directive
(eslint/biome/prettier suppressions, `@ts-*`, istanbul, webpack magic comments);
hash comments stay strict because `#` also opens JavaScript private fields;
regression tests reproduce this run's veto shape and pin the directive
protection), `8aae52e` (N26b — `appendRepairRejection` now enumerates the vetoed
candidate's non-violating, non-lockfile files in the rejection hint — capped at
24 — and replaces any stale prior rejection hint so the list always matches the
diff artifact's current content), and `5f8e331` (N26c — the generated explorer
script reports visible tables/grids whose headers rendered with zero populated
body rows as `emptyDataTables`, collected during the same in-page harvest, and
the requested-feature failure message appends "An empty data table (N column
headers, zero data rows) rendered on these routes — the data query resolved
empty or mis-shaped; align the fixture shape with the fields the consuming
component reads"; exercised by a real-chromium script test that distinguishes a
headers-only table from a populated one). Implementation deviation from the
recorded sketch: the evidence rides the observation protocol's route objects and
a verdict-time map — not aria-snapshot parsing — because the harvest already
runs in-page where the structural facts are one query away.

## Addendum (2026-08-03, after the post-N26 matrix run — host-sleep incident)

Matrix report `matrix-report-2026-08-03T18-08-33-158Z`: **homer passed** (449s);
**midday failed** (`terminal-2026-08-03T16-59-47-195Z`, 68m49s) with the raw
infrastructure error `Daytona command produced no output for 300000ms.` after
three repair commands died on inactivity kills. Forensics prove the kills were
**not** sandbox, OpenCode, or pipeline failures: **the workstation lid was closed
eleven minutes into the run and the machine slept through the rest of it.** The
`pmset -g log` sleep ledger matches the pipeline log to the second:

- 17:11:33Z — `Entering Sleep state due to 'Clamshell Sleep'` (battery, 47%).
  Repair 4's `lastOutputAt` is 17:11:33.198Z, four seconds after its command
  started. The sandbox agent kept working; the local orchestrator stopped
  receiving PTY data and its timers froze.
- 17:52:06Z — first `DarkWake` (74s). Repair 4's inactivity kill fires at
  17:52:06.668Z (`durationMs` 2,437,206 — a "5-minute" watchdog firing 40m37s
  in; the 15-minute overall command deadline also never fired, confirming
  frozen local timers rather than any real silence measurement).
- Inside that 74-second wake window: repair 5 starts with a fresh session, finds
  the workspace full of repair 4's killed-mid-edit partial work, submits it in
  57s → fidelity attempt 5 correctly vetoes it (three ungated presentation /
  integration adaptations plus one out-of-seam edit, all named by the N25a
  per-condition messages) → restore re-applies the accepted candidate
  (17:53:04Z) and the N26b rejection hint is appended.
- 17:54:09Z — back to Clamshell Sleep, one second before repair 6's output
  stops (17:54:10Z). Its kill fires at 18:00:25Z — during a 5-second
  maintenance DarkWake. Repair 7 launches inside that same 5-second window,
  gets six seconds of output, sleeps, and is killed at the next DarkWake
  (18:08:31Z) — the second consecutive timeout inside one `repairPreparation`
  call, so the harness surfaces the timeout as an infrastructure error (by
  design: no fallback artifact, raw error) and the run ends. The failure path
  persisted all logs inside that 99-second wake. Lid opened 18:10:15Z.

**What the awake portion of the run verified (all three N26 landings, in
production, before 17:11:33Z):**

- **N26a passed its gate.** Four consecutive fidelity passes (prep + repairs
  1–3), zero comment vetoes — the first Midday run since the veto class appeared
  with none. The one veto of the run (attempt 5) was a true positive on
  rubber-stamped partial work.
- **N25d + N26c fired verbatim.** Exploration attempt 1 failed with: requested
  feature "transactions" routes `/transactions` rendered only
  globally-repeated navigation chrome … **"An empty data table (8 column
  headers, zero data rows) rendered on these routes — the data query resolved
  empty or mis-shaped; align the fixture shape with the fields the consuming
  component reads."** The observation carries `emptyDataTables` for
  `/transactions` and all three `?step=` siblings. Repair 4 was launched with
  exactly this steering — then the lid closed on it.
- **N26b exercised end-to-end.** The attempt-5 veto ran the restore +
  `appendRepairRejection` path (SHA-verified re-apply logged 17:53:04Z) with
  the preserved-files enumeration.
- Requested-feature progress held: **invoicing grounded again** (only
  `transactions` missing), and the preflight `cdn.sheetjs.com`/xlsx class was
  classified `external network required` and cleared in three fast repairs.

**Recorded findings (N27, not landed):**

- **N27a (Medium, bugfix) — command watchdogs must be sleep-aware.** The
  inactivity deadline and the overall command deadline both measure local timer
  time, which silently diverges from wall clock across host sleep; on wake they
  kill healthy remote agents and bill the kill to the product repair budget
  (this run: three kills, two of them launching into 5-second DarkWake
  windows). Minimal shape: a small drift monitor at the Daytona provider seam
  (heartbeat comparing expected vs. actual elapsed); when observed drift
  exceeds a threshold, re-arm the inactivity window once instead of killing and
  emit a loud `host.clock.drift` event naming the gap. This also cleanly
  distinguishes future N24-class genuine agent stalls from sleeping-observer
  artifacts in the logs.
- **N27b (Low, infra) — the matrix runner should hold a sleep assertion.** On
  darwin, wrap the run with `caffeinate -i -w <pid>` and warn at start when on
  battery. Idle sleep is preventable; clamshell-on-battery is not — the warning
  plus N27a's drift event make the failure mode diagnosable in seconds instead
  of a forensic session.
- **N27c (Low, feature) — disclose the dirty workspace after a killed repair.**
  Repair 5 inherited repair 4's killed-mid-edit workspace with no warning and
  submitted it unreviewed in 57 seconds; fidelity caught it, but one sentence in
  the timeout-retry steering ("the previous attempt was killed mid-work; the
  workspace may contain unfinished edits — review them against the failure
  report before submitting") converts a rubber-stamp into a review.

Watch item (no N-number): `/invoices` grounded via a route-distinct greeting
heading ("Good …") while its own data table is also empty (9 column headers,
zero rows). If transactions gets fixed and invoicing's table stays empty, the
run could pass with a hollow invoicing surface — N26c evidence only attaches to
failing features. Revisit only if a hollow-invoicing video actually occurs.

**Landed (2026-08-03):** `574b422` (N27a — `createCommandInactivityDeadline`
tracks when each window was armed; a firing more than 30s past its window is a
frozen-timer artifact, so it logs `host.clock.drift` naming the gap through the
sandbox audit log and re-arms a full fresh window instead of killing — only an
on-time expiry may kill; verified by a provider-seam test that jumps the wall
clock 40 minutes mid-command and asserts the command survives the drifted
firing, one drift event is logged, and the re-armed window still kills on
time), `60b562b` (N27c — the repair loop's timeout-retry steering now appends
"the previous repair attempt was killed mid-work; the workspace may contain its
unfinished edits — review them against the failure report before submitting"),
and `5bdee52` (N27b — the matrix runner spawns `caffeinate -i -w <pid>` on
darwin, scoped to the run's lifetime, and `batteryPowerWarning` warns at start
when `pmset -g batt` reports battery power — the one case no assertion can
survive). Both timers stay honest by design: the overall command deadline still
fires late-but-true after sleep (the sandbox really did consume that wall
clock); only the inactivity claim — silence that was never measured — is
re-armed.

## Addendum (2026-08-03, after the post-N27 matrix run)

Matrix report `matrix-report-2026-08-03T19-37-40-317Z`: **both entries failed**,
on two unrelated, previously-seen classes. Neither implicates N27 (no timeout
kills, no `host.clock.drift` events; the host stayed awake throughout).

**Midday (`terminal-2026-08-03T19-34-54-876Z`, 165s) — N24 recurrence #2, no new
finding.** Three runtime-target-selection commands in a fresh sandbox exited 1
in ~3–4s each with the exact recorded N24 fingerprint: PTY bootstrap echo
(`stty -echo` visibly echoed, bracketed-paste toggles, `>` continuation
prompts), zero OpenCode output. The run died before any pipeline logic, and the
failure was again billed as an artifact failure ("did not produce valid
required artifact") rather than infrastructure. This is the third appearance of
the signature (2026-07-31 self-healed; 2026-08-01 both-repo incident; today) —
N24's two items (classify zero-output agent exits as infrastructure; pin the
opencode install) are recorded, unlanded, and now recurring.

**Homer (`terminal-2026-08-03T19-24-46-308Z`, 609s) — flow-spec write-denial
class, new findings (N28).** The run was healthy through exploration (prep + 2
quick repairs, exploration passed on attempt 2). Flow planning then ran two
exit-0 commands and the harness threw `Flow Planning harness configuration
failure: required artifact write was denied for
/workspace/.makeademo/flow-spec.json.` The persisted 4KB output tails show
attempt 1 ending in a **creation diff** of flow-spec content (all `+` lines)
and attempt 2 ending in a **modification diff** (context + edits merging
`fill-interaction-1-1` into a feature) — so flow-spec content was written and
revised by the agent, while a denial line naming the artifact appeared
somewhere in attempt 2's full output (not in the tails; the full output is not
persisted). Same sandbox, same permission table, homer passed flow planning at
16:52 the same day — the denial is nondeterministic in the model's phrasing,
not a fixed configuration break.

Mechanism: `createStageEditPermissions` registers **only
workingDirectory-relative** glob keys (`../.makeademo/flow-spec.json` allow,
`../.makeademo/**` deny, `*` deny). Whether a legal artifact write is permitted
therefore depends on how the model spells the path in the tool call; an
absolute-form `/workspace/.makeademo/flow-spec.json` edit matches no allow rule
even though `external_directory` explicitly allows that tree. When a denied
canonical-path write makes the agent route around (or fail), the loop's
`throwIfRequiredArtifactWriteWasDenied` fires and its error carries neither the
per-attempt `artifactError` nor the denial line — the 2026-07-31 N22 incident's
"suppressed the real error" complaint, surviving N22b because N22b only
discarded denials about *other* paths.

**Recorded findings (N28, not landed):**

- **N28a (High, bugfix) — stage edit permissions must accept both spellings of
  each artifact path.** Register the absolute artifact path alongside the
  relative key (and the absolute `.makeademo` directory deny alongside the
  relative one) in `createStageEditPermissions`. Removes the whole
  nondeterministic-denial class for every artifact stage, not just flow
  planning.
- **N28b (Medium, bugfix) — the denial throw must not discard evidence.** Run
  the denial check only when the artifact was actually unreadable (a readable
  artifact that failed validation proves the denial did not cause the failure),
  and include the last `artifactError` plus the matched denial line in the
  thrown message so the terminal error names both the obstruction and the
  underlying state.
- **N28c (Low, observability) — persist flow-planning attempts like preparation
  attempts.** The flow-planning loop keeps `artifactError` only in local state;
  nothing mirrors per-attempt validation errors to the run directory, which is
  why today's root cause ends at inference. Reuse the existing
  `persistAgentArtifactAttempt` shape.

Recommendation: land N24 (recurring infrastructure misclassification) and N28
before the next paid run; both failures today were spent on classes already in
the ledger.

**Landed (2026-08-03):** `a1438f1` (N28a — `createStageEditPermissions`
registers every artifact allow rule and the `.makeademo` directory deny under
both the workingDirectory-relative and absolute spelling, for every stage;
prep's repo-mutation allows unchanged), `427a799` (N28b — the flow-planning and
runtime-target-selection loops run `throwIfRequiredArtifactWriteWasDenied` only
when the artifact was actually unreadable — a readable artifact that failed
validation keeps its repairable error — and the thrown message now carries the
matched denial line, redacted and bounded to 240 chars, plus the last artifact
error; the four read-failure-only call sites gained the same evidence),
`f889d70` (N28c — the flow-planning loop mirrors each failed attempt to
`agent-artifact-attempts/flow-planning/attempt-N.json` with its validation
error, written before the denial throw so the evidence survives it),
`d2008ee` (N24a — a nonzero agent exit whose output is only PTY bootstrap
noise — ANSI escapes, `root@…#` prompt echo, bare `>` continuations — gets one
spaced relaunch (30s default, `agentLaunchRetryDelayMs` option) and then
surfaces as `AgentHarnessAgentLaunchError`, a new
`isAgentHarnessInfrastructureError` member, instead of burning artifact
attempts; timeout results keep their own semantics; nonzero exits with real
output stay on the artifact path), and `29878ea` (N24b — the agent image
installs opencode pinned to 1.17.19 — the workstation-verified version —
recorded in `tools-lock.json`, and `verify-daytona-image.mts` now hard-fails if
`opencode --version` cannot run in the snapshot and warns when its version
drifts from the pin). Note: the pin takes effect on the next snapshot rebuild;
the current frozen snapshot is unchanged, which is why the verifier warns
rather than fails on version drift.

## Addendum (2026-08-03, after the post-N24/N28 matrix run)

Matrix report `matrix-report-2026-08-03T21-29-57-760Z`: **homer passed
end-to-end** (554s, final video); **midday failed at app-exploration** after
exhausting the 5-attempt repo-preparation-repair global budget (3,448s).

**The pipeline itself ran clean — every landed mechanism behaved as designed.**
Runtime-target-selection succeeded on its first launch (no N24 fingerprint
anywhere; the relaunch path was never needed). Zero `host.clock.drift` events,
zero timeout kills, zero write denials — homer's flow planning passed under the
new both-spellings table without incident. Prep and all five repair candidates
passed fidelity; exploration evidence persisted every cycle (N21d); the N26c
empty-data-table steering fired verbatim on every failed attempt.

**Midday (`terminal-2026-08-03T20-32-30-256Z`) — serial convergence exhausted
the budget; the evidence channel is one error wide (N29).** All five
exploration failures were the same honest verdict: `/transactions` rendered
only chrome plus an empty data table (8 column headers, zero data rows). The
repair agent was **not** thrashing: the five persisted candidates show one
architecture (public demo-mode gate + same-origin tRPC fixture endpoint +
fixture data) being monotonically refined, and each attempt fixed exactly the
one server error its evidence showed — only for the next run to reveal the next
obstacle in the chain. The stderr digests walk the app's data path one link at
a time: attempt 1 a server-side Supabase client env crash (digest 4200400139),
attempt 2 the SSR relative-URL parse failure (2615169990), attempt 3 an
undefined-property crash in the tracker DataTable (341061012), attempt 4 a
**browser** Supabase `createClient` crash inside `TransactionsUploadZone` —
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` unset —
killing the transactions data subtree (2567509194). Attempt 5's repair, which
even aligned fixtures with "the existing infinite-query page shape" (precisely
the N26c steering), did not clear that last obstacle: the final report carries
the same digest 2567509194.

Mechanism: the N21c stderr evidence is a single 2KB tail, and each attempt's
evidence contained exactly one error digest. The repair loop therefore reveals
a deep integration chain one obstacle per paid cycle; Midday's data pages
traverse proxy → authenticated layout → server prefetch → browser tRPC client →
browser Supabase client, and five cycles was one short of walking it.

**Recorded finding (N29, not landed):**

- **N29a (Medium, feature) — failed-exploration stderr evidence should carry
  all distinct server errors, not one 2KB tail.** Dedupe the managed app's
  stderr by error identity (stack head, or digest line where present — both
  framework-agnostic string signals) and attach up to ~5 bounded excerpts, one
  per distinct error. Turns serial one-error-per-cycle convergence into a
  single repair that sees the whole remaining chain.

(Watch item, no number: repair prompts carry only the latest failure, not a
one-line history of obstacles already cleared. If N29a alone proves
insufficient, that history is the next lever.)

Recommendation (user-proposed, agreed): midday's remaining failure is
prep-agent convergence bandwidth on a hard production monorepo, not a pipeline
defect — this run validates the N24/N27/N28 stack in production. Proceed to the
next phase (Phase 3 tail 3.8/3.9, then Phase 4 security 4.1–4.10) and queue
N29a with the smaller fixes.

## Phase 3 tail landed (2026-08-03)

3.9 and the script-violation half of 3.8 had already landed in `204568f8`
(script-boundary violations route to script repair as `"script modified app
source"`; root browser candidates own nothing exclusively in sibling
attribution, with the regression test "does not let a root browser candidate
claim selected-app evidence"). The remaining 3.8 enforcement landed today:
`d8e97e6` (the orchestrator itself runs `assertPreparedFeatureInventory` on
every manifest it adopts — after preparation and after each runtime repair —
so a dependency implementation that skips validation can no longer hand the
pipeline an unvetted inventory; dependency-repair manifests stay exempt
because the loop discards them in favor of the pre-repair manifest) and
`414ef14` (`captureWorkspaceDiff` and `capturePreparationWorkspaceDiff` are
required members of `AgentHarnessPipelineDependencies` with a fail-fast
construction guard before any stage runs; the fidelity stage and the
script-writing read-only boundary can no longer be silently skipped by
omission). Follow-up `424c9a5` made `assertPreparationRuntimeTarget` internal
to the inventory module — the orchestrator's single enforcement seam is now
`assertPreparedFeatureInventory`. Phase 3 (3.1–3.10) is complete.

## Addendum (2026-08-03, Phase 4 landed)

All ten WS4 items are implemented and committed on `anqi-dev`; the gauntlet is
green (lint, typecheck, knip, **768 tests**). Every item was driven by a failing
behavior test first, and four of them turned up real defects the audit had only
inferred.

**Landed:** `aa324f1` (4.1 — the screen and profiler now use the shared secret
predicates: credentialed `.npmrc`, `*.tfvars`, and env-shaped content under
non-env names are rejected instead of passing unseen, and quarantine membership
is the evidence for text-stripped files); `ac327a4` + `449a3e6` (4.3 — a
`scanned: false` flag replaces silence when a file is too large to read, an
unscanned `package.json` is a rejection and other unscanned files a warning;
package manifests get a 1 MiB cap; vendored/build trees keep name-based
quarantine but skip content inspection; a 256 MiB cumulative scan budget and a
5-minute clone timeout with process-group kill bound the walk; destructive-script
regexes are anchored (`rm -fr /` now caught, `mkfsdocs.js` no longer a false
positive) and any `..` symlink component is refused); `a4f451a` + `c213316`
(4.4 — the install gate appends the manager's script-suppression flag inside the
open window, so submitted-repo lifecycle scripts never execute with network
access; yarn reconciliation is workspace-scoped and picks `--mode=update-lockfile`
or `--ignore-scripts` by yarn variant); `d91a368` + `0d3186f` (4.5 — the reseal
is retried once and a persistent failure rides along as `resealError` instead of
replacing the install result; a successful install with an unresealed window
fails closed; the provider only swallows a restricted-policy close when the open
was rejected by that same policy, proving the sandbox stayed blocked);
`f11aba4` + `11331fa` + `429c434` + `90e7f5c` (4.6 — per-command nonce on the PTY
exit sentinel, matched last-first, so command output cannot forge an exit code;
per-process nonce on the runtime network marker, so an app cannot fabricate
blocked-attempt evidence that would drive controller-side fetches; Browser Action
markers naming an undeclared Scene now throw like step and Scene markers instead
of being silently dropped, closing a path that hid failed actions; the failure
screenshot is downloaded from the backend-owned path rather than the one the
script reported); `e9f8ba7` (4.7 — the browser replay policy verifies every
cached body against its manifest `sha256`/`sizeBytes` before fulfilling, memoized
per path, mirroring the Node guard, and fulfillments carry
`x-content-type-options: nosniff`; the real-browser replay test exercises it);
`6995b83` + `518b9bc` (4.8 — local paths and observed routes are resolved and
compared against the app origin instead of shape-tested, closing `/\evil.com`;
`assert-url` is grounded against its catalog route like `goto`, so it cannot
satisfy the visible-assertion gate against an unobserved route); `f3ccd8c` +
`91288ed` (4.9 — the destination policy applies to whatever URL any fetcher
reached, including injected ones, with a standard-port restriction; the
`node:https` mock can now emit redirects and four real cases are covered
(private, http downgrade, raw IP, over-length chain); a malformed response fails
its own URL instead of aborting the whole hydration pass, while a fetcher
contract `TypeError` still propagates; trusted assets and fonts are looked up as
own properties, fixing a real crash on `assetId: "constructor"`); `8969db3` +
`2ba9851` (4.10 — the agent sandbox gets a 12-hour `autoDeleteInterval` backstop
so a dead controller cannot leak a forever-running sandbox, a failing
compensating delete no longer replaces the root-cause error, and a 409
state-change conflict during deletion is retried once).

**Decisions taken (defaults, reversible):** lifecycle-script suppression is
unconditional, with the network-closed rebuild pass still deferred until a
fixture needs it (per the open decision below); clone timeout 5 min; content
scan budget 256 MiB; package-manifest read cap 1 MiB; agent-sandbox auto-delete
720 min.

**Not done, recorded honestly:** the manifest carries no admitted
`resourceType`, so replay still keys on URL alone — `nosniff` plus the
hydration-time content-type compatibility check cover the concrete
reinterpretation attack, but per-entry resourceType enforcement needs a manifest
field and is left for a later change. `AgentHarnessWorkspaceExecuteOptions.onStderr`
is documented rather than deleted: PTY-backed workspaces have no separate error
channel and merge both streams into `onStdout`, so callers must not read an
empty `onStderr` as "no error output". Capture-protocol markers other than the
exit sentinel and the runtime network marker remain un-nonced.

## Addendum (2026-08-03, after the post-Phase-4 matrix run)

Runs: `terminal-2026-08-04T05-38-40-911Z` (homer, failed, 126s) +
`terminal-2026-08-04T05-40-46-847Z` (midday, failed, 270s). Both died at
preparation-preflight with the identical error, immediately after a clean
first-attempt repo preparation:

> `Failed to reset submitted-code workspace: Network access is restricted and
> cannot be overridden at the sandbox level. See
> https://www.daytona.io/docs/en/network-limits/#tier-based-network-restrictions`

**Diagnosis — Daytona org tier, surfaced by 4.5 working as designed.** The
Daytona org rejects `sandbox.updateNetworkSettings({ networkBlockAll })` on the
submitted-code sandbox because tier-based network restrictions forbid
sandbox-level overrides. Preflight's first network call is the *close*
(`setSubmittedCodeNetworkAccess(false)` before workspace sync); under `0d3186f`
(4.5) the restricted-policy rejection on a close is only swallowed when a prior
rejected *open* proved the sandbox stayed blocked — no open has happened yet at
preflight, so the error now propagates as `harness/internal failure`. Before
Phase 4 the swallow was unconditional and silent, which means earlier logs
cannot tell us whether the org was already restricted: if it was, the
Daytona-level Runtime Network Lockdown was a silent no-op in every prior run
and only the in-process guards (Node preload guard + Playwright route policy)
actually held. Yesterday's passing-preflight runs (20:23Z/20:32Z) predate the
4.5 commits (22:22Z), so they are evidence of nothing either way. One further
ambiguity recorded honestly: the linked-sandbox *create* with
`networkBlockAll: true` did not error, so on a restricted tier we cannot tell
whether Daytona applied or ignored the create-time flag — only updates reject
loudly. This is not a pipeline defect and needs no code rollback: 4.5 exists
precisely to refuse to pretend the network is sealed when it cannot prove it.

**N30 (ops, blocking matrix runs) — move to the tier 3 Daytona org.** The
tier 3 workspace permits sandbox-level network overrides, restoring the
lockdown as designed with zero code changes. Switching requires: a new
`DAYTONA_API_KEY`; rebuilding both org-scoped snapshots in the new org
(`infra/daytona/opencode.Dockerfile` and
`infra/daytona/submitted-code-node-browser.Dockerfile`) and updating
`MAKEADEMO_DAYTONA_SNAPSHOT` / `MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT`;
the `makeademo-openai` Daytona secret needs no manual step (the pipeline
ensures it at run start). Verify with `bun run verify:daytona-image` before the
first matrix run. Rejected alternative: a degraded in-process-guards-only mode
when the tier rejects overrides — it would silently weaken the boundary Phase 4
just built (the tier allow-list still permits registry egress for submitted
code), and a tier 3 org is available.

**N30 executed (2026-08-04).** With `DAYTONA_API_KEY` switched to the tier 3
org: `makeademo-opencode-linked-ca-20260804` (0.84 GB, cpu 2 / mem 4 GiB) and
`makeademo-submitted-code-browser-ca-20260804` (2.41 GB, cpu 2 / mem 4 GiB /
disk 10 GB) built server-side via `daytona snapshot create` from the repo's
pinned Dockerfiles; `.env` updated; secret name left at the `makeademo-openai`
default (auto-ensured at run start). `bun run verify:daytona-image` passed
end-to-end — including the submitted-code `setSubmittedCodeNetworkAccess`
open→close toggle that tier 2 rejected, the 4 GiB / 2-CPU capacity floor
(`memory.max` exactly 4 GiB, `oom_kill 0`), Git/CA trust in both plain and
secret-mounted parents, the pinned opencode launch, and the Capture SDK under
network lockdown. The org is shared: it already contained another
collaborator's `makeademo-*-rav3n` snapshots, which were left untouched.

**N30b (Low, feature, queued with the small fixes)** — fail fast on a
restricted org: teach `verify:daytona-image` (or a pipeline-start capability
check) to exercise `updateNetworkSettings` once on a throwaway sandbox so a
restricted org fails in seconds at setup instead of minutes into a paid run
after a full repo preparation (homer burned ~2 min, midday ~4.5 min of agent
time before the preflight throw).

## Addendum (2026-08-04, first tier-3 matrix run)

Runs: `terminal-2026-08-04T17-45-57-826Z` (homer, **passed end-to-end**, 567s,
final video) + `terminal-2026-08-04T17-55-24-854Z` (midday, failed, 411s).

**Homer is the first full pass with the network boundary genuinely enforced**:
zero network incidents, zero drift/denial events, the seal opened and closed
cleanly around the install window on tier 3. The Phase 4 stack is now
production-validated on the passing lane.

**Midday — OOM under the 4 GiB snapshot, not a pipeline defect.** Prep
succeeded first-try; preflight passed; then the prepared Next.js dev server was
OOM-killed at exploration launch. The cgroup-OOM seam classified it correctly
("1 OOM kill(s) under a 4096 MiB memory ceiling… the app needs more resources")
and the run stopped immediately with zero repair attempts burned — the cheapest
possible failure of this class. Root cause: the N30 rebuild sized the
submitted-code snapshot at the capacity-floor minimum (4 GiB), but the old
org's sandbox ran at 8 GiB (per the 2026-07-31 VP9-trim OOM evidence). Homer's
static dashboard fits in 4 GiB; midday's dev server does not. The familiar SSR
relative-URL error appears in the app-output tail but was not the killer.

**N31 executed (ops):** `makeademo-submitted-code-browser-ca-20260804b` built
at cpu 2 / mem 8 GiB / disk 10 GB; `.env` updated; the superseded 4 GiB
snapshot deleted; `verify:daytona-image` rerun against the new snapshot.

**N31b (Low, feature, queued with the small fixes)** — raise
`submittedCodeSandboxCapacityFloor.memoryMiB` from 3900 to ~7900 so
`verify:daytona-image` rejects an under-sized snapshot at provisioning time;
the 3900 floor is what let the 4 GiB rebuild pass verification and cost a
paid run to discover.

## Addendum (2026-08-04, Phase 5 landed)

All nine WS5 items landed TDD-first on `anqi-dev`, one behavior per commit,
each through the full gauntlet (lint, typecheck, test, knip; final state
**787/787**). Commits, oldest to newest: `8822a01` (5.1 token-delimited root
scripts + other-workspace rejection), `ddb2b92` (5.2 strong-custom evidence
gate + fail-closed zero-candidate monorepos), `2603b3f` (5.3 manager
precedence: declaration → single lockfile → ancestor → recorded tiebreak),
`5ae665f` (5.4 `run-planner/package-commands.ts`: one port extractor with
`--port=`/`PORT=`/`-l`/last-match, `<pm> run <script>` builders killing bare
`bun build`, body-based dev-server predicate killing `serve -s dist`, shared
`readPackageName`; tri/duplicated copies deleted), `0b0c5cb` (5.5 closure
excludes `isWorkspace: false` file-linked packages; expansion scans
stderr/stdout excerpts), `7713394` (5.6 zero-indent pnpm YAML, brace globs,
`lerna.json`), `3c21352`/`20c1772`/`2dc64b8`/`e1ba585` (5.7 native-mobile
exclusion per N3, `roleHints` storybook/e2e evidence, non-product rejection
while a product exists, lone showcase-only candidate escalates,
`resolvePreparationRuntime` returns `unresolved` with reason + candidateIds
and failed preflights carry it as a repair hint), `46910ef` (5.8
`findBuildScopeViolation` deleted with its Midday-shaped test;
`runtimeTarget.build.cwd` owns build scoping), `1cc6ef9` (5.9 one-pass
nearest-owner file bucketing; the 70k-file/200-package synthetic profile went
from 2.2s to under the 1s budget, asserted by a perf test).

**Behavior changes worth knowing:** profiled non-npm script commands now emit
the `run` form (`pnpm run dev --port 3000`, previously `pnpm dev --port
3000`); a `serve`-named script with an unrecognized body now builds first
(safe: no build script → no build command); synthesis for an unknown manager
falls back to `npm install --no-audit` instead of `npm ci` (which refuses to
run without a proven lockfile); a monorepo with zero proven browser
candidates now fails closed with the candidate list instead of guessing
`candidateAppDirs[0]`.

**5.5 root-selector note:** the plan's "append root selector for pnpm when
root declares prepare/postinstall" was already superseded by `c7ca0c2`, which
appends the root filter unconditionally for non-npm managers because root
*dependencies* (hoisting) matter beyond lifecycle scripts — and 4.4 suppresses
install-time lifecycle scripts anyway. Recorded as done-by-generalization.

**Not done, recorded honestly:** the N21 shared-concept glossary terms are
unchanged (out of WS5 scope); `roleHints` reads storybook evidence from the
filtered browser-evidence paths plus script bodies, so a candidate whose only
storybook trace is a bare `.storybook/` config with no stories and no script
keeps an empty hint; nearest-owner bucketing means a package nested inside a
workspace member no longer contributes its imports to the parent's observed
`workspaceDependencies` (previously it did — arguably a latent bug, now
consistent with evidence ownership).

**Gate next:** matrix run (all three fixtures select the right target,
install scoped, start on the right port), then one new real-world monorepo
end-to-end per the Phase 5 gate.

## Addendum (2026-08-04, after the post-Phase-5 matrix run)

Runs: `terminal-2026-08-04T18-56-43-407Z` (homer, **passed**, 530s) +
`terminal-2026-08-04T19-05-33-041Z` (midday, failed at exploration, 1274s).

**Phase 5 validated in production.** Homer's second consecutive tier-3 full
pass, now on Phase 5 code. Midday exercised the whole WS5 stack and every
piece behaved: model target selection locked `apps/dashboard` as `product`;
the scoped install resolved the complete internal closure (31 `--filter`
workspaces + the root filter) and executed; start resolved to the
workspace-local `bun run dev` on port 3001 from the selected script body; no
build for a dev server; no OOM at 8 GiB; no network or infra events.

**Midday's failure is the standing frontier, not a Phase 5 issue.** Both
requested features rendered chrome plus an empty data table (N26c evidence
verbatim). The 5-attempt repair budget went to serial convergence through
preparation-fidelity vetoes: each attempt removed integration behavior
(`useSuspenseInfiniteQuery`, `trpc.user.me.queryOptions`,
`trpc.tags.get.queryOptions`) or modified product UI
(`invoices-open/overdue/paid.tsx`) instead of gating it, was vetoed with the
N25a per-condition message, fixed those files, then tripped on a new set.
Fidelity correctly batched all violations within each attempt; the bottleneck
is one-lesson-per-paid-attempt bandwidth, which is exactly the N29a class
(recorded 2026-08-03, queued). No new N item.

**Recommendation:** proceed to Phase 6. The WS5 gate's remaining half — one
new real-world repo end-to-end — can ride the next matrix run now that
excalidraw/cyberchef are in the matrix (`6cc4dba`).

## Addendum (2026-08-04, Phase 6 landed)

All seven remaining WS6 items (6.1–6.7; 6.8/6.9 landed 2026-07-29) landed
TDD-first, one behavior per commit, full gauntlet per commit (final state
**790/790**, lint/typecheck/knip clean). Commits, oldest to newest: `47fe38e`
(6.1 placeholder scan scoped to `humanReadableDescription` +
`expectedVisibleOutcome`; a maker's "Add a TODO" feature passes), `900e988`
(6.2 compiler emits `humanType`/`animatedClick`/`animatedHover`/
`animatedScrollTo` directly; `stylizeBrowserActions` + both `chromium.launch`
passthrough sniffs deleted; the tsc-validated body is the executed body, with
`declare global` helper types; the injection test proves a hostile
`.fill(");`-bearing value survives untouched), `7572e57` (6.3 per-attempt
capture run directories with retry suffix, remote scratch `rm -rf` before
recording, exit 137 classified as timeout beside 124, guarded browser
teardown emitting `[makeademo:context-close-failed]` instead of substituting
the body error, and all five provider `exitCode ?? 0` sites flipped to fail
closed), `8316821` (6.4 the capture-runtime-reset proof binds every recorder,
injected test doubles included), `1f1329b`/`862923b`/`6e73870` (6.5 narrative
rejects agent synthetic scenes with the backend-owned rule instead of silent
filtering — and `assertCanonicalDemoNarrative` names the same rule for stray
synthetic scenes; the agent-facing contract schema/examples drop
full-screen-text, static-image, and transitions; the capture-path validation
timeout derives from a per-action cost model — 60s base + 15s/action, capped
at the recording budget), `d71891f` (6.7 `sanitizeObservabilityError` bounds
project-record errors to 2 KB and `formatSceneFailure` inlines a 1.6 KB
excerpt plus retained-log paths instead of full streams), `59e9888` (6.6
`parseDemoScript` rejects any supplied `demoPlaywrightScript` — the field is
compiler output only, closing the disk-file→arbitrary-Playwright path — and
the now-redundant ~200-line regex lint in `capture-sdk-contract.ts` is
deleted with its nine tests). `0d25a05` widens the 5.9 perf bound for
parallel-suite load.

**Notes recorded honestly:** 6.5's `markUnresolved`/"external network
attempted" classification was already landed pre-Phase-6 (verified, no
change). The `demoPlaywrightScript` field survives on the parsed `DemoScript`
type as the compiled artifact carrier — only the *input* path is closed;
renaming the internal carrier was judged churn without a safety gain.
`script-quality.ts` still scans the compiled source (updated for the
humanized call forms); it is Phase 8 deletion surface now that only compiler
output reaches it. `assertUsesManifestBaseUrl`/`assertNoExternalUrls` remain
as cheap redundant checks on compiled output.

**Gate next:** matrix run (homer must stay green through capture/compositing
on the new compiled-humanization path; the extra matrix repos exercise the
contract against non-Midday shapes).

## Addendum (2026-08-04, first 11-repo matrix — Phase 6 gate green; N32–N37)

First run of the expanded matrix (`terminal-2026-08-04T21-04-58-386Z` …
`…23-45-45-962Z`, ~2h42m): **homer passed end-to-end (599s) through capture
and compositing on the compiled-humanization path — the Phase 6 gate is
green.** The 10 failures decompose into four new deterministic pipeline
defects (N32–N35), one exploration-generality frontier (N36), and three
agent-frontier failures where the gates worked as designed. Full evidence row
in the audit doc.

**N32 — symlink screen rejects in-repo `..` links (cal.com, Ghost,
ghostfolio).** `symlinkEscapesRepo` rejects any target containing a `..`
component outright (the Phase 4 fail-closed shortcut). All three repos ship
the now-standard agent-skill sharing pattern (`.claude/skills/X →
../../.agents/skills/X`, cal.com `.claude/rules → ../agents/rules`) with
every target present inside the tar. Fix: bounded static resolution over the
archive's own entry set — resolve the target component-by-component from the
symlink's parent, following known in-repo symlinks (depth-bounded,
cycle-detected), rejecting absolute targets and any traversal that leaves the
root at any intermediate step. The `a → b/..` aliasing attack still fails
closed because `b` resolves first. Unblocks 3 of 11 matrix repos.

**N33 — global content-scan budget mislabels manifests as "too large"
(twenty).** The flagged `packages/twenty-e2e-testing/package.json` is 207
bytes; the 280 MB/35k-file repo exhausted the 256 MiB
`contentScanBudgetBytes` mid-traversal, the leftover manifest got
`scanned: false`, and the fail-closed package.json rule (correct for
genuinely unscannable manifests) rejected with a false message. Fix: package
manifests bypass the global budget (they are already per-file capped at
1 MiB), and budget-skipped files get an honest "content-scan budget
exhausted" warning instead of "too large". Unblocks twenty.

**N34 — backend port stomp makes preflight repair unconvergeable
(excalidraw).** Composable defect: (a) the profiler's package-level `ports`
harvest swept 5001 out of the *non-selected* `serve` script
(`npx http-server … -p 5001`); the selected `start` body (`yarn && vite`)
carries no port, so the WS5 precedence fell through to `ports[0]` = 5001;
(b) `resolvePreparationRuntime` re-stamps `baseUrl`/`ports` from the backend
target on **every** repair-loop iteration, so after repair attempts 3–4
correctly declared 5000 (the vite banner `Local: http://127.0.0.1:5000/` sat
in the preflight evidence the whole time) the loop overwrote them and
re-probed dead 5001 — four attempts burned with convergence structurally
impossible. Fix: scope port evidence to the selected start script (body +
config), and stop overwriting agent-declared runtime fields on re-validation
when the backend's own evidence is weaker than runtime evidence — or
cross-check the managed-app output for the actually-bound URL and steer
deterministically. Unblocks excalidraw's preflight (exploration will then hit
N36's shape).

**N35 — engine incompatibility has no deterministic remedy (outline).**
`i18next-parser@9.4.0` engines `^18||^20||^22` vs the sandbox's node
24.15.0; yarn classic hard-fails engines by default; lockfile reconciliation
re-ran into the identical wall, and the repair agent has no handle — the
install command is backend-stamped (all 5 candidates carry
`yarn install --immutable`; final workspace diff empty). Fix: mirror the
lockfile-reconciliation pattern — on the engine-incompatibility stderr
signature under yarn classic, retry once with `--ignore-engines` and record
the assumption in the manifest (pnpm equivalent
`--config.engine-strict=false`; npm is not engine-strict by default).
Unblocks outline's install.

**N36 — exploration under-serves control-centric single-route tools
(cyberchef; excalidraw next).** The app rendered fully — the retained aria
snapshot shows "Operations 499", the category taxonomy, "Bake!", the
operations list — yet grounding saw almost none of it: the selector harvest
kept 6 strings (headings empty); the N21a aria-enrichment trigger is
suppressed when even one non-nav string exists (here `To Base64`), and caps
at 6 candidates; the interaction loop exercised exactly one action (the
search fill) before its deadline; and sentence-shaped requested features
("Paste sample input, add an encoding operation…") can never token-match
control labels, so grounding degraded to exercised-interactions-only.
Because the route *did* have distinct text, the chrome-only/empty-table
explanations were suppressed and the failure message was the bare feature
sentence — five repair attempts steered at the prep agent, which was never
the problem. Direction (framework-agnostic): fire the aria enrichment on
thin-harvest-relative-to-aria-tree rather than strict nav-subset and raise
its cap; count verified high-cardinality distinct control names as route
content for single-route apps (100+ unique operation names are the opposite
of hollow chrome — the hollow-Midday signature stays caught by the
empty-table and generic-chrome signals); and make the no-evidence message
name what the route did show and which catalog actions exist. Two of the
three anti-overfitting repos (cyberchef, excalidraw) share this shape — this
is the biggest generality frontier after N29a.

**N37 (steering note) — auth-barrier repairs need a named remedy
(conduit).** The prepared app worked (2/3 features grounded on real fixture
content); "Update profile settings" redirected to authentication because no
session was seeded, and the auth-barrier message names the feature but not
the remedy. Steer explicitly: "seed an authenticated demo session via the
repo's demo gate, or reselect a feature outside auth." Conduit burned its
final two attempts re-hitting the wall.

**Working as designed (no N items):** midday reproduced the standing N29a
frontier with the sharpest steering yet (empty-table + fixture-shape message
verbatim, three identical attempts, fingerprint stop at 2). Directus's
fidelity gate vetoed replacement product UI four times (`demo-mode.ts` →
`demo-api.js` → auth conditionals → `demo-mode.ts` again) and the
fidelity repeat-limit of 1 correctly killed the circle on the first revisit
— "after 1 attempts" is the designed fidelity budget, not an accounting bug.
All three repair-budget shapes (global 5, repeated 2, fidelity-repeat 1)
verified in production. The three fixture repos (vite-spa, pnpm-monorepo,
npm-express-static) were skipped: no repo URL configured in the matrix
config.

**Recommended order:** N32 → N33 → N35 → N34 (each deterministic, small,
unblocks ≥1 repo) → N36 (design work; unblocks the tool-SPA class) — then
rerun the matrix. N29a remains the highest-leverage item for the
midday/conduit convergence class; N30b and N31b stay queued.

### Landed (2026-08-04, same day)

All six items landed TDD-first, full gauntlet per commit (final state
**802/802**, lint/typecheck/knip clean; no module-graph changes). `b1e246b`
(N32: `symlinkEscapesRepo` resolves targets component-by-component against
the archive's own entry set, following in-repo symlinks depth-bounded and
cycle-closed; in-repo `..` links pass, absolute targets, root escapes at any
step, chain aliasing, and cycles stay rejected). `a42783c` (N33: package
manifests bypass `contentScanBudgetBytes` — the per-file 1 MiB cap remains
the only manifest bound — and budget-skipped files warn "not
content-screened … (file size or repo scan budget)" instead of "too large").
`f9edd66` (N35: `planEngineMismatchRetry` mirrors the reconciliation
pattern — on the yarn-classic engine-incompatibility signature the install
retries once with `--ignore-engines`, pnpm with
`--config.engine-strict=false`; npm/bun stay agent-visible because they are
not engine-strict by default; hooked after the reconciliation dance so both
paths are covered). `59405b5` (N34: port evidence scoped to the selected
start script — `readCandidatePorts` over the selected body only, killing the
sibling-`serve` pollution — and the agent-declared manifest port now ranks
above the framework-default table, so a repair that corrects the port is
adopted on the next resolution and the preflight loop can converge; the
framework default still applies when the manifest names no port).
`777e687` (N36: the aria enrichment fires whenever the non-nav selector
harvest is thin — under 8 distinct strings, not only strict nav-subset — and
supplies up to 24 deduped candidates; and when a requested feature ungrounds
on a *content-bearing* route the failure now names the shown distinct
content and steers at featureInventory wording/entryPaths instead of the
data path). `95592cc` (N37: the auth-barrier message names the remedy —
seed an authenticated demo session through the demo gate, or reselect onto
routes outside authentication).

**Honest scope notes:** N36 does not touch the interaction loop — cyberchef's
zero click outcomes came from single-click-inert operation buttons, which is
app behavior, not harness starvation; grounding for tool-SPAs now rides on
aria-supplied text asserts token-matching feature wording, plus the new
wording steer when they don't. N34 deliberately flips one precedence test:
a workspace `vite` script with no port now resolves to the agent-declared
port over 5173, the convergence trade chosen with excalidraw's
env-configured port as evidence. The engine retry leaves
`manifest.installCommandUsed` unchanged (the retry is a validator-local
remedy, re-derived on each attempt).

**Gate:** rerun the matrix. Expected: cal.com/Ghost/ghostfolio/twenty enter
the pipeline for the first time (fresh downstream shapes likely surface new
frontier items), outline clears install, excalidraw clears preflight and
tests N36's grounding on a canvas app, cyberchef re-tests it on the
operations catalog; homer must stay green.

## Addendum (2026-08-05, second 11-repo matrix — N32–N37 validated; hollow regression N38; N39–N44)

Run `terminal-2026-08-05T00-57-36-128Z` … `…03-18-14-356Z` (~2h27m). **Every
one of the six fixes moved its repo at least one stage**; the frontier is now
flow planning, fidelity policy, and deep-repo preparation. Homer passed
(425s). Evidence row in the audit doc.

**N38 — hollow regression (midday), highest priority.** Midday "passed" with
a skeleton video: the N36 aria enrichment lifted the empty data tables'
*column headers* into route text, they counted as route-distinct content,
and the feature grounded on an `'Invoice no.'` assert. Fix at the evidence
layer: the generated script's empty-table walk must also collect those
tables' header texts, and header texts of *empty* tables must be excluded
from route-distinct content (and from the aria candidate push), so a
header-only route reverts to chrome-only and the N26c empty-table steering
fires as designed. Regression test shaped exactly like this run. The N36
win for genuinely content-bearing tool UIs is unaffected.

**N39 — flow-spec satisfiability gate (conduit).** Exploration grounds a
feature on exercised-evidence alone, but FlowSpec demands an interaction AND
a visible assertion — `article-comments` had no tagged assert, so flow
planning was unsatisfiable from attempt 1 and burned its budget on a
structurally impossible task. Extend the N22a lane: a requested feature
whose catalog tagging lacks either kind fails exploration with
repo-preparation steering naming what is missing.

**N40 — flow-spec rejections must name qualifying ids (cyberchef).** The
catalog offered a tagged assert and click, but "must select both an
interaction and visible assertion" and "action X is not grounded for
feature Y" never enumerate the feature's tagged action ids; three attempts
guessed wrong. Append the qualifying interaction/assert ids per feature to
both rejections (N25a pattern at the flow seam).

**N41 — exempt the agent tool's own paths from stage diffs (cal.com).**
Runtime Target Selection was killed for `/workspace/repo/.opencode/.gitignore`
— OpenCode's own bookkeeping. Read-only stage checks (and workspace diffs)
must ignore `.opencode/` the way they ignore `.git/`.

**N42 — the N35 pnpm remedy is denied by our own install gate (directus).**
`ERR_PNPM_UNSUPPORTED_ENGINE` fired the engine retry, whose
`--config.engine-strict=false` is not in the install-gate allowlist — the
deterministic remedy was gated off and the failure reported under the
original command. Add the flag to the allowlist and add a seam test that
every `planEngineMismatchRetry`/reconciliation output passes
`evaluateDependencyInstallCommand`.

**N43 — fidelity's gated-adaptation demand misapplies to non-executable
files (directus, excalidraw).** Vetoes demanded that `app/package.json`,
`vite-env.d.ts`, and `app_constants.ts` "conditionally use the demo gate" —
manifests and type declarations cannot carry runtime conditionals, so the
veto is unsatisfiable as steered and burned both repos' budgets. Decide the
lane: config/declaration files need either an exemption with their own
minimal-diff rule or at minimum a truthful message naming what adaptation
is actually permitted there.

**N44 — profile task-runner run targets (twenty).** `packages/twenty-front`
carries only a `build` script; its serve targets live in nx `project.json`.
The candidate list therefore held only the marketing site and a test
fixture, and the 5.7 role-safety escalation fired on an honest but wrong
premise. Harvest nx (and similar task-runner) project targets as runtime
scripts so nx-managed products become candidates.

**Frontier, no code change:** ghost (serial inventory-contract lessons on a
giant multi-app repo — check whether the inventory validator can batch all
violations per attempt while implementing N39/N40); outline (engine retry
validated; `yarn run dev` executes unbuilt `build/server/index.js` —
multi-service app with DB dependencies; the dev-script no-build heuristic
has a known nuance here); excalidraw exploration (canvas apps cannot
text-match feature wording — the N36 limitation, needs its own evidence
design eventually); ghostfolio (two consecutive 300s no-output kills in
repair — N24/N27 infra watchdog class, watch for recurrence).

**Recommended order:** N38 first (a false-positive pass is the worst outcome
class) → N42 (one-line allowlist + seam test) → N41 (path exemption) →
N40 → N39 (same seam, land together) → N43 (policy decision) → N44
(feature-sized). Then rerun the matrix.

**Landed (2026-08-05, same day).** `9fd53f0` (N38 — the generated script's
empty-table walk now collects header texts; strings made only of an empty
table's header words — individual cells and the combined header-row name —
are excluded from the aria candidate push and from route-distinct content
via a case-insensitive token-subset rule, and the hollow-app failure message
now carries the N26c empty-table steering; regression test shaped exactly
like the midday run, plus a real-browser test proving non-table aria text
still harvests). `4734cef` (N42 — `--config.engine-strict=false` allowlisted;
seam test proves every `planLockfileReconciliation`/`planEngineMismatchRetry`
remedy passes `evaluateDependencyInstallCommand`). `6a9117a` (N41 — the
preparation diff drops `.opencode/` from its temporary index and the
script-writing fingerprint excludes it like the cache directories; OpenCode
bookkeeping is tool state, not a workspace change). `ce6178c` (N40 — the
"not grounded" and "must select both" flow-spec rejections now append the
feature's tagged assert and interaction ids). `b7032c7` (N39 — exploration
fails a requested feature whose catalog tagging lacks a tagged interaction
or a tagged visible-text assert, classification `requested feature not
observable`, naming the missing kind per feature). `9f0b4b2` (N43 — lane
decision: JSON manifests and `.d.ts` declarations are gate-exempt and held
to an additive-only preservation rule with a truthful removal message;
stylesheets/markup deliberately stay in the strict lane — an ungated CSS
auth-hiding rule must still fail). `e43478f` (N44 — `project.json` joins the
manifest class in the repo snapshot; the profiler merges browser-runtime nx
targets into workspace scripts as `nx run <project>:<target>` bodies
(package.json wins collisions, declared option ports surface as `--port`),
and runtime-target resolution invokes target-derived scripts via `npx`
instead of `<pm> run`). Full gauntlet per commit; 813 tests green. Note: the
local `remotion-video-renderer` browser test began failing environmentally
mid-session (root-component load timeout, reproducible at clean HEAD in a
fresh worktree) — unrelated to these changes and tracked outside this plan.

## Addendum (2026-08-05, third 11-repo matrix — N38/N39/N42/N43 validated; hollow pass N45; N46–N47; network incident)

Run `terminal-2026-08-05T18-58-32-101Z` … `terminal-2026-08-06T01-52-44-555Z`
(~7h, degraded network for the back half). Homer passed (578s). **Five of the
ten non-homer entries failed on network, not pipeline logic** (see incident
note). Evidence row in the audit doc.

**N45 — hollow pass #3 (midday), highest priority.** Midday "passed" again
(3365s). The N38 exclusion held — no header text reached route text, and
`emptyDataTables` recorded header texts on both feature routes — but
**grounding never consults the empty-table evidence**: invoicing grounded on
the "Good" payment-score card and transactions on the "Review" tab label
while both data tables rendered zero rows (frames extracted from
`final-video.mp4`: /invoices shows an empty 9-column table under populated
summary cards — $4,200 open, $1,800 paid, so widget queries now resolve —
and /transactions shows permanent skeleton rows). The script's search fills
("Juniper", "Figma") were fixture-backed; the table query path alone stays
broken (browser-side `@supabase/ssr` `createClient` throws "URL and API key
are required" in mounted components; the table queries never resolve). Fix
at the grounding layer: a requested feature's tagged route that renders a
zero-row data table must not count as content-bearing for grounding that
feature — fail with the N26c fixture-shape steering. Trade recorded: a page
whose data surface is a zero-row table is not demonstrable for a data
feature even when the empty state is honest; the steering demands rows,
which the repair agent can seed.

**N46 — assert candidates are not feature-aware (cyberchef).** N39 fired as
designed on attempt 3, but its demand was structurally unsatisfiable *by
the catalog*: the route's three text-assert candidates (cap 3,
distinct-first, otherwise harvest order) were "Download CyberChef
file_download", "Options settings", "About / Support help" — matching no
feature — while the operation labels that could token-match sat past the
cap. Preparation cannot influence which texts become asserts, so five
attempts burned on an impossible task (the class N39 exists to prevent).
Fix at the catalog: candidate selection must be per-feature aware — for
each feature tagged to the route, include at least one verified text whose
tokens match that feature, beyond the distinct-first slots — and the N39
message should reuse the N36 sentence when tagged routes are
content-bearing: name the shown labels and steer featureInventory wording
alignment.

**N47 — populated data-table rows are invisible to harvest (directus
false-negative).** Directus cleared install (N42 validated) and reached
exploration, then failed "rendered only globally-repeated navigation
chrome" for /admin/settings/policies and /admin/settings/roles — but the
persisted screenshot shows a fully rendered, data-bearing page ("Access
Policies", populated row "Article API Access"). Cell text sits outside
every harvest selector, the page title is not an h1–h3, and the aria
fallback was suppressed because skip-links and icon-ligature strings
("people_alt", "folder", "insights") pushed the thin-harvest count past 8.
Fix: harvest visible populated data-table row text (first few rows) into
route text — the canonical data surface becomes content evidence, which is
also the honest grounding midday needs once N45 lands; secondarily, the
thin-harvest trigger should discount strings already seen on
previously-visited routes (the script explores serially and can track
cross-route repeats), so classifier-chrome cannot suppress the aria
fallback.

**Network incident (5 entries, no code change).** calcom and outline died
on "socket connection was closed unexpectedly" mid-upload; twenty's `git
clone` from GitHub timed out at 300s (proving the degradation was the local
network path, not Daytona); ghostfolio failed sandbox create at 300s; ghost
hit a 900s Daytona command timeout inside a 2h04m run that ended in a
runtime-repair validation failure. Measured during calcom's upload:
~130KB/s sustained with 6.5MB of TCP retransmits to the Daytona endpoint —
the same 213MB upload took ~2 minutes the prior night. Rerun these five
under a healthy network before drawing pipeline conclusions. Watch item: a
resumable or retried archive upload if this recurs.

**Validated this run:** N38 (header texts excluded, recorded with
`headerTexts`), N42 (directus install cleared, +2 stages), N39 (fired with
steering — exposing N46), N37 (conduit surfaced the seeding remedy; the
agent could not seed a session within its remaining budget after spending
three attempts on the feature-free min-3 rule — frontier), N43 (no
gate-incapable vetoes recurred). N41 and N44 remain unvalidated: calcom and
twenty died on network before reaching those seams. Excalidraw remains the
known canvas-evidence limitation, now with truthful wording-alignment
steering.

**Recommended order:** N45 first (a false-positive pass is the worst
outcome class; third hollow video) → N47 (supplies the honest row evidence
N45 will demand; unblocks directus) → N46 (same catalog seam; unblocks
cyberchef) → rerun midday, directus, cyberchef plus the five network
casualties. Phase 7 is orthogonal consolidation and can proceed immediately
after N45–N47 land.

**Landed (2026-08-05, same day).** `3e38633` (N45 — grounding vetoes a
zero-row data-table route as content-bearing for a requested feature; when
every missing requested feature failed only on the veto, the run fails as
`empty/unmeaningful app state` with a per-feature sentence naming the shown
distinct content and the N26c fixture-shape steering; the veto is scoped to
requested features and per route — a second tagged route without an empty
table still grounds). `9a1e579` (N47 primary — the script's table walk now
also harvests the first populated rows' leading cell text into route text
and reports a `populatedDataTables` count per route; a populated table
lifts the N45 veto since the data surface demonstrably renders rows;
real-browser test shaped like the directus admin page — junk-rich selector
harvest, title outside h1–h3, rows only in cells). `edb0534` (N47
secondary — the thin-harvest trigger discounts strings already harvested on
previously-visited routes, so icon-ligature/skip-link chrome cannot make a
thin harvest look rich and suppress the aria fallback; real-browser
two-route test). `8fff663` (N46 — every feature tagged to a headingless
route gets at least one verified text whose semantic tokens match it,
beyond the cap-3 distinct-first slots (shared token recipe extracted as
`featureSemanticTokens`); the N39 flow-evidence gap message names the shown
distinct labels and steers featureInventory wording alignment when the
tagged routes are content-bearing). Full gauntlet per commit; 820 tests
green, including the previously-flaky remotion browser test.

## Phase 7 landed (2026-08-05, same day as N45–N47)

**7.3** `a152425` (+`b25cbf3` graphs) — one stage→artifact-path map:
`schemas/artifact-paths.ts` exports `makeADemoArtifactPaths` and
`stageWriteableArtifactPaths`; the runner's permission table, both
divergent `artifactPaths` consts, and the hardcoded
static-script-contract literals now read from it. **7.2** `99b9d38` —
prompts travel by file: the runner writes the prompt via
`workspace.writeTextFile` and the command reads it back with
`"$(cat …)"`, so prompt bytes never cross the PTY line discipline; the
planned >4KB probe is subsumed (the contract test's end-of-prompt nonce
proves intactness end-to-end). **7.1** `51ff947` — `runAgentArtifactStage`
replaces the four artifact-only loops (flow-planning,
runtime-target-selection, script-writing, script-repair) with uniform
semantics: the artifact is read regardless of exit code and accepted when
valid and changed from the pre-loop baseline fingerprint (a crashed agent
whose FlowSpec landed now succeeds; a crashed repair leaving the script
untouched still fails — both pinned by tests); malformed JSON is
preserved as `invalid-<artifact>-attempt-N.json` and cleared for a fresh
rewrite; a timeout clears the OpenCode session and retries once with the
kill disclosed; denial detection stays gated on an unreadable artifact.
Scoping decision: prepareRepo/repairPreparation keep their richer native
loops — they already pioneered these semantics plus manifest-specific
machinery (misplaced-path recovery, template reset, unchanged-fingerprint
guard, dependency-repair short-circuit, infra-error chaining) that would
bloat the shared helper into a hook farm. Their one uniformity gap closed
separately: `4c713b2` — prepareRepo now starts a fresh session after a
timed-out attempt and disclosures the kill. **7.5** `0467c9f` — one
wall-clock budget (`MAKEADEMO_JOB_DEADLINE_MINUTES`, default 90, max 600)
checked at every orchestrator stage-loop boundary; breach throws
`AgentHarnessJobDeadlineError`, classified as infrastructure so the failed
run manifest carries the accumulated evidence without a preparation
fallback wrap. **7.6** `bd21937` — the drifting appDir/envUsed/
Scene-description/presentation-defaults prompt lines deduped into shared
instruction constants beside `offCameraAuthenticationInstruction`.
**7.4** `67faa37` — opt-in real-OpenCode contract test
(`MAKEADEMO_OPENCODE_CONTRACT=1`, needs a local `opencode` credential; one
model call, ~$0.002). Findings from live probes (OpenCode 1.17.19):
`--dangerously-skip-permissions` does NOT defeat the explicit permission
table — it only suppresses interactive prompting, so the flag stays; a
denied write surfaces "specified a rule which prevents you from using
this specific tool call" on a line naming the file, exactly what
`throwIfRequiredArtifactWriteWasDenied` matches; `--format json` event
lines carry a recoverable `sessionID`; `opencode run` under a piped stdin
waits for EOF (the runner's PTY transport is unaffected; relevant if the
execute seam changes). Watch item: exact-string edit-permission globs are
sensitive to OpenCode's project-root discovery (a bare relative rule and
a symlink-resolved absolute rule both failed on a macOS tmpdir while
`**/name.json` matched everywhere); the production /workspace spellings
are validated by real runs, but if a sandbox artifact-write denial ever
recurs, try globstar spellings before anything else. Full gauntlet per
commit; 828 tests green except the known environmental
remotion-video-renderer failure, which recurred intermittently and still
reproduces at clean HEAD.

## Open decisions to confirm before Phase 4/7

1. **Lifecycle scripts** (4.4): suppress-always is the minimal safe default, but some apps need
   `postinstall` codegen (`prisma generate`). Proposed: suppress during the network window, then run
   a **network-closed** `rebuild`/`postinstall` pass only when preflight fails with a
   missing-artifact signature. Decide when the first fixture needs it.
2. **`--dangerously-skip-permissions`** (7.4): keep only if the contract test proves the permission
   table still binds; otherwise remove and accept slower OpenCode runs.
3. **YAML parsing** (5.6): stay with the minimal regex relaxation vs. adding a yaml dependency —
   decide on first real-repo failure, not preemptively.
4. **Dependency-adaptation seam under fidelity** (Phase 3): when the classification is
   `external network required` and no registry-resolving version of the direct dependent
   exists, should fidelity permit a minimal import + call-site swap (the fix rejected in
   Midday attempt 6)? Default **no** — fidelity stays strict; Midday itself does not need
   it (`node-xlsx@0.22.0` exists). Revisit only on a repo where no version escape exists.

## Phase 8 landed (2026-08-06)

Every deletion-table row was re-verified against HEAD before acting — Phases
1–7 had already absorbed more of the table than the plan text assumed.
**Deleted/consolidated:** `649d455` inlines the `executeSubmittedCode`
pass-through at its 14 call sites and deletes the module plus its
tautological test; `24b6f31` dedupes the two `escapeRegExp` copies into
`shared/text/escape-regexp.ts`; `1ebc7d6` drops the AppMap's flattened
top-level aggregates (`buttons`/`links`/`forms`/`inputs`/`primaryNavigation`/
`routeTitles`/`screenshots`/`accessibilitySnapshots`/`candidateFlows`/
`stableLocatorCandidates`/always-empty `appStateAssumptions`) and the
invalid-dialect `createRouteLocatorCandidates` — none had a server reader or
prompt mention, per-route fields carry the same data, and old persisted
app-maps still replay because unknown keys are ignored; `fd8935a` points the
Script Writing allowlist at the shared artifact-path map; `6a7a33c` deletes
the security screen's produced-but-discarded `warnings` surface (sole caller
reads only `status`/`rejections`; the useful signals — postinstall risk,
lockfile absence — are independently recomputed by the profiler) along with
the screen's now-unused `repoStats` input and the harness input field that
fed it. `0140765` regenerates the graphs.

**Verified already resolved (no commit):** the dead recorder + 729-line
test, `getPreviewUrl`/`downloadFiles` interface members (today's
`downloadFiles` is the live Daytona SDK method), `cancelActiveCommands`
(private), the `readSuccessfulCaptureProtocol` twin, `mergeRuntimeMarkers`,
`qualityFindings`, the `terminal-demo-runner` pass-through (today's module is
real input-collection logic consumed by `run-demo-pipeline.mts`), the
fonts/music triplicate (single source in `demo-script.schema.ts`; all ten
font files referenced — eight by compositing, Exo/Honk by the web app UI),
and the workspace-interface optionals (all methods required; remaining `?:`
model genuinely absent values).

**Kept deliberately:** the three trailing "retry loop exited early" throws —
they are typing-required fall-through guards on bounded paid retry loops, and
replacing them with `for (;;)` would turn a future early-`continue` bug into
an unbounded paid spin instead of a loud error; `contractVersion` — a real
cross-boundary pin: `readScriptCandidate` runs on persisted candidates in the
replay path. **Deferred:** gating `knip --production` — the advisory
`knip:prod` script already exists, but making it a gate first needs a
production-entries audit of the web/API/persistence surface it currently
flags as unused (24 files, including live `app.ts`); the four
production-unused agent-harness exports it names
(`normalizeCrawlUrl`, `resolveRuntimeTarget`,
`evaluateDependencyInstallCommand`, `defaultRepoSnapshotGit`) are deliberate
test seams. Net for the series: −280 source lines. Full gauntlet per commit;
826 tests green (one full-suite browser-contention flake of the capture-path
validator did not reproduce on rerun or in isolation).

## Addendum (2026-08-06, fourth 11-repo matrix — N45–N47 validated; install-gate class N48; N49–N52)

Run: `matrix-report-2026-08-06T20-41-04-831Z.json`. **2 passed** — homer
(875s) and conduit's **first end-to-end video** (801s). Nine failures, six
root causes, three of them one shared gate bug. No network incidents: the
08-05 "network casualties" label was wrong — those runs died on the same
install gate diagnosed below (ghost: ember-admin schema loop; ghostfolio:
sandbox timeout; zero registry/timeout evidence in either day's logs).

**N48 (Critical, feature) — the dependency-install gate's unconditional
lifecycle-script suppression makes postinstall/native-build repos
unrunnable.** `withLifecycleScriptSuppression` appends `--ignore-scripts`
(or the manager's equivalent) to every install, and no repair can remove it
— the flag is re-applied on every attempt. Three repos are structurally
dead on it: ghost (better-sqlite3's binding never builds even though the
repo's own `pnpm-workspace.yaml` allowlists it; Ghost binds :2368 then
crashes on its first query), ghostfolio (`postinstall: prisma generate`
never runs; 85 TS2305 errors; `dist/apps/api/main` never exists),
cyberchef (`postinstall: grunt exec:fixCryptoApiImports` never runs;
crypto-api's extensionless ESM imports die under Node 24; 0 modules
found). This settles Open decision #1 with three fixtures. Remedy: keep
suppression while the network window is open, then after reseal run a
network-closed lifecycle pass (dependency rebuild + root postinstall) —
same trust level as running the app itself, which already executes
arbitrary repo code offline.

**N49 (High, bugfix) — the N41 `.opencode` diff exemption manufactures
phantom deletions when the repo commits `.opencode/`.** cal.com ships
`.opencode/skill/**` as tracked files; `git rm -r --cached -- .opencode`
on the temporary index turns them into ~49 deletions against HEAD, and the
runtime-target-selection read-only gate aborts on attempt 1. Remedy: reset
the `.opencode` subtree to HEAD in the temporary index — still drops
untracked session state, fabricates nothing.

**N50 (High, bugfix) — preflight burns its full probe budget when a
supervisor keeps a crashed app's parent alive.** Ghost's nodemon survives
the child crash, so `process.running` stays true and all three preflights
polled 16 probes (~198s each; 743s = 47% of the run) against a
byte-identical, already-captured crash log, classified "listen failure"
with empty repair hints. Remedy: bail early when the port stays refused
and the managed app produces no new output across consecutive probes, and
give listen failures a hint pointing the repair agent at the captured
output.

**N51 (Medium, feature) — resource-load failures record the page URL, not
the failing resource.** Outline's demo shell injected `/app/index.tsx`
under Vite's `base: "/static/"`, the entry module 404'd twice per route,
React never mounted (0-byte aria snapshots) — and the console evidence
said only "Failed to load resource ... 404" prefixed with the page URL,
so five repair rounds never learned which path 404'd. Remedy: capture
request-level failures with the actual resource URL and status, deduped
and bounded, excluding guard-blocked requests (those are already
blockedNetworkAttempts).

**N52 (Medium, feature) — the text harvest cannot see into shadow DOM.**
Directus's repair broke the `@directus-extensions` virtual module; every
route rendered only Vite's error overlay — whose exact import error sat in
the aria snapshots but reads as "no visible content" to the classifier
because the overlay lives in an open shadow root and `innerText` stops at
the boundary. Five repair rounds chased "data fixtures" instead. Remedy:
harvest open shadow-root text on the thin-harvest path.

**midday — N45 validated; the repair chased the wrong layer (no N item;
the fix channel is N50/N51-class evidence).** The zero-row gate fired on
all three explorations, correctly. Local reproduction (screened tar +
final patch, outside the sandbox) shows the prepared app's client bundle
never hydrates under `next dev` — Next 16.2.1 + Turbopack boots, consumes
the flight stream, and no app client module ever evaluates, silently, in
four browser configurations; the demo flag was correctly Turbopack-inlined
and the server-side demo link provably returned 3 invoice rows during SSR
prefetch. Midday's tables are virtualized, so rows exist only after
hydration — a hydration-dead page structurally cannot satisfy N45 no
matter how correct the fixtures are (the summary cards render because they
are server-streamed markup). A production build hydrates but trips a
different client crash. Watch items: a framework-agnostic
hydration-aliveness signal (no element gains framework event listeners
after content-wait) to classify client-runtime death separately from empty
data; the consoleErrors 50-cap saturates with benign HMR-websocket and
blocked-analytics noise (dedupe + benign-class filter when a real signal
needs the room).

**Queued (agent-frontier, after the small fixes):** twenty — the fidelity
gate demands the demo-gate token per changed file, so a caller-side gate
(`if (isMakeADemoDemo) await import(...)` in `index.tsx`) is invisible
when validating `graphqlMocks.ts`, and the single-blocker repair prompt
made the agent shuttle one gate between two files for six failures
(file-set-level gate reasoning + all-current-violations prompts).
excalidraw — the static-contract rejection "uses ActionCatalog route …
outside the selected FlowSpec" omits the scene/feature that makes it a
one-line move (the sibling message names them), and the forcing function
is upstream: the sole cataloged interaction for the feature is an
external-origin marketing banner occluded by a modal at capture time
(external-target links should not ground a feature's only interaction).
Cosmetic: the matrix report's `detail` keeps only the first line, which is
empty-suffixed for build failures whose output starts with a newline.

### Landed (2026-08-06, same day)

**N48** `f75e8ba` — `createOfflineLifecycleCommand` in the install gate
builds the network-closed counterpart of the suppression flag: the
manager's own rebuild (`npm rebuild` / `pnpm rebuild` / berry
`yarn rebuild` — honoring the repo's declared build allowlists) plus the
root `postinstall` when the repo declares one (`--if-present` for npm/pnpm
so workspace-member install directories stay a no-op). The pass runs after
the reseal is verified, in the install cwd, under the install timeout; a
nonzero exit is a classified install failure carrying the real build
error. bun (trusted-scripts model) and classic yarn (no offline rebuild)
skip the dependency half by design. **N49** `e32739e` — the diff exemption
is now `git reset -q HEAD -- .opencode` on the temporary index; a real-git
regression test (committed `.opencode/skill` file + untracked session
state + one genuine change) pins that only the genuine change is reported
— the prior string-assertion-on-a-fake coverage is exactly how the
phantom-deletion bug survived. **N50** `0424c66` — landed as steering
only: the early-exit half was deliberately rejected because the pinned
preflight specs encode that a running-but-frozen process is
indistinguishable from a silently compiling cold start, so a refused port
keeps the full readiness budget; listen failures with a live process now
carry a hint pointing the repair agent at the captured app output (where
ghost's crash already was, verbatim, three times). **N51** `4bd2d9d` —
the explorer records request-level failures as
`page: failed resource <url> (HTTP <status>|<errorText>)` in
consoleErrors, deduped by resource, excluding guard blocks and
ERR_ABORTED churn; pinned by a real-browser test whose entry module 404s.
**N52** `bc31574` — the diagnosis sharpened during TDD: Playwright's aria
snapshot already pierces open shadow roots and directus's overlay text was
in the snapshot all along — the thin-harvest fallback's token regexes
capped matches at 79 characters and dropped the one long text run. The
fallback now accepts runs to 400 chars (unquoting, truncating to 120), so
error overlays and web-component content reach route text; pinned by a
real-browser shadow-root test. Cosmetic `75ad0e7` — the matrix report
appends the first informative continuation line when a failure's first
line ends with a bare colon. Full gauntlet per commit; 835 tests green.

## Addendum (2026-08-07, fifth 11-repo matrix — gate typo N53; N54–N57; two infra casualties)

Run: `matrix-report-2026-08-07T08-01-15-338Z.json`. **2 passed** — homer
(467s) and excalidraw's **first end-to-end video** (1166s). Nine failures,
six root causes, two of them Daytona control-plane instability (conduit:
502 on the first API call after runtime-target-selection, after a 15-minute
sandbox provision; outline: "An operation is already in progress for this
resource" at preflight's first sandbox operation — no code defect in
either). The N48 batch demonstrably moved the frontier: cyberchef cleared
install → build → preflight → exploration for the first time and died in
flow planning; calcom cleared the N49 phantom-deletion abort and reached
the suppressed install; ghost's repair rounds were correctly steered at
the captured crash output by the N50 hint; directus's preflight now
surfaces the exact Vite unresolved-import error (N51-class evidence);
midday's prepared app hydrates (the HMR websocket handshakes in
consoleErrors prove live client JS — the 08-06 hydration death is fixed).

**N53 (Critical, bugfix) — the yarn-berry suppression flag is misspelled,
killing every berry repo at install.** `withLifecycleScriptSuppression`
appends `--mode=skip-builds`; yarn's valid values are `update-lockfile`
and `skip-build` (yarn's own usage error names them). Both the suppression
branch and the gate's flag allowlist carry the same plural, so the gate's
tests agree with the wrong value and could not catch it. calcom burned all
three preflight rounds on it; twenty two. Latent until this run because no
berry repo had ever reached the suppressed install before. Rider:
install-failure evidence records the pre-suppression `attemptedCommand`,
so the repair agents saw `yarn install --immutable` blamed for a `--mode`
flag they never passed — record the gate's executed command instead.

**N54 (Critical, bugfix) — the N48 offline lifecycle pass is a silent
no-op on pnpm and drops the engine bypass.** (a) After
`pnpm install --ignore-scripts`, pnpm's pending-builds/approval model
records nothing to rebuild, so the bare `pnpm rebuild` exits 0 having
built nothing — ghost's own `allowBuilds: better-sqlite3: true` was
honored in name only, the bindings never appeared, and nodemon kept the
parent alive through three correctly-hinted but unfixable repair rounds
(the agent's best in-repo guess was an `.npmrc` with `force=true`).
Remedy direction: after the verified reseal, re-run the install offline
without the suppression flag (manager-appropriate `--offline` form) so
the manager's own approval policy governs which builds run; verify the
semantics per manager. (b) The lifecycle command does not inherit the N42
engine-bypass flag: directus's install passed only via the
`--config.engine-strict=false` retry, then `pnpm rebuild` died with
ERR_PNPM_UNSUPPORTED_ENGINE (sandbox Node 24 vs `engines.node: 22`),
wasting one of three rounds. Verify while implementing: whether
better-sqlite3 can build fully offline at all (prebuild-install download,
node-gyp header cache) — if not, pre-cache node-gyp headers in the
submitted-code snapshot.

**N55 (High, feature) — network-needing lifecycle scripts need a
by-design steering hint.** ghostfolio proved the N48 pass works: the
offline `npm rebuild && npm run --if-present postinstall` ran and
surfaced `prisma generate` failing on its engine download
(binaries.prisma.sh) — a failure that is permanent by design and
unrepairable by retry, but the evidence never says so. Key a hint on
lifecycle-failure output containing a fetch/URL error: the sealed network
will never open; remove the need for the download (neutralize the script
for the demo, avoid the engine at runtime, or vendor the artifact).
ghostfolio's repair then advanced to `Cannot find module
dist/apps/api/main` — the declared start needs a build the run-plan never
declared — before exhausting budget; the same missing-workspace-build
class killed directus (`@directus/extensions/node` unresolved because the
workspace package's `dist/node` is never built).

**N56 (High, feature) — flow-planning rejections surface one violation
per round and name no candidates.** cyberchef reached flow planning for
the first time and spent its 3-attempt budget learning the constraint
surface serially: one no-artifact flub, then "must include unique
ActionCatalog evidence" and "must select a browser-exercised interaction
when one is available" — neither rule names qualifying action ids, though
the adjacent route-distinct rule does exactly that (N40). Remedy: collect
all current violations per attempt into one rejection, and name
qualifying candidate ids for both rules.

**N57 (High, design) — two gates can squeeze the repair space to empty,
and the loop never says so.** midday: hydration works, both feature
tables render headers and search inputs, zero rows. The N45 message
asserts "the data query resolved empty or mis-shaped — align the fixture
shape" — but a virtualizer whose scroll container measures zero height
renders zero rows with correct data present, and the classifier cannot
discriminate the two. The repair agent evidently believed the virtualizer
theory: it added an `isMakeADemoDemo`-gated non-virtualized row render to
the two data-table components, and the per-file fidelity gate vetoed it
as UI modification — five times, budget exhausted, with no prompt ever
carrying both constraints together. Remedy package: (a) downgrade the
N45 diagnosis to an observation naming both candidate causes
(fixture shape; virtualized-container measurement); (b) livelock
handling — a vetoed repair's next prompt must present the veto and the
original failure as one constraint set steering at the intersection
(fixture/data-path fixes), extending the existing
`appendRepairRejection` seam; (c) the queued twenty item: fidelity gate
reasoning over the repair's file set, not each file in isolation;
(d) consoleErrors dedupe — all ten visible midday entries were one
repeated HMR-handshake error (the 08-06 watch item is now load-bearing).

### Landed (2026-08-07, same day)

**N53** `c2e821c` + `11238f8` — the suppression branch and the flag
allowlist both carry `--mode=skip-build`, pinned by a test that runs the
suppressed berry command back through the gate's own allowlist (the
missing coupling that let the two wrong values agree). The gate result
now carries `executedCommand`, and the install-failure,
external-network, and reseal-failure reports name the command that ran —
suppression flag and retry flags included — instead of the manifest's.
**N54** `55002ed` — the experiment overturned the diagnosis before the
test was written: with a matching `allowBuilds` allowlist, a bare
`pnpm rebuild` after `--ignore-scripts` DOES run builds in a
single-project repo (verified against better-sqlite3 12.11.1 with
ghost's exact config form). The silent no-op is workspace-root scoping:
at a monorepo root, members' dependencies are outside the root project's
rebuild scope, so it exits 0 having built nothing — reproduced, and
fixed with `pnpm rebuild -r`, which behaves identically in
single-project repos. The lifecycle command now derives from the gate's
executed command, inheriting `--config.engine-strict=false` when the
install only passed via the N42 retry (directus's wasted round).
Incidental empirical finding: pnpm 11 reads the build allowlist from
`pnpm-workspace.yaml` `allowBuilds`; the `onlyBuiltDependencies` list
form did not enable builds under 11.20. **N55** `4d86917` — lifecycle
failures whose output shows a download attempt (URL fetch errors,
ENOTFOUND/ECONNREFUSED class) carry the sealed-by-design hint: remove
the need for the download; a gyp build error is pinned as NOT firing
it. **N56** `56fa369` — planner-repairable violations are collected and
thrown as one rejection (referential-integrity failures still throw
immediately, since later checks depend on them); the browser-exercised
rule names up to three exercised candidate ids and the unique-evidence
rule names up to three unreferenced tagged ids — and is now enforced
only when such a candidate exists, extending the N21b never-wedge
precedent to a rule that could previously demand the impossible.
**N57** `839bb0b` + `d832cab` + `db63430` + `945d031` — the zero-row
message is an observation naming both candidate causes (empty query vs
zero-height virtualizer) and steers repairs at fixtures and data paths;
a vetoed repair's next prompt carries the original failure and the veto
as one simultaneous constraint set; a conditional demo gate in a changed
caller now counts for the module it references (with a precision pin
that a gate elsewhere in the diff does NOT rescue an unreferenced file)
— the twenty two-file shuttle becomes a passing candidate; and the
explorer keeps one console entry per error class (query strings and long
hex runs stripped from the dedupe key), pinned by a real-browser test
that midday's exact HMR-retry noise collapses to one entry while a
distinct hydration error still records. Full gauntlet per commit; 846
tests green (+11 this batch).

## Loop economics and structural review (2026-08-07, N58–N64)

Measured round cost this run: ghost ≈ 1.4m repair agent + 4m13s
re-validation (~3m of it the readiness probe budget burning against an
already-captured crash); midday ≈ 1.5m agent + 5m25s re-validation
including a full re-exploration of every route. Already warm: the
workspace sync excludes `node_modules` (installs across rounds are
incremental) and broker passes within one validation skip reset/install.
The waste is across rounds, and the biggest waste is rounds that should
never have been spent (calcom: three rounds on N53; conduit/outline:
infra; cyberchef: constraint discovery).

**N58 (High, feature) — skip install + lifecycle on repair rounds whose
diff leaves dependency inputs unchanged.** The round loop already
computes `repairDelta.dependencyInputsChanged` (used only to trigger
lockfile reconciliation); when it is false and the previous round's
gated install succeeded in this same sandbox, pass
`installDependencies: false`. Sound because the warm `node_modules` is
the product of this sandbox's own gated install and unchanged inputs
would reproduce it; record the reuse in the report
("install reused from attempt N"). Saves 1–2 minutes on nearly every
round; most repairs touch source and fixtures, not manifests.

**N59 (Medium, feature) — scoped re-exploration on repair rounds, full
pass before accept.** When exploration failed on named features/routes,
re-explore only those and merge with the prior round's app map; any
candidate that passes the scoped check must pass one full exploration
before acceptance, so the false-pass guarantee stays authoritative.
Saves 2–4 minutes per round on exploration loops (midday re-walked every
route five times to re-learn that two tables were empty).

**N60 (deferred; reopens N50 narrowly) — repeat-round stall-fingerprint
probe early-exit.** Round 1 keeps its full probe budget: the
cold-compile-vs-frozen ambiguity is settled and pinned. Rounds ≥ 2 hold
evidence round 1 lacked — when the port stays refused, the managed
output has stopped changing, AND its tail fingerprint equals the prior
round's stall, exit the probe loop early. Only worth implementing if
listen-failure loops persist after N54; the pinned N50 specs describe
round 1 and stay untouched.

**N61 (High, feature) — failure fixability taxonomy: infra faults must
not consume repair budget or reach agent prompts.** Daytona
control-plane errors killed conduit outright and, on outline, were
serialized verbatim into `preparation-fallback.json` as a "blocker" for
a future coding agent to "fix". Remedy: classify provider/control-plane
errors as infra at the workspace seam; retry with bounded backoff (the
creation-path connection retry exists — extend the same treatment to
lifecycle operations such as `updateNetworkSettings`); when retries
exhaust, fail the run as infra with no fallback prompt and no repair
budget charge. Rider: outline's 57-second give-up preparation (zero
changes, auth intact, knownLimitations admitting the demo URL cannot be
served) passed manifest validation — add a manifest truthfulness check
so a self-declared-unusable runtime fails fast with the declaration as
evidence.

**N62 (High, docs + feature) — specify the repair-evidence contract
once; audit every gate against it.** The recurring failure class behind
N29a/N50/N51/N52/N53-rider/N56/N57 is evidence distortion, fixed one
symptom at a time. Write the contract down as the interface every
validator owes the repair agent: (1) executed commands verbatim, never
pre-transformation inputs; (2) bounded evidence channels deduped with
per-class caps so one noisy class cannot saturate the budget; (3)
observations separated from diagnoses — causal claims only when the
validator can actually discriminate the cause; (4) all currently-known
violations per attempt, not first-fault; (5) no infra errors in agent
prompts. Then audit the existing gates against it in one pass instead of
rediscovering violations one matrix run at a time.

**N63 (Medium, prompt) — state the sealed-network world rules in the
preparation prompt.** The prep agent currently learns the rules by
failing: lifecycle downloads fail offline (prisma engines, prebuilds,
node-gyp headers); workspace-package build outputs exist only if a
declared build command produces them; the submitted-code sandbox is
sealed while the agent's own sandbox is not, so "works in my sandbox"
proves nothing about the demo runtime. Say all of it up front —
prevention is cheaper than repair rounds. Prompt text carries no unit
tests (policy); acceptance is behavioral via the matrix.

**N64 (design, gated on N58/N59 outcomes) — mid-turn offline probe for
repair agents.** The repair agent cannot reproduce sealed-sandbox
failures in its own networked sandbox (`prisma generate` succeeds
there), so today every hypothesis costs a 4–6 minute round. A bounded
tool — run the gated install/boot/probe in the submitted-code sandbox
now and return the report, hard-capped per turn, reseal verified before
and after, reusing the existing gate code paths and introducing no new
network states — converts cross-round iteration into intra-round
iteration. Design only after N58/N59 land and only if boot-failure
loops persist; the shared-sandbox reset semantics and window state
machine must be specified before any implementation.

**Process decision — matrix rotation.** Five remediation iterations have
now been fit against the same eleven repos; the matrix is drifting from
test set to training set. Before declaring the gate suite general, add
two or three fresh repos of genuinely new shapes (a canvas/WebGL-heavy
app, a non-JS backend with a JS frontend, a static-site generator) and
keep the current eleven as regression.

Recommended order: N53 → N54 → N55 (small, unblock four repos), N58
(cheapest economics win), N56 → N57 (agent frontier), N61 → N62 → N63,
then N59; N60 and N64 stay gated on the post-N54 matrix.

## Addendum (2026-08-07, sixth 11-repo matrix — argv-limit N65; stall economics; N66–N71)

Run: `matrix-report-2026-08-07T23-22-03-590Z.json` (the 22:35:58Z batch;
two earlier same-evening starts aborted before agents ran). **1 passed** —
homer (870s, absorbing one 300s agent stall). Ten failures, seven root
causes, two of them new bugs of ours. The N53/N54/N57 batch demonstrably
moved walls: calcom and twenty cleared the berry install for the first
time (N53); twenty also cleared preparation-fidelity for the first time
(the N57c caller-gate ended the two-file shuttle); directus's engine
bypass carried into the lifecycle (N54b); midday's repair loop visibly
converged (round 1: invoicing and transactions both zero-row; round 3:
invoicing fixed, only transactions left); directus and outline failures
now carry exact route-aware causes (N51 + N57d evidence: directus
`/src/extensions.ts` HTTP 500, outline `undefined (reading 'forEach')` +
NotFoundError). N54 itself went unexercised — ghost never reached
install (see the stall item).

**N65 (Critical, bugfix) — repair prompts exceed the kernel argv limit;
the repair budget burns with zero model involvement.** The runner writes
the prompt to a file, then substitutes it straight back into a single
execve argument via `"$(cat …)"`
(default-opencode-harness-runner.ts:73); past ~128KB (MAX_ARG_STRLEN)
bash reports `/root/.opencode/bin/opencode: Argument list too long` and
exits 126 in ~1.1s. Two feeders crossed the limit this run: calcom
statically — `createRuntimePreparationRepairPrompt` inlines the whole
repo profile (145,209 bytes for calcom) even though the same file is
listed in the prompt's own artifactPaths for sandbox reading; ghostfolio
dynamically — repair rounds 1–3 launched fine, then round 3's ~80KB diff
bloated the next round's failure evidence past the cap. Both pipelines
then burned their remaining repair budget in ~3 seconds (three instant
126s each) and died reporting "did not produce valid required artifact."
Remedy: stop inlining artifacts that are already readable artifact
paths (repo profile foremost); bound every interpolated evidence field;
enforce a byte ceiling with mid-elision at the runner seam as a
last-resort guard for every stage. Transport stays argv (`"$(cat …)"`):
switching to stdin depends on unverified OpenCode CLI behavior, and no
stage legitimately needs a >100KB prompt — smaller prompts are strictly
better for cost and attention.

**N61 (promoted from the queue; now urgent) — 15 agent-command stalls in
one matrix; stalls and launch failures spend agent-quality budget.**
Every repo hit at least one 300s timeout (homer recovered; ghost did not
— both runtime-target-selection attempts hit the 300s *total* cap with
output still flowing, and the pipeline died before install ever ran).
This is the concurrent matrix's bill: eleven parallel pipelines
contending for the model API. Each stall costs 5 minutes and consumes
the same attempt budget as a real agent-quality failure; calcom's and
ghostfolio's instant exit-126 launch failures (N65) did the same. The
taxonomy as specced above, sharpened by this run: infra-class command
failures (timeout/no-output; instant non-zero exits that never created
an OpenCode session) retry in their own bounded lane without consuming
artifact/repair attempts. Rider: the runtime-target-selection total cap
(300s) is too tight for large repos under concurrency — raise it above
its inactivity cap.

**N68 (High, feature; promoted from the N61 rider) — give-up preps: a
manifest the empty workspace diff contradicts must fail validation.**
Four repos followed the same arc this run (calcom, twenty, ghostfolio,
excalidraw): prep agent stalls out mid-work → a 30–90s "repair" writes a
manifest, changes nothing (`patchBytes: 0`), passes artifact validation
→ fidelity passes trivially → everything downstream fails against an
unprepared app. Last matrix this happened once (outline); it is now the
dominant failure shape. The check is claims-vs-diff consistency, not
diff emptiness per se: a manifest declaring fixtures, demo gating, or
integration adaptations while the workspace diff contains no supporting
change is untruthful and must fail with steering back to preparation
(a genuinely zero-change repo whose manifest claims nothing stays
valid).

**N67 (High, feature) — unbuilt internal workspace packages need
prerequisite-build steering.** twenty's preflight build dies on
`Cannot find module …/twenty-shared/dist/vite.mjs`; directus's blank
admin traces to `/src/extensions.ts` HTTP 500 (`@directus/extensions`
unbuilt). Second consecutive matrix for this class. Install plus native
rebuild never builds *internal workspace* packages — that normally rides
on turbo/nx build graphs the pipeline never runs. When a build/start/
console failure names an unresolved module that matches a workspace
member (the repo profile knows the member names), steer the repair with
the harvested run target (N44) that builds that member before the app
command.

**N71 (High, bugfix) — forced-feature satisfiability: exploration's
flow-evidence gap check skips agent-selected features.** conduit has no
maker-requested features, so the check behind N39
(submitted-app-explorer.ts, `feature.requestedFeature === undefined` →
skip) ignored all three inventory features — but flow planning must
select `min(3, inventory)` = all three, and `comment-on-article` has
zero tagged asserts. Structurally unsatisfiable from the first planning
attempt; the planning budget burned on an impossible demand (its first
attempt also lost 350s to a stall). Extend the check to every feature
planning can be forced to select: when fewer than `min(3, |inventory|)`
features carry both a tagged interaction and a tagged assert,
exploration fails with the existing gap steering naming what each
feature lacks.

**N69 (Medium, feature) — yarn berry hides lifecycle build failures in
sandbox-local build.log files.** calcom's first-ever successful berry
install was followed by the N48 lifecycle `yarn rebuild`, which rebuilds
*every* pending package — including sealed-network downloaders (prisma
engines, sentry-cli, sqlite3 prebuilts). It failed, but the real errors
live in `/tmp/xfs-*/build.log` files that yarn's YN0009 lines only
reference — so N55's download-failure regex saw nothing and
`suggestedRepairHints` stayed empty. Harvest bounded tails of the
referenced build.log files (first few, capped bytes) into the failure
evidence so the sealed-network steering can fire.

**N70 (Design, feature) — single-shell apps defeat route-distinct text
evidence.** excalidraw regressed from last run's first video: prep
created `/?flow=…` query variants of one canvas shell, every string
repeats across "routes," the chrome discount swallowed the entire
toolbar, and exploration reported "only globally-repeated navigation
chrome." cyberchef's two features are similarly forced onto identical
evidence on its single page. The evidence currency (route-distinct
*text*) structurally cannot see one-shell canvas/tool apps — the
overfitting worry made concrete. When explored routes collapse to one
distinct pathname (query/hash variants of a single shell), repeated
content must not be classified as chrome, and the N36 control/aria
evidence lane needs to extend to distinguish features by exercised
controls rather than text. Canaries: homer (per-route text) and midday
(data tables) shapes must pass unchanged.

**N66 (Medium, infra) — pipeline runs leave Daytona sandboxes running on
completion and abort.** Tonight's aborted run left 18 STARTED sandboxes;
the completed evening matrix left 16 more still STARTED two hours later;
only Daytona's lazy auto-archive reclaims them. Pipeline completion
(success or failure) must tear down the sandboxes it created; the matrix
runner should handle SIGINT the same way. Cost and quota (~125
concurrent) both bleed until this lands.

**ENOSPC note (infra, unnumbered).** twenty's first two preflight
installs died filling the sandbox disk (4,399 packages, +3.14 GiB, yarn
global cache plus linked copies) before the third attempt recovered.
Sandbox disk headroom or yarn cache pruning is worth sizing alongside
the Daytona quota when N66 is implemented.

**midday needs no new item.** The loop was winning and ran out of
rounds: round 5's repair was its *first* fidelity veto (ask-midday.tsx
ungated), so the N57b intersection hint never had a subsequent round to
steer. N58/N59 round economics remain its medicine.

Recommended order: N65 → N61 → N68 (budget integrity — stop the
bleeding), N67 → N71 → N69 (unblock specific repos), N70 (design),
N66 (infra); N58/N59 still queued next for round economics.

### Landed (2026-08-07, same day)

All eight items, in the recommended order. `8076d76` N65: the runtime
repair prompt no longer inlines the repo profile (it is already a
listed artifact path), every interpolated evidence field is bounded by
a shared `elideMiddle` (new `src/server/shared/text/elide-middle.ts`;
graphs regenerated in `b93d7c7`), and the OpenCode runner enforces a
96KB last-resort ceiling for every stage prompt. Transport stays argv:
no stage legitimately needs a >100KB prompt. `b490f91` N61: command
stalls ride a new `agentStallRetries` lane (default 2, env
`MAKEADEMO_AGENT_STALL_RETRIES`) in both the generic artifact loop and
the runtime-repair loop without spending `agentArtifactAttempts`; the
launch-failure detector now recognizes shell exec diagnostics
(`bash: …: Argument list too long`, `logout`) so an E2BIG-class launch
is infrastructure, not agent quality; runtime-target-selection's total
cap rises 300s→600s. A found-in-flight fix: stall retries repeat an
attempt number, so first-run detection now keys off a prior-run flag —
without it the retry prompt lost the kill disclosure. `342f580` N68:
fidelity fails a manifest claiming `mocksAndFixturesAdded` or
`blockedExternalServicesReplaced` over an empty diff; truthful
emptiness (calcom/twenty-style honest give-ups, env-only demo modes,
zero-prep repos) still passes — the honest-hollow shape remains prompt
territory (N63) and preflight's job. `a78e112` N67: a module missing at
an absolute path under the repo's own node_modules after a successful
install is diagnosed as an unbuilt workspace-linked package (registry
packages ship their files) and steered at the repo's own build target,
at both the build-failure and runtime-report seams. `8149248` N71: the
flow-evidence gap check covers agent-selected features — when no maker
features exist and fewer than min(3, |inventory|) grounded features
carry a tagged interaction plus assert, exploration fails with the gap
steering (grounding shortfalls still fall through to the richer
unreachable/hollow handling). `50bd4ad` N69: YN0009-referenced
`build.log` paths are tail-harvested (first 3, 2KB each, redacted) into
the lifecycle failure report, and the N55 sealed-network detector runs
over the harvested text. `15bd1e0` N70 (mechanical core; `refs`, not
closes): chrome repetition counts distinct shells — query/fragment
variants of one pathname are one shell, `#/…` hash routing stays a
distinct page — so single-shell apps stop having their persistent UI
discounted as chrome; the text-free canvas evidence lane (excalidraw's
bare-canvas case) remains the gated design half, expected to matter
less once N68/N61 prevent hollow preps. `aec4322` N66: every created
workspace handle registers in a process-wide registry,
`destroyAllDaytonaWorkspaces()` drains it, both runner scripts hook
SIGINT/SIGTERM, and the agent-sandbox auto-delete backstop drops
720→150 minutes (an hour past the 90-minute job deadline).

Verification: TDD per item with the failing test verified red first;
`bun run lint`, `bun run typecheck`, `bun run test`, `bun run knip`
green per commit — with one standing exception: `remotion-video-
renderer.test.ts` (the parallel session's pinned-browser render test)
fails on this machine on a clean checkout independent of these changes
and was excluded from the per-commit suite runs after that was
verified against HEAD. Tests 850→858 (+13 this batch, net of the
diagnosis-window baseline 846→850 from N53–N57's landing). Matrix
expectations: calcom/ghostfolio repair rounds now reach the model
(N65) and their berry lifecycle failures carry causes (N69); ghost
survives selection-stage weather (N61); give-up preps die at fidelity
instead of exploration (N68); twenty/directus get prerequisite-build
steering (N67); conduit fails at exploration with actionable gaps
instead of wedging flow planning (N71); cyberchef's single-shell
evidence survives chrome discounting (N70); interrupted runs stop
leaking sandboxes (N66).

## Addendum (2026-08-08, seventh 11-repo matrix — first midday video; native-artifact class N72; N73–N77)

Run: `matrix-report-2026-08-08T06-48-00-266Z.json`. **2 passed** — homer
(1894s) and **midday's first end-to-end video** (3192s), the loop that
converged across two matrices finally landing. Runtimes are longer by
design: the N61 stall lane absorbs timeouts instead of dying on them.
Every item from the N61/N65–N71 batch observably fired: zero exit-126s
(N65 — every calcom/ghostfolio repair reached the model), ghost
cleared runtime-target-selection for the first time in three matrices
(N61) and reached preflight, N68 forced honest preps (excalidraw
renders real content now; its wall moved two stages forward), N67's
steering was followed verbatim by directus's agent, and N69's
harvested build.log is what makes calcom's diagnosis below possible.
Nine failures, five root causes.

**N72 (Critical, infra) — sealed-network native artifacts, now the #1
blocking class (ghost, ghostfolio, calcom).** ghost: `pnpm rebuild -r`
ran and correctly attempted better-sqlite3, which cannot compile
offline — the prebuild download is sealed and node-gyp then wants
Node-24 headers it also cannot download; boot dies on "Could not
locate the bindings file" (the exact rider N54 flagged for
verification). ghostfolio: the repair agent wrote the right guard
(`if [ -f node_modules/.prisma/client/index.d.ts ] … else prisma
generate`) but the client was never generated, so the guard falls
through to the sealed engine download every round. No repair agent can
manufacture these artifacts inside a sealed sandbox; the durable fix
is backend-owned. (a) **Snapshot node-gyp headers**: the sandbox's
Node version is fixed by the snapshot image, so `node-gyp install`
during the snapshot build makes every node-gyp source compile work
offline — fixes ghost and calcom's sqlite3 with zero per-run cost.
(b) **Backend prisma-engine prefetch during the install window**: the
engines a repo needs are keyed by its own `@prisma/engines-version`
resolution; the backend (not repo code — scripts stay suppressed, so
the security model is unchanged) derives the engine URLs and warms
`~/.cache/prisma` inside the already-open dependency window, keyed off
lockfile evidence. (a) first; (b) is the larger design half and is
gated on (a)'s matrix result showing prisma still blocking.

**N73 (High, bugfix) — the engine-strict bypass has a third missing
location: the runtime env.** directus's agent-authored gated `predev`
runs `pnpm -r --filter @directus/app... run build` and dies on
ERR_PNPM_UNSUPPORTED_ENGINE (Node 24 vs engines 22). Install gets the
bypass (N42), the offline lifecycle inherits it (N54b), but agent-
authored in-repo pnpm invocations at build/start time do not. When the
install only succeeded via the bypass retry, export
`npm_config_engine_strict=false` into the guarded runtime env so every
downstream package-manager call inherits what the install already
established about this sandbox.

**N74 (High, feature) — package-manager identity is backend territory.**
outline's prep agent deleted `"packageManager": "yarn@4.11.0"` and
added a `.yarnrc`, silently downgrading the repo from yarn berry to
yarn classic; lockfile reconciliation then ran yarn 1.22 against a
berry lockfile and imploded (the registry 404 for a package literally
named "5.0.1" is berry `resolutions` syntax read by classic).
Fidelity must reject removal or version-change of the `packageManager`
field and creation of manager-config files (`.yarnrc`, `.yarnrc.yml`,
`.npmrc`) the same way lockfiles are protected, with a hint that the
backend pins the manager and adaptations must stay inside it.

**N75 (Medium, infra) — sandbox disk sizing.** twenty hit ENOSPC on
its first install for the second consecutive matrix:
`defaultSandboxDiskGB = 3` against 3.14GiB of dependencies alone. Its
later ECONNREFUSED build fetches and the final EBADF are wounded-
sandbox fallout, not independent causes. Raise the submitted-code
sandbox disk default (target 10GB) after re-checking the Daytona quota
arithmetic (disk quota bounds matrix concurrency).

**N76 (Medium, feature) — flow-planning retries must start clean.**
excalidraw died at flow planning with a satisfiable catalog: asserts
existed, the navigation fallback was legal, and the agent produced the
identical assert-less FlowSpec three times inside one sticky OpenCode
session. (a) Drop the session on artifact-invalid retries — the
timeout path already does — so the retry re-reads the contract fresh;
(b) rejection prompts append a minimal concrete example composed from
the violation's own candidate ids (prompt text; behavioral acceptance
via the matrix per policy).

**N77 (Medium, feature) — single-shell apps: the nav-chrome half of
N70.** cyberchef's operation names live in nav-role sidebar links, so
the `navChrome` union — untouched by N70's shell fix — still swallows
them as text matches and the requested feature's `/?op=…` route reads
as chrome-only. When explored routes collapse to a single shell, skip
the navChrome text exclusion: with no cross-page navigation to
discount, the "nav" is the product. Multi-shell behavior unchanged
(homer canary).

**calcom's gate-syntax casualty (fold into queued N63, no new
number).** N69's harvested build.log shows calcom's real lifecycle
failure: the agent's MAKEADEMO_DEMO gate on `@calcom/prisma`'s
post-install used `if/then` shell syntax that turbo's built-in
mini-shell cannot parse (`Unbound variable "MAKEADEMO_DEMO"`,
`command not found: then`). N63's world-rules prompt gains a rider:
package.json script gates run under restricted shells (turbo, nx) —
gate with `node -e` conditionals (directus's agent did this
correctly), never `if/then`.

**conduit needs no new item** — exploration steering was clean (2 of 3
features grounded, six content-bearing reselection routes named); the
budget died before the reselection landed. That, plus cyberchef and
ghostfolio burning full budgets on converging repairs, makes **N58 and
N59 (round economics, specced under Loop economics above) the top
loop-shaped items in this batch.**

Recommended order: N72a → N73 → N74 → N75 (unblock the pinned repos;
all small except none), N58 (cheapest economics win, specced), N76 →
N77 (planning/exploration polish), N63 with the turbo-shell rider
(prompt work), then N59; N72b gated on the post-N72a matrix, N60/N64
still gated.

### Landed (2026-08-08, same day; N62 pulled forward by request)

All nine items. `b4750b0` N72a: the submitted-code image installs
build-essential + python3 and caches node-gyp headers for its own Node
version — **operational step: rebuild and re-push the submitted-code
image/snapshot before the next matrix, or ghost/calcom keep failing on
the old image**. `d89f102` N73: `npm_config_engine_strict=false` joins
the guarded runtime env unconditionally — the sandbox's Node is fixed
by the image, so the engines check can only kill demos, and threading
per-install state would go stale on N58's skipped-install rounds.
`166f91d` N74: fidelity rejects packageManager-pin changes and new
`.yarnrc`/`.yarnrc.yml`/`.npmrc` files; existing manager-config files
stay editable for in-manager tweaks. `82ae830` N75: the submitted-code
sandbox gets an explicit 20GB disk (agent sandbox stays 3GB; ~253GiB
for 11 concurrent pairs of the 2000GiB quota). `e5ae930` N58: repair
rounds whose delta leaves dependency inputs unchanged pass
`installDependencies: false` and reuse the prior round's install; the
reuse note travels as a suggestedRepairHint, deliberately not in
logsSummary — a round-varying summary prefix would defeat the
repeated-failure fingerprint (found in flight when two fingerprint
tests broke). The reusable-install tracker resets conservatively on
{install failure, external network attempted, harness/internal
failure}. `e068ee2` N76: FlowSpec rejections clear the OpenCode
session before retrying (the timeout path already did) and the retry
prompt shows a concrete referencedActionIds example built from the
rejection's own ids. `e06de6e` N77: on single-shell apps nav-listed
text stays groundable route-distinct content but ranks last for assert
selection, and flow planning's route-distinct preference stays strict
(nav text never satisfies it when a non-nav assert exists — its
satisfiability guard keeps nav-only catalogs from wedging); the
two-sided design emerged from a pinned assert-ordering test and the
chrome-preference test both failing against the naive exemption.
`abba688` N63: both preparation prompts and the runtime repair prompt
carry the sealed-network world rules including the turbo/nx
restricted-shell rider (gate with `node -e`, never if/then).
`86505f3` (refs N65): the initial preparation prompt and the
failed-prep repair prompt stop inlining the repo profile — two more
sites of the calcom 145KB inline found during N63. `26d54df` +
`a48143a` N62: `harness/internal failure` validation reports get one
agent-free revalidation then fail the run as not-agent-repairable
(zero repair-budget spend), and the five-clause repair-evidence
contract is written down in docs/agents/repair-evidence-contract.md
with a per-gate audit table and anchored on the ValidationReport
docstring.

Verification: TDD per item, failing test verified red first; lint,
typecheck, test, knip green per commit. Tests 858→870 (+12). The
remotion-video-renderer suite passed on the final full run,
confirming the earlier failures as environment flake, not breakage.

**N72a operational step executed (2026-08-08).**
`makeademo-submitted-code-browser-ca-20260808` built server-side via
`daytona snapshot create` from the updated Dockerfile (build log shows
`node-gyp install` caching the v24.15.0 headers); `.env` updated;
`bun run verify:daytona-image` passed end-to-end. Correction found in
flight (`ea566d8`): the org's **per-sandbox disk maximum is 10GB** — a
20GB request is rejected at creation — so N75 is pinned at 10GB
explicit, and twenty's remaining ENOSPC headroom, if it recurs, must
come from package-manager cache pruning after install, not disk.
Matrix expectations: ghost compiles better-sqlite3 offline and calcom's
sqlite3 stops failing (N72a, after the image rebuild); directus's
gated prerequisite build survives the engines check (N73); outline
keeps yarn berry (N74); twenty stops filling its disk (N75); repair
rounds drop ~1–2 minutes each on source-only repairs (N58);
excalidraw's flow planning converges (N76); cyberchef's operation
names ground its features (N77); prisma-class downloads get designed
around up front (N63) — ghostfolio remains the N72b gate test.

## Addendum (2026-08-08, eighth 11-repo matrix — first conduit video; node-line class N78; N79–N82 queued)

Run: `matrix-report-2026-08-08T19-04-54-096Z.json`. **2 passed** — homer
(981s) and **conduit's first end-to-end video** (1287s; the N77
satisfiability guard and single-shell currency landed it). Zero
exit-126s, zero ENOSPC (N75's explicit 10GB held twenty's install),
and N69's harvested build.log again decoded the one failure that
mattered (calcom below). Nine failures, seven root causes — and for
the first time nearly every one is backend/harness-owned: the agents
mostly did what we engineered them to do (directus's world-rules gate,
ghost's offline rebuild design, outline's honest retreat after the N74
veto). The frontier has moved from "agents doing the wrong thing" to
"the sandbox cannot run what correct agents prepare."

Diagnosis by class:

- **Repo-pinned Node line vs the image's Node 24 (directus, ghost) —
  N78 below.** directus pins `engines.node: "22"` with its own
  `.npmrc` `engine-strict=true`; every pnpm call dies
  ERR_PNPM_UNSUPPORTED_ENGINE under Node 24 (the N73 env bypass loses
  to a project-level `.npmrc` in pnpm's precedence, and the failing
  call is the agent's nested `execFileSync` where we cannot inject
  flags). ghost pins `devEngines: {node 22.23.1, onFail: download}`;
  pnpm 11 downloaded that Node during the install window and ran the
  app under it, while the agent's (correctly designed) offline
  better-sqlite3 rebuild compiled against `/usr/include/node` — the
  image's Node 24 headers — so boot died on ERR_DLOPEN_FAILED
  (NODE_MODULE_VERSION 137 vs 127). twenty pins `^24.5.0`, so no
  single-line image can satisfy the matrix.
- **Corepack absent from the submitted-code image (outline) — folded
  into N78.** outline pins `packageManager: yarn@4.11.0`; the image
  ships only a global npm-installed yarn 1.22.22 and never enables
  corepack, so the install dies asking for it. The agent's `.yarnrc`
  workaround was correctly vetoed by N74 — the gate held; the backend
  never supplied the pinned manager it promised.
- **Prisma engines under the sealed network (calcom, ghostfolio) —
  N72b's gate condition met; activate it.** calcom cleared last
  matrix's turbo-shell gate (N63 rider validated — turbo runs now)
  and its harvested build.log shows `@calcom/prisma post-install`
  fetching `libquery_engine` from binaries.prisma.sh network-closed.
  ghostfolio's `postinstall: prisma generate` was script-suppressed in
  the window, then failed the same fetch offline — no generated
  client, so the client build dies on TS2305 `'@prisma/client'` has no
  exported member.
- **Yarn-variant misdetection from agent-chosen flags (excalidraw's
  burned early rounds) — N79.** The agent wrote `yarn install
  --immutable` for a yarn-classic repo; `readYarnInstallVariant`
  infers berry from flags, so the offline lifecycle issued `yarn
  rebuild`, which yarn 1 does not have — a harness-generated invalid
  command cost a preflight attempt and a repair round.
- **Canvas evidence gap (excalidraw terminal) — N70b, already
  queued.** Exploration demanded wording-matched text asserts for
  canvas features; two features forced onto one assert+interaction
  made uniqueness unsatisfiable; the final repair was vetoed on the
  demo-gate rule. excalidraw cannot pass without the text-free canvas
  lane.
- **App-stuck-loading blind spot (cyberchef) — N80.** The N21d
  screenshot shows CyberChef sitting on its loading overlay through
  the whole exploration; text harvested from the DOM behind the
  overlay, zero actions cataloged, no console/page errors, no blocked
  requests — silent. The N71 gate fired "requested feature not
  observable" with wording-alignment steering, sending five
  repo-preparation-repair rounds at featureInventory wording while the
  actual defect was a hung loader.
- **Preparation-manifest validator defects (midday regression) —
  N81.** (1) The initial repo-preparation loop in
  default-harness-dependencies has no N61 stall lane — `attempt += 1`
  unconditionally — so a 300s inactivity stall consumed one of three
  artifact attempts. (2) `assertKnownSourcePaths` throws on the first
  unknown path: attempt 2 rejected `evidencePaths[3]` (agent-created
  `src/demo/fixtures.ts`), attempt 3 rejected the same path in
  `featureInventory[0].sourcePaths[3]` — whack-a-mole that violates
  repair-evidence contract clause 4. (3) The message never states the
  rule (files created during preparation are not citable product
  evidence), so the agent could not learn the constraint it kept
  tripping.
- **Existing-manager-config mutation slipped the N74 gate (twenty) —
  N82.** The agent flipped the repo's existing `.yarnrc.yml` from
  `nodeLinker: node-modules` to pnp with `pnpMode: loose` (N74 only
  rejects *new* manager-config files), then rewrote twenty-front's
  build script to `yarn nx build twenty-front` where nx is not a
  dependency ("Couldn't find a script named \"nx\"").

### N78 (Critical, infra + feature) — repo-pinned Node lines: one image, baked lines, system swap

Design decision (explored against three alternatives): a **single
submitted-code image baking every common Node LTS line (20, 22, 24) as
official tarballs, with the backend resolving the repo's pin from the
screened archive and swapping `/usr/local` wholesale to the resolved
line before any repo command runs.** Rejected: (a) multi-Node image
with PATH selection — correctness-by-plumbing; every exec seam
(install gate, offline lifecycle, managed-app spawn, capture restart,
the repo's own nested spawns) must carry the selection, and ghost's
ABI split-brain is exactly what one missed seam looks like; (b)
per-line snapshot variants — correctness-by-construction but triples
every build/verify/rotate cycle we just executed by hand; (c) runtime
download from nodejs.org — adds a per-run network flake surface and
checksum plumbing for artifacts we can bake at build time; (d)
bypass-only (extending N73) — cannot beat a project-level `.npmrc` and
trades honest engine errors for ABI corruption. The swap makes the
one-image design safe: post-swap only one Node exists in the sandbox —
binaries, headers, and every nested spawn agree by construction — and
the wrong-Node failure class is impossible rather than plumbed around.
Reactive detection (boot default, fail, switch) is rejected outright:
directus spent 28 minutes discovering what one manifest line declares;
resolution is proactive, from the screen we already hold.

Work items (TDD each; the boundary that generalizes is **repo runtime
vs harness tooling** — the swap must only ever touch the repo's
world):

1. **Pin resolution (pure module, `SUPPORTED_NODE_LINES = [20, 22,
   24]` as the single source of truth).** `resolveNodeLine({files,
   targetId})` → `{line, provenance, satisfied}`. Constraints
   gathered: `devEngines.runtime` (node), `engines.node`, and
   `.nvmrc`/`.node-version`, from the repo root and the locked
   `targetId` app dir; exact versions map to their major line; ranges
   evaluate via `semver` (already in the tree transitively; add as a
   direct dependency). Selection: highest baked line satisfying the
   intersection of all constraints; if the intersection is empty, the
   root's install-governing constraint wins (install is the first
   gate); if no baked line satisfies at all, nearest baked line with
   `satisfied: false` recorded — a run that then fails preflight on a
   node-version error self-explains. No pin → the default line (24),
   so nothing currently passing regresses.
2. **Image redesign (one Dockerfile, one snapshot).** Remove the
   Playwright base image's apt-layout Node entirely — including
   `/usr/include/node`, the stale-header trap ghost's gyp fell into —
   and install the default line from the official tarball at
   `/usr/local`. Bake all three lines' tarballs under
   `/opt/node-lines/` with build-time SHA256 verification. Set
   `npm_config_nodedir=/usr/local` in the image env (and mirrored in
   the guarded runtime env) so node-gyp of any vintage compiles
   against whatever `/usr/local` currently is — this supersedes
   N72a's version-specific header cache. Move harness tooling
   (playwright, typescript, node-gyp CLI) out of the swappable prefix
   into a private `/opt/makeademo-tools` prefix invoked by absolute
   path, so the swap can never delete our own capture stack. Manager
   provisioning moves to **corepack** (each line's tarball ships it):
   drop the npm-global pnpm/yarn, bake a warm `COREPACK_HOME` cache
   for the default manager versions, set
   `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, and re-run `corepack enable`
   as the final step of every swap (shims live in the swapped bin).
   This is the outline fix: pinned managers resolve exactly, and
   unpinned repos keep classic yarn via corepack's default. A
   Dockerfile-content test asserts the baked-line layers match
   `SUPPORTED_NODE_LINES` so the const and the image cannot drift.
3. **Swap execution (one choke point, idempotent).** The provider
   exposes the primitive (verify marker file → clear
   `/usr/local/{bin,include/node,lib/node_modules}` → untar the line
   with `--strip-components=1` → `corepack enable` → assert `node
   -v`); the harness owns the *when*: once per submitted-code sandbox,
   after target lock and before the first submitted command (install
   gate or agent-run alike), so even the earliest agent probe sees the
   resolved line. The resolved line and provenance are recorded in the
   run plan and echoed in every preflight report (`node -v` evidence),
   so future version diagnoses read off the artifact instead of gyp
   arg forensics.
4. **World-rules rider (N63 text).** One line: the backend fixes the
   Node version from the repository's own pin; agents must never
   install, download, or reconfigure Node. Prevents the workaround
   class before it starts.
5. **Verify + rollout.** `verify:daytona-image` gains a swap check
   (boot, swap to a non-default line, assert `node -v`, `corepack
   yarn --version`, and a minimal `node-gyp configure` smoke against
   the swapped headers — ABI alignment is the entire point). Then the
   same one-command rotation as today: one snapshot build, `.env`
   update, verify, ledger note.

Growth path: when Node 26 goes LTS, the change is one entry in
`SUPPORTED_NODE_LINES` plus one tarball layer — the resolution,
swap, and verify machinery are line-agnostic. The exact-version
download fallback (a pin whose *major* we do not bake) is deliberately
not built: resolution records `satisfied: false`, and pnpm-style
managers that download their own exact Node stay ABI-compatible with
our line-matched headers (NODE_MODULE_VERSION is per-major). Mid-run
line switches are likewise not designed for: the pin basis (screened
archive + locked target) is immutable by construction, agent pin edits
are gate territory, and the one residual (stale engines metadata) is
undetectable without machinery neither design ships — if it ever
occurs it fails legibly at preflight and becomes its own item.

Acceptance: directus's engine check passes under 22; ghost's
better-sqlite3 compiles with 22-line headers and loads under
pnpm-downloaded 22.23.1; twenty stays on 24; outline installs with
corepack-provisioned yarn 4.11.0; every unpinned repo behaves
identically to today.

### Queued from this matrix (planned on request)

**N72b (activate)** — backend prisma-engine prefetch during the
install window, per the seventh-matrix spec; calcom and ghostfolio now
both block on it. **N79** — yarn-variant detection must read the
repo's identity (packageManager pin, now authoritative via N78's
corepack), not the agent's chosen install flags. **N80** — exploration
readiness gate: persistent loading overlay / zero interactive elements
alongside harvested text → bounded re-poll, then classify "app stuck
loading" and steer repair at the runtime, never at wording. **N81** —
preparation-manifest validator: report all unknown source paths across
all fields in one error (contract clause 4), state the eligibility
rule in the message, and give the initial repo-preparation loop the
N61 stall lane. **N82** — extend N74 to semantic mutations of
*existing* manager-config files (nodeLinker, enableScripts, yarnPath,
use-node-version). **N70b** remains queued for excalidraw.

Recommended order: N78 (unblocks directus + ghost + outline and is
the substrate for N79), N72b (calcom + ghostfolio), N81 (midday
regression), N79 → N80 → N82, then N70b.

### Landed (2026-08-08, same day)

All six planned items, in the recommended order. `2beba2e` N78
resolution + swap: `node-line-resolution.ts` is the pure module
(`SUPPORTED_NODE_LINES = [20, 22, 24]`, semver intersection over
root + locked-target pins, root wins conflicts, nearest line with
`satisfied: false` when nothing satisfies, no pin → 24); the harness
attaches the resolution to the RunPlan right after run-plan synthesis
and activates it once per submitted-code sandbox before the first
repo command. The swap command guards the marker file, fails legibly
to stderr when the tarball layer is missing (an old image), and
never shell-`exit`s — that would drop the PTY sentinel. Deviation
from the plan text: the resolved line is recorded in the run-plan
artifact plus a `node-line.activated` sandbox-log event, not echoed
into every preflight report — the artifact is the diagnosis surface
and preflight reports stay unchanged. `2b8cbfb` N78 image: the
Playwright base's apt-layout Node and `/usr/include/node` (ghost's
stale-header trap) are purged; the default line installs from the
official tarball at `/usr/local`; all three lines bake under
`/opt/node-lines/` with SHA256 verification;
`npm_config_nodedir=/usr/local` makes every node-gyp vintage follow
the swap (supersedes N72a's version-specific header cache); harness
tooling moves to the swap-proof `/opt/makeademo-tools` prefix,
resolved at runtime via `MAKEADEMO_TOOLS_NODE_MODULES` with an
`npm root -g` fallback so the pre-N78 image still captures; managers
provision via corepack with a warm `COREPACK_HOME` surviving swaps.
A Dockerfile-content test imports `SUPPORTED_NODE_LINES` so the
const and the image cannot drift. `ccd581e` N72b: after a successful
install, while the window is still open, the backend prefetches
prisma query/schema engines into every installed `@prisma/engines`
dir — the commit hash is read from the installed
`@prisma/engines-version` package (deviation: keyed off the
installed tree, not lockfile text — the tree is what the generate
step will actually consult), downloads are atomic (tmp+mv) and
best-effort by construction (the command always exits 0), and no
third-party code runs while the network is open. `cd206ee` +
`0c95956` N81: manifest validation now reports every out-of-screen
citation across evidencePaths and all featureInventory sourcePaths
in one error carrying the eligibility rule (agent-created files are
never product evidence; cite the original modules the demo adapts),
and the initial repo-preparation loop gains the N61 stall lane — a
timeout without a usable artifact retries without consuming an
artifact attempt (stall retries are loop state, not persisted
attempt files). Placement was shaped by a pinned test: a timeout
that already wrote a valid manifest is a success, so the lane sits
after the manifest read. `421cfdc` N79: `RepoProfile.yarnVariant`
derives from the repo's own identity (packageManager pin major,
else `.yarnrc.yml`/`.yarnrc` presence) and is authoritative in
suppression, offline-lifecycle, and reconciliation; agent flags
remain the fallback. Found in flight: excalidraw actually pins
`yarn@1.22.22`, so flag-based detection had classified it berry and
its install-window lifecycle scripts were never truly suppressed —
yarn 1 silently ignores `--mode=skip-build`; the pin now selects
`--ignore-scripts`. `cfb77d3` N80: the generated exploration
protocol detects full-viewport loading overlays (≥60% coverage,
loading/spinner/splash/progressbar/aria-busy), waits bounded (15s
inside the route budget), records `loadingOverlay` per route, and
skips exercising stuck routes — exercising them produced junk
chrome evidence and burned minutes in click-timeout retries; the
classifier steers stuck-route grounding failures at the runtime
startup path, never at wording. `0d13ea0` N82: mutating
identity-semantic keys (nodeLinker, pnpMode, enableScripts,
yarnPath, use-node-version, node-version) in *existing*
manager-config files is now an identity violation; other keys stay
editable for in-manager tweaks. `45f8ad4` regenerated dependency
graphs for the two new modules.

Verification: TDD per item, failing test verified red first; lint,
typecheck, test, knip green per commit. Tests 870→903 (+33). The
remotion-video-renderer suite stayed green all window.

**N78 operational rollout executed (2026-08-08).**
`makeademo-submitted-code-browser-ca-20260808-nodelines` built
server-side from the rewritten Dockerfile (build log confirms the
apt Node purge including `/usr/include/node`, SHA256-verified
tarballs v20.20.2 / v22.23.2 / v24.19.0, default 24 active with the
marker file, corepack yarn 1.22.22 + pnpm 10.12.1, tools prefix
populated); `.env` updated; `bun run verify:daytona-image` passed
end-to-end including the new sealed-sandbox swap step (offline swap
to line 22 → `v22.23.2`, corepack-provisioned managers, node-gyp
configure smoke against the swapped headers).

Matrix expectations: directus's engine check passes under 22; ghost
compiles better-sqlite3 against 22-line headers and loads it under
pnpm's downloaded 22.x (NODE_MODULE_VERSION now matches by
construction); twenty stays on 24; outline installs via corepack
yarn 4.11.0; calcom and ghostfolio start with warm prisma engines
(N72b); midday's stall and citation classes are closed (N81);
cyberchef's stuck-loading failures, if any, steer at the runtime
(N80); excalidraw's install window is finally script-suppressed
under classic yarn (N79) — its terminal blocker remains N70b
(canvas evidence lane, still queued).

## Addendum (2026-08-08, ninth 11-repo matrix — first excalidraw video; outline false positive; N83–N91)

Run `matrix-2026-08-08T23-39-56-603Z` / report
`matrix-report-2026-08-09T00-40-48-518Z.json`. Three passed: homer
(4min), **excalidraw's first-ever video** (46min — N79's classic-yarn
suppression validated in the best way possible), and outline (60min)
— but outline's pass is a **false positive**: the video is a guided
tour of error states. Eight failed. The batch scorecard is strong:
N78 fully validated (directus and ghost both resolved and activated
line 22; the ABI/NODE_MODULE_VERSION class is extinct;
`npm_config_nodedir` correctly steered even a 2021 vendored
node-gyp), N72b validated (calcom installed with warm prisma
engines), N76/N77/N80/N81/N82 held. The frontier moved again: to
environment completeness (python/distutils, boot-validated theme
builds, disk economics), to the **error-copy evidence gap** outline
exposed, and to flow-planning diagnosability.

### Diagnoses

**outline (passed, hollow — the worst failure mode: a shipped bad
video).** The prep agent built a Vite-middleware API adapter with
fixture data (design sound; auth worked, sidebar rendered the
fixture team). But the adapter's responses violate Outline's client
contract: list envelopes missing `pagination`, non-array `data`
(`Pagination information not available in response`,
`res.data.map is not a function` — 9 page errors), and fixture
entities missing required fields (`parseEmail` on a user with no
email crashed `<Invite>`, `<UserFilter>`, `<MembershipPreview>`).
Every list request threw: home rendered an eternal skeleton (zero
harvested text), toasts stacked ("Could not load shared/starred
documents"), the fixture doc slug 404'd, `/search` crashed into the
error boundary. Three gate defects let it through: (1) the manifest
declared router *patterns* (`/collection/:collectionSlug`) and the
harness navigated them verbatim — 6 of 10 explored routes were
guaranteed 404s, and two demo scenes `goto` placeholder URLs; (2)
**error copy is admissible evidence** — "Not found" headings, 404
body text, error toasts, and the error boundary's "Something
Unexpected Happened" satisfied route-distinct grounding, N21b
assert selection, and capture-path validation; the script literally
clicks the error boundary's "Reload" button and asserts its crash
heading; (3) 19 console errors and 9 page errors were recorded and
gated nothing on the pass path. N80 correctly saw no overlay —
skeletons are a sibling class, not a stuck overlay. Secondary: Vite
dep re-optimization mid-exploration (504 "Outdated Optimize Dep"
across five `?v=` generations).

**ghost (preflight, 503).** N78 win: line 22 activated,
better-sqlite3 compiled AND loaded. New blocker at boot:
`ThemeValidationError: the currently active theme "source" has
fatal errors` → Ghost stays in maintenance (503). The bundled theme
is a workspace package whose built assets don't exist in a fresh
checkout; six sealed-network repair rounds cannot build what needs
the install window. N67's class in a new costume.

**calcom (preflight, offline lifecycle).** Install succeeded,
prisma engines warm. `sqlite3@5.1.7`'s vendored node-gyp 8.4.1 runs
`from distutils.version import StrictVersion` — deleted in Python
3.12 (the image's python). Our header plumbing worked
(`-I /usr/local/include/node/common.gypi`); the Python side broke.
Attempts 2–3: agent disabled other native builds, then the record
ends mid-monorepo-root-build with no error line — consistent with
the lifecycle timeout killing it silently (diagnosability gap).

**twenty (preflight, install).** ENOSPC during the link step:
947MiB of berry zips plus the expanding node_modules double-store
on the hard 10GB org cap. The dormant cache-pruning contingency is
activated — but the peak is *during* link, so post-hoc pruning
alone cannot fix it.

**conduit (flow planning, regression).** Three attempts, one
byte-identical rejection: feature `browse-and-favorite-articles`
never selected both a tagged interaction and a tagged assert. The
rejection lists what was available, never what the candidate
referenced; rejected candidates are not persisted, so neither the
agent nor the diagnosis can see the actual mistake. Suspected
tension: the route-distinct assert preference vs. a tagged-assert
set that is all nav-ish headings.

**cyberchef (exploration, satisfiability).** "Use Magic or
operation search to decode a sample" has no visible-text assert in
the catalog — its proof text (search results, operation output)
appears only *after* an interaction, which static harvest cannot
see. Five repair rounds, zero convergence. Same family as
excalidraw's old blocker: tool-shaped UIs reveal evidence
interactively.

**directus (exploration, near-miss).** First time past install AND
preflight. The repair loop genuinely converged — attempts 1–2 had
three unobservable features, attempt 3 one (policies routes
rendering only nav chrome; N21 doing its job on a real data gap) —
and ran out of budget one fix short.

**midday, ghostfolio (infra).** Daytona API 502 / "Operation timed
out" during workspace creation; both sandbox logs empty; neither
run started. Rerun; nothing to build.

### N83 (Critical, feature) — quarantine error-state evidence

The general defect: text that describes failure counts as proof of
success. Three framework-agnostic signals, all applied at harvest
so every downstream gate inherits them unchanged: (1) **alert
quarantine** — the generated script harvests text inside
`role=alert`/`role=status`/`alertdialog`/`aria-live` regions into a
separate per-route `alerts` list, excluded from headings/text;
alert text can never ground features or seed asserts, but it is
attached to failure verdicts as repair evidence (the toast names
the broken contract). (2) **Not-found signature probe** — before
the route loop, visit a synthetic path (`/__makeademo-404-probe__`)
and record its content signature; any real route matching it is
`notFoundLike`, not content-bearing; if the probe redirects to a
real route, skip signature matching (redirect-style apps render no
404 page). No string-matching on app wording. (3) **Tainted
routes** — a route with an uncaught page error supplies no
grounding evidence and no asserts, with an ambient filter: an
error message on >50% of routes is background noise and does not
taint (mirrors the chrome rule; catches the crashed search page
whose error-boundary copy is ordinary DOM, without failing apps
that log one benign rejection everywhere). Classifier: a feature
whose routes are all non-content-bearing (empty, alert-only,
notFoundLike, tainted) → the existing `empty/unmeaningful app
state` classification with alerts + page-error messages as
steering evidence. Regression fixture: this run's outline app-map
replayed through the new logic must fail with the toast text and
`Pagination information not available in response` in the repair
prompt.

### N84 (High, feature) — placeholder routes are never navigable

Guard the three seams where a route becomes navigation: manifest
validation rejects route patterns (`:seg`, `*`, `[param]`) with
"routes must be concrete URLs reachable in the demo — substitute
your fixture slugs"; the exploration input builder drops pattern
paths defensively (recorded, non-fatal); the static script
contract rejects any `goto` with a pattern path so one can never
reach capture. Fail-fast at the manifest is the general fix — only
the agent knows its fixture slugs.

### N85 (High, feature) — prep riders + install-window escape hatch

Two one-line world-rules riders: API adapters must reproduce the
client's expected response envelope (copy the shape from the app's
own client/store code) and cover every endpoint the demo routes
call — a partially covered adapter fails exploration as an empty
app (outline); packages the app validates at boot (themes, plugins,
bundled dashboards) are prerequisite builds that must run during
the install window (ghost). Control-flow half (the truly general
piece): a repair that needs installation/network cannot succeed in
a sealed sandbox by construction — ghost burned six rounds proving
it. Add a repair lane that escalates **once per run** to a fresh
preparation cycle via the existing preparation-fallback mechanism,
carrying the blocker verbatim, instead of spending sealed budget.

### N86 (High, infra) — restore distutils; timeout markers

`python3-setuptools` in the submitted-code image (Ubuntu's package
ships the distutils shim), so any vendored node-gyp configures
under Python 3.12. Dockerfile content test asserts the package;
`verify:daytona-image` gains `python3 -c "from distutils.version
import StrictVersion"` beside the node-gyp smoke; one snapshot
rotation. Plus: when a gate/lifecycle command is killed at its
timeout, stamp `[makeademo:timeout]` into the log summary —
calcom's attempts 2–3 ended silently and diagnosis had to infer
the kill.

### N87 (Medium, feature) — disk economics with eyes open

The ENOSPC peak is during link (zips + node_modules coexist), so:
(1) `[makeademo:disk]` df markers before/after install, lifecycle,
and build — engineer to the hard 10GB number instead of guessing;
(2) prune manager caches after the offline lifecycle completes
(the `--immutable` re-run still needs the cache; the prune slots
after it), freeing ~1GB for build outputs and capture; (3)
steering: large workspace monorepos with a locked single-app
target prefer focused installs (`yarn workspaces focus`, pnpm
`--filter`) — lockfile-respecting, and the only lever that attacks
the peak itself. Rejected: backend-mutating `nodeLinker` — exactly
the identity violation N74/N82 forbid.

### N88 (High, bugfix) — flow rejections echo the offense

The rejection enumerates the feature's offending
`referencedActionIds` with per-id reasons ("tagged to feature X",
"untagged", "not an assert"); rejected FlowSpec candidates persist
as attempt files like every other stage; one prompt line
subordinates the route-distinct preference to the tagged-set
requirement.

### N89 (High, feature, largest) — interaction-revealed evidence

Tool-shaped UIs reveal proof-text only after an interaction, so
static harvest cannot catalog an assert and pairing is
unsatisfiable by construction. Extension: when exploration
exercises an interaction, harvest text that newly appeared and
catalog it as asserts carrying `revealedBy: <interactionId>`; flow
validation accepts an interaction+assert pair when the assert is
revealed by that interaction. The general form of cyberchef's Magic
search and excalidraw's old N70b blocker. Build last.

### N90 (Low, feature) — progress-aware repair budget

A repair round that strictly shrinks the failing-feature set
grants a bonus round, capped at +2 per run (directus died one
round short of a converging loop).

### N91 (Low, feature) — dev-server re-optimization reload

If a route visit records a 504 module-fetch failure (Vite
"Outdated Optimize Dep"), reload once and re-harvest.

### Rejected as non-general

Gating on console/stderr content (N21c's decision stands — N83's
compound signals replace it); string-matching error wording;
backend mutation of manager identity for disk savings; preflight
body inspection (content truth belongs to the browser stage).

Recommended order: N86 → N84 → N83 → N88 → N85 → N87 → N90 → N91
→ N89; TDD per item; one snapshot rotation covering N86.
Acceptance: outline must now **fail** at exploration with toast
text steering the repair (a failed outline run validates N83 as
much as a good video would); calcom clears its offline lifecycle;
conduit's rejection becomes self-diagnosing; twenty's df markers
prove or retire prong 3; midday/ghostfolio rerun clean.

### Landed (2026-08-08, same day)

All nine planned items, in the recommended order. `befd315` N86
image: `python3-setuptools` restores the `distutils` shim that
vendored node-gyp vintages import under the image's Python 3.12;
the swapped-runtime verify check now imports
`distutils.version.StrictVersion` on the live image. `e811609` N86
markers: `executeSubmittedWithDeadlineEvidence` streams heavy
submitted-code commands (install, lifecycle, build) and, on a
provider deadline, synthesizes exit 124 with the streamed partial
output plus a `[makeademo:timeout]` trailer — the PTY provider
throws on deadline without returning output, so timeouts used to be
indistinguishable from silent deaths; every lifecycle failure now
also carries a `[makeademo:command-end] exit=N` trailer.
Finding recorded during implementation: calcom's "silent" lifecycle
deaths were **not** harness timeouts — the stored output genuinely
ended mid-YN0007 with exit 1; the two trailers now make
killed-at-deadline, crashed, and completed-with-failure legible at
a glance. `b2cf63f` N84: `findRoutePlaceholder` (new module
`tools/route-placeholders.ts`) rejects router patterns
(`:param`, `*`, bracket segments; hash-router aware;
query-string colons exempt) at three seams — the prepared-feature
inventory gate (all offending paths in one error with the
fixture-slug rule), the script contract's goto/assert-url
validation, and exploration's feature-entry targets. `950a8d9`
N83: the generated protocol harvests alert/status/live-region copy
into a quarantined per-route `alerts` field (excluded from text,
headings, controls, and the aria fallback lane), fires a synthetic
`/__makeademo-404-probe__` probe (hash-form for hash routers;
dropped on redirect, deadline pressure, or overlay-stuck runs) so
the backend learns the app's not-found signature, and the backend
taints routes via parsed page errors (with an ambient-noise filter
mirroring the chrome rule) plus probe subset-matching with a
root-route fallback guard; error-state routes contribute
navigation only to the catalog, their evidence rides failed
verdicts, and all-features-on-error-routes promotes to
`empty/unmeaningful app state`. `ae754ce` N88: pairing rejections
echo what the candidate referenced (`id (kind)` per action);
rejected FlowSpec candidates persist in attempt files
(`onAttemptRejected` carries the parsed candidate); the FlowSpec
contract subordinates the route-distinct preference to the
tagged-set requirement. `029fa39` N85: sealed-network world rule 6
names boot-validated packages (themes, plugins, bundled dashboards)
as prerequisite builds and states that the gated install re-runs
with the network open whenever a change touches dependency inputs;
rule 7 requires replaced APIs to reproduce the client's envelope
exactly (pagination wrappers, array-vs-object data, required entity
fields such as user.email) across every consumed endpoint.
Deviation from the plan: the "escape hatch to a fresh preparation
cycle" was dropped — code inspection showed `validatePreparation`
already reopens the install window on every repair round whose
dependency inputs changed (the N58 reuse only skips unchanged
rounds), so ghost's six wasted rounds were a steering gap, not a
capability gap. `323706b` N87: the three heavy commands are
bracketed with `[makeademo:disk] <label> before|after` df markers
(labels `deps`/`lifecycle`/`build` — "install" as a label collided
with a test that greps commands for that substring) and
yarn/npm/pnpm caches are pruned after the offline lifecycle
completes, with corepack's cache preserved; prong 3
(focused-install steering) is deferred until the markers say the
peak is what the plan assumed. `bdedc8d` N90: exploration failures
now carry a structured `failingFeatureIds` list (populated on every
feature-scoped failure path); a repair round whose failing set is a
proper subset of the previous feature-bearing failure's set earns a
bonus global round, capped at +2 per run — churn (different
features failing) and app-wide failures earn nothing. `71b70b8`
N91: the generated protocol's `gotoRoute` reloads once when a
route visit records an HTTP 504 on a script resource (Vite's
"Outdated Optimize Dep" re-bundling window), then proceeds with
whatever renders. N89 in four commits: `ca2880c` the protocol
harvests text that newly appeared after each exercised interaction
(headings, dialogs, non-alert text; verified live in the revealed
state, where the demo script will assert it), for clicks and
fills/selects alike; `12a135b` the catalog emits those as
`assert-revealed-*` actions carrying `revealedBy:
<interactionActionId>` (schema validates revealedBy references an
interaction in the catalog); `1230c5b` routes bearing revealed
asserts count as content-bearing at exploration grounding, so
tool-shaped routes ground and are never classified hollow;
`e8fcf5d` flow validation accepts a revealed assert only together
with its revealing interaction (a mismatched pair is a violation
naming the required interaction), the revealed pair satisfies the
route-distinct assert preference, the script contract requires the
scene to run the interaction before the assert and rejects
revealed asserts in the off-camera setup lane, and the FlowSpec
contract states the pairing invariant. `afeb4ee` regenerated
dependency graphs for the new route-placeholders module.

Verification: TDD per item, failing test verified red first; lint,
typecheck, test, knip green per commit. Tests 903→934 (+31). One
full-suite run flaked on the remotion-video-renderer delayRender
timeout under parallel background load; it passed in isolation and
in the following clean run.

**N86 operational rollout executed (2026-08-08).**
`makeademo-submitted-code-browser-ca-20260808-distutils` built
server-side from the updated Dockerfile (2 CPU / 4GB / 10GB disk),
`.env` repointed, and `bun run verify:daytona-image` passed on the
live snapshot — including the new swapped-runtime check that
imports `distutils.version.StrictVersion` under the image's
Python, proving vendored node-gyp vintages can resolve their
distutils imports on every baked Node line. The tenth matrix run
is the acceptance gate for the batch: outline must fail at
exploration with quarantined toast text steering the repair,
calcom's lifecycle verdicts must be legible via the command-end
trailers, conduit's flow rejection must echo its own referenced
ids, twenty's disk markers must prove or retire N87 prong 3, and
cyberchef-class tool UIs now have the revealed-evidence lane to
ground and script against.

## Addendum (2026-08-13, remotion delayRender smoke flake root-caused: display sleep, not host load)

The recurring `remotion-video-renderer` smoke failure (`delayRender
"Waiting for root component to load" not cleared`, 28s on 2026-08-02
and 118s in the 2026-08-08 and 2026-08-12 windows, previously
attributed to machine load / a memory-starved host) is
display-coupled, not load-coupled. The test pinned Playwright's
full-Chrome build (Chrome for Testing 148); a full-Chrome page keeps
executing JS and timers while the macOS display sleeps but produces
no frames, so the requestAnimationFrame that clears the
root-component handle never runs. Evidence: every failing launch on
2026-08-12 (20:20-21:16) and 2026-08-13 (10:22-10:27) started while
`pmset -g log` shows the display off, and every pass ran display-on;
in a single failing window, full Chrome failed 5/5 across
gl=default/swangle and --headless=old/new while Remotion's managed
chrome-headless-shell passed in the same window. The prior
load/memory correlation was coincidental: away-from-keyboard windows
are both when matrix sessions run and when the display sleeps. Fix:
the smoke test now uses the Remotion-managed chrome-headless-shell
with no `browserExecutable`, exactly like production compositing
(`createDefaultRenderer`), and the now-unused `@playwright/test`
devDependency is removed; verified 5/5 green with the display asleep.
Raising `timeoutInMilliseconds` can never fix this class — an asleep
display stalls frames indefinitely.

## Addendum (2026-08-09, tenth 11-repo matrix — conduit and cyberchef first videos; the fidelity false-veto class; N92–N97)

Run `matrix-2026-08-09T04-38-20-486Z` / report
`matrix-report-2026-08-09T05-39-40-016Z.json`. Two passed, both
**first-ever videos**: conduit (41min) and cyberchef (45min —
grounded through N89's revealed-evidence lane, exactly its
acceptance gate). Nine failed. Batch scorecard: N89 validated
end-to-end, N90's bonus round observed live (excalidraw's sixth
attempt after its failing-feature set shrank 2→1), N84/N88
validated by conduit's clean pass, N87's twenty question left
unanswered (twenty died before install). Two acceptance gates
failed in instructive ways: calcom's lifecycle verdict is still
illegible (the trailer exists but nothing excerpts around it), and
outline failed at exploration for the right reason but with its
repair budget already spent upstream. The frontier this cycle is
not a new capability: it is precision. The preparation-fidelity
gate's false vetoes are now the dominant run-killer (four runs),
and one-shot infrastructure fragility (a single 502, a dropped
PTY tail, a 20-minute hang) killed or blinded four more.

### Diagnoses

**The fidelity false-veto class (directus killed; excalidraw
killed; outline 2/5 budget; ghost 2/5 budget).** The gate answers
semantic questions with syntactic proxies, and every proxy failed
on a real repo this run. Directus's preparation was textbook — a
fixture axios adapter (`demo-api.ts`) selected by `if (isDemo)` in
`api.ts`/`hydrate.ts`, original UI untouched — and was vetoed
because `app/src/utils/is-demo.ts`, a one-line boolean gate,
"creates replacement product UI": `isProductPresentationPath`
treats every path under a directory named `app/` as presentation
(directus's whole frontend package is named `app/`), and
`isDemoSeamPath`'s vocabulary has no `demo` token, so MakeADemo's
own gate file is not a seam to MakeADemo's own checker. The
repeated wrong verdict then hit the fidelity fingerprint cap of 1
→ dead run. Excalidraw's last two repairs seeded a demo canvas
scene — precisely what its failing undo/redo feature needed — and
attempt 7 gated it canonically (`const isMakeADemoDemo =
import.meta.env.VITE_MAKEADEMO_DEMO === "true"` … `if
(isMakeADemoDemo) { return { scene: getMakeADemoScene(), … } }`);
`readDemoGateIdentifiers`' lookbehind `(?<![A-Za-z0-9_])` rejects
the flag inside `VITE_MAKEADEMO_DEMO` (always preceded by `_`), so
the Vite-required prefix made the gate invisible and the "does not
conditionally use the demo gate" veto fired; attempt 6's
`__MAKEADEMO_DEMO__` define-constant hit the same underscore blind
spot. Outline lost two rounds to `app/utils/demo.ts`,
`demoFixtures.ts`, `isDemoMode.ts` (frontend dir also named
`app/`; camelCase `demoFixtures` cannot match the `fixtures` token
through the `[./_-]` delimiter requirement). Ghost lost two:
neutralizing `gravatar.js` — a genuine external-service
integration — was vetoed "outside a seam" because neither path nor
diff wording matches the seam vocabulary, and one veto fired on a
unit-test file. The deepest defect is not any single regex: the
created-file rule lets a path prior override content evidence — a
file with zero presentation content was vetoed without its content
mattering.

**homer, twenty (Daytona 502, no retry).** Both died on a single
transient 502 during artifact upload (`writeTextFile` →
`sandbox.fs.uploadFiles`), milliseconds after successful writes,
inside the 11-way parallel launch window. homer lost a run 3
minutes in over a 2.4KB file. One HTTP request, no retry, whole
run.

**calcom (offline lifecycle, evidence lost).** `yarn rebuild &&
yarn run postinstall` exited 1 three times. The captured PTY
stream ends at YN0007 "must be built"; yarn's actual failure
report (YN0009 + the `build.log` path) never appears, though later
shell output (disk marker, command-end trailer) does — the stream
dropped the tail. The N69 harvest keys on seeing the `build.log`
path in output, so it never fired, and all three repairs ran blind
with empty hints. Compounding: the failure summary is the full raw
PTY transcript, head-first, ANSI intact — every surface shows
`stty -echo` preamble garbage instead of the tail.

**ghostfolio (offline lifecycle, lingering hang).** Attempts 1 and
3 show `prisma generate` succeeding in ~200ms — then the command
hangs to the 20-minute hard deadline (exit 124), consistent with a
post-generate phone-home child holding stdio open against the
sealed network. No inactivity timer exists on the lifecycle
execute path, so two hangs burned ~40 minutes. Attempt 2 was the
repair agent mangling the prisma invocation.

**midday (exploration, OOM).** `bun run dev` runs a Next.js/
Turbopack dev server over a ~30-package monorepo; walking routes
OOM-killed it under the 4096MiB ceiling (1 cgroup OOM kill). The
sandbox-capacity classification landed and is correctly terminal —
only an operator can add memory.

**outline, ghost (hollow data, budget starvation).** Both
classifications correct, and the evidence reached the repair
prompts (pageErrors/consoleErrors interpolate). Outline's content
routes crash with `Cannot read properties of undefined (reading
'node')` — fixture documents that do not match the ProseMirror
schema — and the failure was evolving (attempt 1 empty, attempt 2
the specific crash) exactly when the budget died, pre-spent on two
preflight repairs and two false fidelity vetoes. Ghost's admin
shell renders but every API call 400/500s server-side; three
preflight repairs plus two false vetoes consumed the entire global
budget of 5 before exploration ever got a repair round — the
data-path steering never reached an agent.

### The anti-overfit contract

Every item below follows five principles, adopted as standing
design constraints for validation gates: (1) **content decides,
path suggests** — a naming convention may nominate a candidate but
never carry a veto alone; (2) **parse, don't pattern-match** —
syntactic questions about code get an AST, not a regex window;
(3) **semantic verdicts require a judge with verifiable
evidence** — when a gate must decide meaning, an LLM adjudicates
and its verdict only stands if its quoted evidence literally
exists in the diff; (4) **evidence comes from the source of
truth** — files the tool itself wrote, not a PTY stream that can
drop chunks; (5) **precision failures must not be fatal** —
budgets reserve room for the terminal stage, and a wrong veto
costs a round, never the run.

### N92 (Critical, feature) — fidelity: content decides, AST detects, a judge confirms

The gate keeps its genuinely structural rules (entrypoint
redirection, workspace removal, `readUnpreservedRemovedLine`
deletion preservation, standalone replacement runtime — zero false
vetoes to date) and rebuilds the three failing families.

**a. Content over path for created files.** A created file may be
vetoed as replacement UI only on positive presentation evidence in
its own content: markup/JSX/styling per `addsProductPresentation`
(or presentation by file type — .css/.html/.svelte/.vue/images
are presentation by nature). The directory prior
(`app|components|pages|routes|screens|views`) and the seam
vocabulary may nominate candidates and shape messages, never veto
a content-negative file. This kills the directus/outline class for
any repo regardless of directory naming, and loses no recall:
replacement UI must render something, so it must contain markup.

**b. AST gate detection.** New pure module (e.g.
`src/server/agent-harness/repo-preparation/demo-gate-analysis.ts`)
replacing `readsDemoFlag`/`readDemoGateIdentifiers`/
`isConditionalUse`/`isBoundInFile`. Parse changed files with the
TypeScript compiler API (handles .js/.jsx/.ts/.tsx/.mjs/.cjs; for
.vue/.svelte extract `<script>` blocks first). A **gate name** is
any identifier or env/define property whose name contains
`MAKEADEMO_DEMO` case-insensitively — substring, not
delimiter-bound, because this is the one token the pipeline itself
owns and instructs agents to use; `VITE_`/`NEXT_PUBLIC_` prefixes
and `__…__` define-constants are then automatically gate names. A
**gate binding** is any const/let/var/function whose initializer
references a gate name (followed transitively through local
bindings). An added statement is **gated** when an AST ancestor
if/ternary/`&&`/`||`/early-return condition references a gate name
or binding. Unparseable or non-JS-family files fail open for gate
detection (no veto on "no gate found" without a parse) — the judge
in (c) still sees them. Exported with a docstring; direct unit
tests: prefixed env reads, define constants, multi-hop bindings,
ternary/guard-clause/if forms, unparseable input → undefined.

**c. Judged vetoes.** `validatePreparationFidelity` stays pure and
becomes the candidate generator. When it proposes ≥1 violation,
the caller in `default-harness-dependencies.ts` runs one
adjudication agent command in the preparation sandbox (existing
OpenCode machinery and provider secret; no new infra seam). Input:
the candidate violations, the flagged files' diff hunks (bounded
per file), created files' content (bounded), the manifest's
declared adaptations (`localDemoModeChanges`,
`mocksAndFixturesAdded`, `authBypassOrDemoIdentity`, `envUsed`),
and the fidelity rules. Output artifact
(`fidelity-adjudication.json`, schema-validated): per candidate
`confirm`/`overturn` + quoted evidence lines + a steering message.
Code verifies every `confirm`'s quotes literally appear in the
named file's diff; a confirm with unverifiable quotes downgrades
to overturn (a hallucinated veto cannot survive). Overturned
candidates are dropped; confirmed ones veto with the judge's
steering (repairs finally get told *what* to change instead of
"creates replacement product UI" pointed at a one-line boolean).
Guards: `patchSha256` compared before/after adjudication — a
changed diff discards the adjudication and keeps the candidate
verdict; an adjudication agent failure keeps the candidate verdict
and marks the report unadjudicated (the judge can only rescue from
false vetoes — its absence is exactly today's behavior, never
weaker). Cost lands only on the veto path. Adjudication outcomes
(per-candidate verdicts and whether quotes verified) are recorded
in the fidelity report artifact so future diagnoses can audit the
judge. Tests through the caller seam with a fake agent runner:
confirm-with-real-quotes → veto stands with judge steering;
confirm-with-fabricated-quotes → overturned; agent failure → veto
stands, unadjudicated marker; diff mutated during adjudication →
adjudication discarded. One integration-style test runs the real
artifact plumbing.

**d. Vocabulary demotion.** `isDemoSeamPath` and the term lists
survive only as candidate-classifiers (choosing which message a
candidate gets) — with (a) and (c) their gaps cost a judge call,
not a run. One addition, owned-convention not vocab-chasing: any
path segment containing `demo` (case-insensitive, substring)
counts as a demo seam, because the pipeline's own prompts tell
agents to build demo-gated adaptations under exactly such names.

**e. Regression fixtures from this run.** Directus-shaped (created
one-line gate file under `app/`), excalidraw-shaped (gated scene
seeding with `VITE_`-prefixed flag), outline-shaped (camelCase
`demoFixtures.ts`), ghost-shaped (external-service neutralization
with non-vocab wording) — all must pass candidate generation
without a veto or be overturned by the judge; plus a true-positive
fixture (created `.tsx` with JSX replacing an original import,
ungated) that must still veto.

### N93 (High, feature) — exploration repair reserve

One global budget across all stages means early-stage churn
starves the terminal stage; ghost reached exploration with zero
rounds left. At the `repairPreparationManifest` call site
(agent-harness.ts), failures whose `stage === "app-exploration"`
may consume up to 2 repair rounds beyond the global limit when the
budget was exhausted before exploration's first failure — hard cap
`repoPreparationRepairLimit + 2` total, fingerprint caps and the
N90 bonus unchanged (worst case 5+2+2 rounds, bounded). No
reservation for earlier stages: they already run first and their
classes are covered by fingerprint caps. Orchestration tests
through `runAgentHarnessPipeline`: budget spent to the limit
pre-exploration still yields 2 exploration repairs; the +2 cap
holds; a run that never reaches exploration is unchanged.

### N94 (High, bugfix) — retry transient Daytona artifact transfers

`writeTextFile`, `uploadFiles`, and the submitted-code artifact
transfer paths in
`daytona-sdk-preparation-workspace-provider.ts` wrap their body in
a shared bounded retry: 3 attempts, backoff (~1s/4s), retrying
only transport-transient failures (HTTP 5xx status codes,
ECONNRESET/ETIMEDOUT-class errors). The temp-path + `mv` promotion
design is already idempotent; each retry uses a fresh transferId.
Agent command execution is deliberately out of scope (not
idempotent). Provider tests with a fake sandbox: one 502 then
success → succeeds with one retry and a single promoted file;
persistent 502 → fails after 3 with the original message
preserved; non-transient error → no retry.

### N95 (High, bugfix) — lifecycle evidence from files, legible tails

Three parts, one principle: the report must carry causes, and must
survive a lossy stream. (1) **Tee to a file.** The
`withDiskMarkers` lifecycle/install wrapper also tees combined
output to a sandbox file (`/tmp/makeademo/lifecycle-<uuid>.log`,
preserving the command's exit code via PIPESTATUS); on failure the
harness reads the file's bounded tail — deterministic evidence
currency even when the PTY drops chunks (calcom's missing YN0009).
(2) **Harvest the manager's own logs.** On lifecycle/install
failure, harvest bounded tails of the package manager's standard
failure logs regardless of whether the stream referenced them:
newest `$TMPDIR/xfs-*/build.log` globs (yarn berry's documented
build-log location), newest `/root/.npm/_logs/*-debug-0.log`
(npm always writes one). This is manager-convention knowledge, not
repo-specific. (3) **Tail-biased, clean summaries.** The
`Network-closed lifecycle scripts failed…` summary (and install
failures generally) leads with an ANSI-stripped excerpt of the
*last* ~4KB up to and including the `[makeademo:command-end]`
trailer plus the disk-marker lines, never the raw head; a shared
`stripAnsi` is applied at excerpt construction so no surface shows
escape-sequence garbage again. Full raw output stays in the
stdout/stderr fields. Tests with a fake workspace: stream missing
the failure tail + file tail present → summary carries the file
tail; build.log/npm-log harvest fires without an output reference;
summary head is legible prose, no ESC bytes.

### N96 (Medium, feature) — lifecycle inactivity deadline + standard telemetry opt-outs

(1) `executeSubmittedWithDeadlineEvidence` gains an
inactivity deadline (default 300s, matching the agent-command
no-output policy): a lifecycle command producing no output for the
window is killed with a
`[makeademo:timeout] no output for …ms` marker distinguishing
hang-after-quiet from deadline-overrun — ghostfolio's class costs
5 minutes and reports itself instead of costing 20 and reporting
nothing. Builds that legitimately go quiet longer than 300s can
raise it per call. (2) The sealed-runtime environment declares the
ecosystem-standard telemetry opt-outs (`DO_NOT_TRACK=1`,
`CHECKPOINT_DISABLE=1`, `NEXT_TELEMETRY_DISABLED=1`) so
post-success phone-home children never hold stdio open against
the sealed network in the first place. These are industry
conventions honored across tools, not per-repo patches. Tests: a
fake command that emits then stalls → killed at the inactivity
window with the marker; the env rider carries the opt-outs.

### N97 (Medium, infra) — submitted-code sandbox memory + memory marker

Rebuild the submitted-code snapshot at 8GB memory (CPU 2 and disk
10 unchanged): midday's dev-server class needs headroom no repo
change can provide, and quota math still clears the 11-way matrix.
Alongside the disk markers, `withDiskMarkers` also emits a
`[makeademo:mem]` line reading `memory.peak` from the cgroup after
lifecycle and start commands, so the next capacity diagnosis reads
peaks from the transcript instead of inferring them. Rollout via
the existing rotation: `bunx daytona snapshot create … --memory
8`, `.env` repoint, `bun run verify:daytona-image`.

### Rejected as non-general

Expanding the seam vocabulary token-by-token (the treadmill this
batch retires); demanding envUsed spell every prefixed variant of
the gate flag (the code owns the semantic: substring on our one
reserved token); a full-LLM fidelity judge on every validation
attempt (cost on the happy path; heuristics stay as free candidate
generators); behavioral fidelity verification via exploration
(replacement UI renders fine — only diff-level judgment can tell
an adaptation from a substitute); `CI=1` as a telemetry opt-out
(changes real build behavior in CRA-class tooling); banning dev
servers for monorepos (production builds can OOM too and cost
minutes; capacity is the honest fix); chasing the Daytona PTY
chunk-loss bug upstream (file-based evidence makes the stream
non-load-bearing); retrying agent commands (not idempotent).

### Recommended order

N94 → N95 → N96 (small, independent, stop losing runs and
evidence to infrastructure) → N92 (the batch's core, in order
a→b→d→c→e so the pure logic lands before the judge) → N93 →
N97 rollout last (snapshot rebuild + verify). TDD per item with
the failing test verified red first; full gauntlet per commit.
Eleventh matrix is the acceptance gate: directus/excalidraw/
outline-class preparations must survive fidelity (or die only on
judge-confirmed evidence), calcom's failure must name the actual
failing build with a legible tail, ghostfolio must fail fast with
the inactivity marker or pass outright, homer/twenty must survive
a 502 blip, midday must explore under 8GB, and ghost/outline must
spend ≥2 repair rounds on their real data bugs.

### Landed (2026-08-09, same day)

`2b1a96c` N94: `writeTextFile`, `uploadFiles`, and the
submitted-code artifact transfer share one bounded retry (3
attempts, ~1s/4s backoff) that fires only on transport-transient
failures — HTTP 5xx read from `statusCode`/`status`/
`response.status` or a `status code 5xx` message, plus the
ECONNRESET/ETIMEDOUT class. Every `writeTextFile` attempt uses a
fresh remote temp path and all attempted temp paths are cleaned;
non-transient errors and agent commands never retry, and the
original error message survives exhaustion. `f51b78f` N95:
`withDiskMarkers` tees each heavy command's combined output to
`/tmp/makeademo/<label>-<uuid>.log` (exit code preserved through
PIPESTATUS); failed lifecycle/install/build summaries lead with an
ANSI-stripped, tail-biased ~4KB excerpt read back from that file,
ending at the `[makeademo:command-end] exit=N` trailer, and the
manager's own logs (newest `$TMPDIR/xfs-*/build.log` globs, newest
`/root/.npm/_logs/*-debug-0.log`) are harvested whether or not the
stream referenced them. Shared `shared/text/strip-ansi.ts` strips
escapes at every excerpt seam. `22ac201` N96:
`executeSubmittedWithDeadlineEvidence` now defaults a 300s
inactivity deadline — a quiet lifecycle command is killed with
`[makeademo:timeout] no output for …ms` instead of burning the
20-minute hard deadline — and the sealed runtime env declares
`DO_NOT_TRACK=1`, `CHECKPOINT_DISABLE=1`,
`NEXT_TELEMETRY_DISABLED=1` so phone-home children never hold
stdio open against the sealed network.

N92 in five commits. `9c84d68` a: a created file can be vetoed as
replacement UI only on positive presentation evidence in its own
content — presentation-by-file-type (.css/.html/.svelte/.vue/
images; deliberately not .jsx/.tsx) or `addsProductPresentation`
markup in its diff; the directory prior only nominates. `7990257`
b: new pure `repo-preparation/demo-gate-analysis.ts` parses
changed files with the TypeScript compiler API — a gate name is
any identifier/env-property/define-constant containing
`makeademo_demo` (substring, case-insensitive; `VITE_`/
`NEXT_PUBLIC_`/`__…__` variants come free), gate bindings follow
initializers transitively, gatedness climbs AST ancestors
(if/ternary/&&/||/guard clauses), `.vue`/`.svelte` script blocks
are extracted first, and unparseable or non-JS input fails open.
A textual env-accessor-shaped fallback keeps comment mentions
validating configured flags while bare string literals do not
(typescript moved to runtime dependencies). `7bce9a0` d: the seam
vocabulary survives only as a candidate classifier, plus one owned
convention — any path segment containing `demo` is a demo seam.
`c643ad4` c: `validatePreparationFidelity` is now a pure candidate
generator; when candidates exist the harness runs one adjudication
agent in the preparation sandbox (stage
`preparation-fidelity-adjudication`, artifact
`fidelity-adjudication.json`, fresh session, 10-minute timeout).
A confirm verdict must quote verbatim lines that mechanically
verify against the named file's diff section — hallucinated quotes
downgrade to `overturned-unverifiable` and drop the veto; overturn
drops it with the judge's steering recorded; judge failure or a
`patchSha256` change during adjudication keeps every candidate and
records `unadjudicated`/`discarded-diff-changed`. Outcomes land in
the fidelity report for future judge audits, and confirmed vetoes
finally carry steering that says what to change. `1e8e0d9` e:
regression fixtures — the ghost-shaped gated gravatar
neutralization generates its candidate and is cleared by an
overturn verdict, and the plan-shaped true positive (ungated
created .tsx whose export takes over an original import) still
vetoes even under a demo-named path.

`0111de5` N93: app-exploration failures may spend up to 2 repair
rounds beyond the global limit (`explorationRepairReserveRounds`,
stacking with the N90 bonus; fingerprint caps unchanged; earlier
stages get no reservation). The three existing budget tests were
re-pinned to the widened arithmetic. `50f7ecb` N97 code half:
`withDiskMarkers` also emits `[makeademo:mem] <label> peak-bytes`
from the cgroup's `memory.peak` (v2, with the v1
`memory.max_usage_in_bytes` fallback) after each wrapped command.
`02dc0d7` regenerated dependency graphs for the new modules.

Verification: TDD per item, failing test verified red first; lint,
typecheck, test, knip green per commit. Tests 935→976 (+41). The
remotion-video-renderer delayRender smoke test failed on every
full run this window; a stash-and-run control on clean HEAD
reproduced it on this memory-starved host (~34MB free RAM), so it
is environment-bound, not a regression — tracked as its own
hardening task.

**N97 operational rollout executed (2026-08-09).**
`makeademo-submitted-code-browser-ca-20260809-mem8` built via
`daytona snapshot create` (CPU 2, memory 8GB, disk 10GB) from the
unchanged Dockerfile; `.env` repointed;
`bun run verify:daytona-image` passed (one retry after a transient
sandbox DNS failure on the first attempt). The eleventh matrix
remains the acceptance gate and awaits an explicit go-ahead.

## Addendum (2026-08-09, eleventh 11-repo matrix — the silence-is-death class; the in-code fixture contract; N98–N101)

Run `matrix-2026-08-09T16-11-15-533Z` / report
`matrix-report-2026-08-09T17-35-26-992Z.json`. Three passed:
homer (23min), conduit (33min), excalidraw (49min — its
preparation survived the rebuilt fidelity gate end-to-end,
N92's acceptance expectation). Eight failed. Scorecard against
the N92–N97 gates: no run died at fidelity (the judge lane ran
repeatedly across five entries without killing anything);
calcom's failure names its actual broken start target; midday
explored under 8GB and failed at the data gate for the right
reason; N97's memory marker was immediately load-bearing
(twenty's build peaked at exactly 8589934592 bytes — the
ceiling; ghostfolio 3.25GB; cyberchef 1.35GB). Two gates
failed instructively: ghost's repair rounds were spent against
a phantom "install failure" manufactured by a false inactivity
kill, and outline spent its rounds on its real data bug only
for the run to die on an unclassified exploration timeout. The
frontier this cycle: the harness reads silence as death — 43
five-minute agent inactivity kills across all 11 entries
(including every pass) plus ghost's sandbox-side false kill —
and two Daytona seams still convert one transient into a dead
run. Beneath the infrastructure noise, the recurring
prep-quality failure is data that never reaches the UI.

### Diagnoses

**The silence-is-death class (≈3.5h wall-clock; ghost
killed).** Agent commands were killed 43 times by the 300s
no-output watchdog (midday and excalidraw 7 each; the three
passes 12 between them). Each kill is ~5 minutes of stall plus
a burned validation attempt before relaunch; agents running a
long silent tool call — a build, an install, a slow
adjudication read — exceed the window while working correctly.
Ghost is the terminal case, sandbox-side: the N96 lifecycle
inactivity deadline killed `pnpm rebuild -r` at exit 124
mid-run — the evidence tail proves everything prior was
healthy (sqlite3 compiled, re2 rebuilt "info ok") — because
pnpm buffers each package's script output until the package
finishes, so one long native compile emits nothing for
minutes. The verdict was then classified "install failure",
and all repair attempts chased that phantom until the global
budget of 5 died. The N95/N96 evidence chain itself worked:
the `[makeademo:timeout]` marker and legible tail are in the
attempt file.

**Daytona transients and timeouts outside N94's cover
(cyberchef killed; outline killed).** Cyberchef died after 71
minutes when the control-plane socket closed during a
submitted-code workspace reset — classified "not
agent-repairable", no retry, though N94 retries the same class
of failure one seam over. Outline first failed exploration for
the right reason (`Cannot read properties of undefined
(reading 'forEach')` on every content route — fixture shape
mismatch) and spent repair rounds on it per N93; then the
final exploration attempt hung for the full 420s protocol
deadline and `AgentHarnessCommandTimeoutError` escaped
unclassified as a raw pipeline kill — bypassing
exploration-failure classification and forfeiting the reserve
rounds that remained.

**midday (data surface stuck loading — a third cause the
classifier cannot name).** Exploration correctly failed the
transactions feature, but the aria evidence shows the true
state: the table mounted rows whose every cell is textless —
loading skeletons for a query that never resolves. The
classifier offers exactly two causes (query resolved empty;
virtualized zero-height body), so both repair rounds steered
at fixture shape and default filters while the actual defect
was the wiring between fixture and UI. Two same-fingerprint
attempts exhausted the lane.

**directus (served at the wrong base; API dead).** The
screenshots show a login page; `auth/refresh` 404s under
`/settings/…`; and the app's own relative links resolved
against the current page into concatenated 404 routes
(`/settings/admin/settings/data-model`,
`/content/tasks/admin/content/tasks`) that exploration then
tagged as the features' routes. The prepared serving
arrangement put the admin SPA at a base it does not expect
with no working API behind it; the chrome-only verdict was
correct and repair never addressed the arrangement.

**calcom, ghostfolio (start commands reference missing
outputs — legible, unfixed).** Calcom's managed app output
names it: `turbo … No package found with name '@calcom/
website' in workspace`. Ghostfolio's start ran without its
build product: `Cannot find module /workspace/repo/dist/apps/
api/main`. Both are agent-quality failures with clean
evidence; both exhausted their repeated-failure lanes.

**twenty (memory ceiling plus missing prerequisite).** The
build died on `EvalError: Cannot find module
'twenty-ui/dist/theme-constants.cjs'` — the workspace
prerequisite was never built, the exact shape N67 steers for,
but N67's matcher does not recognize the
`Cannot find module '<pkg>/dist/…'` form. The mem marker
recorded the build pinned at the 8GB cgroup ceiling, so even a
correct build order may not fit. Global budget exhausted after
5 attempts.

**Matrix report truncation.** `readFailureDetail` keeps a
failure's first line; for multiline lifecycle evidence that
line is mid-word tail garbage (`ite3 install: …`) while the
pipeline log holds the legible story. Diagnosis this run
required the JSONL every time.

### N98 (Critical, feature) — progress-aware liveness: silence plus idle CPU, not silence alone

One primitive retires the class: liveness = output OR CPU-time
advance. A small wrapper samples the wrapped command's
process-tree CPU jiffies from `/proc` and prints
`[makeademo:alive] cpu <n>` at most once a minute, only when
jiffies advanced since the last sample. The line feeds the
existing client-side inactivity watchdog unchanged: a silent
compile burns CPU → heartbeats flow → no kill; a process
wedged on a blocked syscall goes idle → heartbeats stop → the
5-minute kill fires exactly as designed. Wrap both seams: the
OpenCode agent invocation and the sealed
install/lifecycle/build commands. Two required details:
`isAgentLaunchFailure`'s only-PTY-bootstrap check and the
evidence excerpts must filter `[makeademo:alive]` lines (a
dead agent must not look alive; tails stay legible), and an
exit-124 verdict whose output carries the `[makeademo:timeout]`
marker must classify as an inactivity kill ("everything above
is healthy partial output"), never as "install failure" —
ghost's five wasted rounds are the cost of that mislabel.

### N99 (High, bugfix) — Daytona transient and timeout cover at the two uncovered seams

Extend N94's transient classifier (socket closed, ECONNRESET
class, HTTP 5xx) with the same bounded retry to the
submitted-code workspace reset and the remaining control-plane
calls it guards nothing of today. At the exploration seam,
catch `AgentHarnessCommandTimeoutError` from the protocol
command and convert it into a classified exploration failure
carrying whatever partial evidence exists ("the protocol did
not complete; the app likely wedged mid-navigation"), so it
routes into repo-preparation-repair with N93's reserve intact
instead of escaping as a raw unclassified pipeline kill.

### N100 (Critical, feature) — the in-code fixture contract: demo data lives in code, in the shape the function declares

The standing directive, stated plainly in the prep contract:
for each demoed feature, find the exact function the UI calls
for its data — server query function, API route handler, or
client fetch hook — and under the demo gate return an in-code
fixture literal satisfying that function's declared return
type, resolved immediately. Making the database optional is
explicitly forbidden: no transport left in the demo path, no
empty-on-missing fallback. The fixture is the data; nothing is
fetched. Four coordinated pieces give it teeth:

1. **Manifest declaration (checkable).** Each feature declares
its data seams — the file/function replaced and the fixture
module supplying the shape. The validator verifies
referentially that the declared files appear in the workspace
diff; no prose reconciliation.

2. **Exploration names the third cause.** The zero-row
classifier adds the state midday actually presented: rows
mounted whose cells contain no text — a stuck-loading
skeleton, detectable from the aria shape alone. Its steering
quotes the feature's declared data seam: "the fixture in
`<module>` never reaches `<function>` — return it in code from
that function; do not gate on database availability." A
correctly named cause changes the repair fingerprint, so the
lane earns fresh budget instead of dying on repetition.

3. **The fixture-shape probe (verifier tool, not a
generator).** After wiring a seam, the agent writes a probe —
`const _check: Awaited<ReturnType<typeof getTransactions>> =
fixtures;` — and a small helper runs the repo's own
`tsc --noEmit` on it, returning the diagnostics. Shape truth
moves from LLM guesswork to the submitted repo's compiler;
outline's `forEach` crash dies at authoring time instead of 40
minutes later at exploration. TypeScript repos only; the probe
is steered and its result recorded, never a hard veto — a
probe that cannot run must never kill a legitimate
preparation. The browser-evidence gate remains the truth for
every stack.

4. **The data-fixture playbook (skill rider).** The method as
a checklist in the prep and repair riders: locate the function
the UI calls; author the fixture as an in-code literal typed
by its return type; wire it under the demo gate to resolve
immediately; run the shape probe and record the result; then
check what no compiler can — fixture dates inside the default
visible range, status/enum values that survive default
filters, relations between fixture entities consistent. That
last step is the trap that likely kept midday's table empty
across ten runs.

### N101 (Medium, mixed) — legibility and steering follow-through

`readFailureDetail` in the matrix runner prefers a
`[makeademo:…]` marker or `exit=` line over a blind first line
for multiline failures. N67's prerequisite matcher learns the
`Cannot find module '<pkg>/dist/…'` shape (twenty). Exploration
adds wrong-base steering when followed in-app links 404
alongside auth-endpoint 404s (directus: "the app's base path
or API base does not match the prepared serving arrangement").
Twenty's memory policy: build steering first — bounded
`NODE_OPTIONS` old-space and sourcemaps off under demo prep —
and a 16GB snapshot only if steering fails, since doubling
memory halves matrix parallelism headroom under the Daytona
quota.

### Rejected as non-general

A type-driven fixture generator (demo data quality is product
quality and the agent already authors it better than a faker;
types cannot carry the value semantics — default filters, date
ranges, relations — that actually break runs; per-schema
adapters are a treadmill: the tool verifies, the agent
generates); blindly raising inactivity windows (slows true-hang
detection — the CPU signal distinguishes work from wedge);
hard-gating the shape probe (non-TS repos cannot run it, and a
probe that cannot run must never veto); a 16GB snapshot as the
first response to twenty (quota cost before cheaper steering is
tried); detecting skeleton rows by CSS class names (styling-
specific; the aria shape is the general signal); retrying agent
commands wholesale (unchanged: not idempotent).

### Recommended order

N98 → N99 (stop losing runs and budget to misread
infrastructure) → N100 (the batch's core: manifest seams,
classifier, probe helper, and playbook rider land together) →
N101. TDD per item with the failing test verified red first;
full gauntlet per commit. Twelfth matrix is the acceptance
gate: agent inactivity kills drop from 43 to near zero and no
run dies from a false one; a control-plane socket blip costs a
bounded retry, not a run; an exploration hang becomes a
classified failure that spends its reserve rounds; midday
either renders fixture rows with real text or fails naming the
stuck-loading cause with seam-level steering; ghost's rounds
target its actual lifecycle behavior instead of a phantom
install failure; twenty either builds under memory steering or
its verdict cites the marker's ceiling reading.

### Landed (2026-08-09, same day)

`1637dfe` N98 liveness: new `shared/shell/cpu-liveness.ts`
wraps a bash command with a background sampler that reads its
own process group's live utime+stime from /proc once a minute
and prints `[makeademo:alive] cpu <n>` only when the total
changed — silence with CPU progress stays alive, silence
without it still dies at the inactivity deadline. Wrapped at
both seams: the OpenCode run command and the
`withDiskMarkers` install/lifecycle/build bracket (heartbeats
feed the PTY watchdog but never enter the teed evidence file).
`hasOnlyPtyBootstrapOutput` treats alive lines as bootstrap so
a dead-at-launch agent cannot look alive, and
`legibleFailureExcerpt` filters them from evidence. Dead
children are deliberately excluded from the sum: counting
cutime would count the sampler's own short-lived awk/cat
children and neutralize the watchdog. `ff35e45` N98
classification: an exit-124 lifecycle kill now classifies as
`lifecycle timeout` — routed to preparation repair with full
repo latitude (never dependency-only edits), its summary leads
with the kill and states that everything above the marker
completed, and the N58 install-reuse list treats it as
at-install so the unfinished lifecycle always re-runs.

`b3232d5` N99 transports: `syncSubmittedCodeWorkspace` runs
under the N94 transient retry (the whole archive → download →
upload → extract chain is idempotent per attempt), and the
transient signature learns Bun's "socket connection was
closed" message. `a0c44c3` N99 exploration: a protocol
timeout with the app still running returns a classified
`render timeout` repairable failure instead of escaping as a
raw Daytona error; unreadable app status still preserves the
infrastructure timeout.

N100 in three commits. `6384a7e` seams: `PreparedDemoFeature`
gains optional `dataSeams` ({path, functionName,
fixtureModule, shapeProbe?}), parsed with repo-relative path
validation, described in the agent-facing contract (with an
invariant) and the template, and checked referentially by the
fidelity candidate generator — a declared fixture module
absent from the diff, or a seam file existing nowhere, is a
truthful-manifest candidate for the adjudication lane.
`431e3d5` gate: the browser harvest counts textless body rows
(`skeletonRows`), and the zero-row evidence names the third
cause the two-cause message could not — rows mounted with no
cell text mean the query never resolved — steering at the
feature's declared seam by name. `2e8914c` playbook:
`dataFixturePlaybookInstruction` (find the function the UI
calls; author the fixture literal typed by its return type;
return it immediately under the gate — never
database-optional, never empty-on-missing; declare dataSeams;
prove the shape with the repo's own tsc via a temporary probe
file and record shapeProbe; then check dates, default filters,
and relations no compiler can) interpolated into preparation,
contract repair, and — for the empty-app class only, per the
N65 prompt diet — runtime repair.

N101 in four commits. `97f0b67` matrix report rows bound a
runaway first line to 240 chars and append the message's last
`[makeademo:…]` marker line. `10b45c9` chrome-only failures
with same-origin 404s (page errors or failed-resource console
errors against the local origin) append wrong-base steering —
evidence-driven, hint-only. `1f07dd4` the N67
unbuilt-workspace matcher reads the teed build evidence file,
not just the lossy stream that dropped twenty's EvalError.
`ccf92ee` world rule (8): the ~8GB ceiling kills what crosses
it — bound old-space, disable sourcemaps, narrow the build
target. `458974a` regenerated dependency graphs.

Verification: TDD per item with each failing test verified red
first; lint, typecheck, test, knip green per commit. Tests
976→997 (+21; the remotion delayRender smoke test passed on
every full run this window). The twelfth matrix remains the
acceptance gate and awaits an explicit go-ahead.

## Addendum (2026-08-09, twelfth 11-repo matrix — the false-kill and wording-lottery classes; verification learns behavior; N102–N111)

Run `matrix-2026-08-09T23-40-32-270Z` / report
`matrix-report-2026-08-10T00-41-35-405Z.json`. Two passed:
homer (21min), cyberchef (58min — its first pass since the
reset-socket death; the one N94/N99-covered seam held under
load). Nine failed. Scorecard against the N98–N101 gates:
agent inactivity kills fell 43 → 11 but not to near zero, and
ghostfolio died from three false ones of a shape N98 never
suspected; the control-plane gate failed at two new seams
(midday 409, outline 502); the exploration-hang gate went
untested; midday never reached its data gate — its
preparation passed fidelity with an empty workspace diff;
ghost's gate passed (preparation cleared in ~20min and the
frontier moved to exploration); twenty's memory steering
landed and worked, exposing the disk wall behind the memory
wall. N101's report-row marker rider worked — calcom,
directus, and ghostfolio rows carried their `[makeademo:…]`
markers. The frontier this cycle: the harness's own transport
and envelope still manufacture failures (a stolen PTY
sentinel, an unclassified 409, a silent 27-minute
provisioning gap), and beneath them feature verification is a
wording lottery — grounded when the agent's naming happens to
collide with on-screen text, failed (or vacuously passed)
when it does not.

### Diagnoses

**The false-kill class (ghostfolio killed; the sentinel was
stolen, not the CPU stalled).** All three preflight attempts
died identically: lifecycle `npm rebuild && npm run
--if-present postinstall`, exit 124, "5 minutes of silence
with no CPU progress." The teed evidence proves the command
finished ~50s in: npm's debug log records `17 verbose exit 0`
/ `18 info ok`, the `[makeademo:disk] lifecycle after` and
`[makeademo:mem]` markers printed (they print only after the
wrapped command completes), and the last real bytes are a
fresh interactive `root@…:/workspace#` prompt. Mechanism:
`executeStreamingInSandbox` pre-queues the exit-sentinel and
`exit` lines into the tty input buffer for the command's
whole duration, nothing detaches the command's stdin, and a
stdin-draining child (prisma's ora spinner, `discardStdin:
true`; a prior run's tail carries a live spinner frame `⠙`)
ate the queued lines — bash printed its prompt and waited
forever for input that no longer exists. The pre-N98 run has
a byte-identical tail classified "install failure": N98
renamed this failure; it did not change it. Both repair
rounds chased repo phantoms (a husky shim for a hook the
lifecycle never invokes) and round 2 silently dropped
`buildCommandUsed` — re-arming the previous run's missing
`dist/apps/api/main` defect behind the transport bug. Two
aggravations: the kill message's "with no CPU progress" is
unearned (`timeoutSummary` never consults alive lines), and
`[makeademo:alive]` appears zero times across the entire
11-entry batch — with a concrete suspect: the sampler
captures its pgid via command substitution, which under an
interactive job-controlled bash inherits the login shell's
process group while the foreground pipeline gets its own, and
`cpu-liveness.test.ts` asserts only on the generated string,
never executing it. N98's sampler may never have fired.

**Daytona envelope gaps (midday killed; outline killed).**
Midday died at `pipeline.failed: "An operation is already in
progress for this resource"` — a 409 thrown in the 79-second
preflight window between the fidelity report and death (the
sync → network-toggle sequence; no agent command in flight).
`setSandboxNetworkAccess` carries no retry; the conflict
class is handled only at sandbox delete, and even there the
message regex (`state change in progress|state is changing`)
does not match this text. The raw 409 was then laundered into
a maker-facing fallback prompt: "Resolve these observed
blockers: 1. An operation is already in progress for this
resource." Outline died at `"Request failed with status code
502"` after a 27-minute completely silent gap at the
provisioning/repo-upload seam — `/workspace/repo` never came
to exist (`cd: /workspace/repo: No such file or directory`
from the failure-path diff capture). Three compounding gaps:
`createSandboxWithConnectionRetry` retries only
ECONNREFUSED/RESET/TIMEDOUT (a 502 during create is instantly
fatal); the transfer ladder is `[1_000, 4_000]` — three
attempts over five seconds, blip-scale against a bad window;
and no control-plane call emits a pipeline-log event, so the
27 minutes are unattributable dead air and the terminal error
names no seam. Both deaths sit inside the batch's own
thundering herd: 22 sandbox creates plus 11 archive uploads
launched in the same millisecond.

**The agent-seam kill residue (11 kills; ~66 minutes).** Six
of eleven entries lost their first `repo-preparation` command
to the 300s watchdog (midday mid-file-write — the partial
stdout ends inside a TSX table cell); homer ate three and
still passed. The mechanism is structural: an OpenCode
process blocked on a long model-stream wait burns no local
CPU and prints nothing, so the N98 jiffies heartbeat is blind
to remote work by construction. Each kill costs ~6 minutes
plus a repair-resume round.

**The wording lottery (conduit and excalidraw regressed on
luck, not preparation).** Grounding is a lexical bridge:
observed = an exercised interaction OR an assert sharing ≥1
semantic token (lowercase, ≥4 chars, stopword-filtered,
5-char-truncated) with the feature's wording. Conduit's
`/#/profile/ada-lovelace` rendered exactly the feature's
evidence ("My Articles", "Favorited Articles") but the
`route.headings.length === 0` gate disables all text asserts
on any route with headings, and the two headings present are
article titles sharing zero tokens with `view-author-articles`.
Its Follow/Favorite clicks were exercised and then discarded:
the click renames the control (`Follow ada-lovelace ( 42 )` →
`Unfollow … ( 43 )` in the aria — the state demonstrably
advanced) so the exact-name re-proof found nothing and
`interactions: []` shipped. Both prior conduit passes were
lexical accidents (a feature named after an on-screen
headline; a `condu` token collision). Excalidraw put all
three features on `/`; winner-take-all tagging gave the one
shared heading ("Canvas actions") to `theme-and-image-export`
2–1, starving the requested undo/redo feature; "Undo"/"Redo"
exist only as aria-labels on icon buttons past the 16-button
harvest cap; and Undo was `[disabled]` anyway — the
manifest's "Undo is enabled immediately" claim is contradicted
by the harvested aria, and fidelity accepted `shapeProbe:
"not-run"` behind it. Its prior pass proved nothing about
undo/redo either: the ≤1-feature-per-route short-circuit
grounded it on a route whose Undo was also disabled. Steering
compounded both lanes: "Server-side runtime errors were
observed" fires on any non-empty stderr (npm warnings;
ESLint's literal `Found 0 errors`), and conduit's
default-demo branch told repair to "reselect entryPaths onto"
a route list already containing the failing route — the
wording-alignment message is gated to maker-requested
features.

**ghost (past preparation at last; three stacked faults;
verification called them wording).** Preparation cleared in
~20 minutes and exploration ran six attempts — the N98-cycle
acceptance expectation met. The faults, in series: the Ember
admin client was never built (the install filter excluded it
and the harness itself steered the agent away —
`apps/ember-admin/app/router.js belongs to non-selected
browser application` — while its build output is the selected
app's `adminAssets`; every `/ghost/` route 400d on the missing
template); a fixture used `uuid: 'demo-post-uuid'` (422 →
crash); the injected demo-session middleware required
`'../../../services/auth'` — one level too deep — turning
every admin route into a raw stack-trace 500. Preflight had
gone green the whole time because the agent patched the
maintenance page `503 → isMakeADemoDemo ? 200 : 503` and the
probe checks status only — a reward-hack shape, not an app
fix. The harvester read the stack-trace pages as `headings:
[], text: []` (raw `<pre>` bodies match no `main p`/heading
selector), the not-found probe rendered the same broken page
as `/` so error suppression disabled itself, and the
classifier's headline told six repair rounds to "align the
featureInventory wording" with "We'll be right back." The run
died on the attempt that finally surfaced the decisive
`Cannot find module` stderr, and the cross-run fallback
prompt renders only `logsSummary` — the hints and stderr
excerpts never reach the next session.

**calcom, directus (lanes killed while converging).**
Calcom: attempts 1–2 repeated the known `'@calcom/website'`
missing-workspace failure — repair 1 was a no-op
(`changedPaths: []`) accepted as a success and charged a
budget slot — and attempt 3 failed on a new cause,
`NEXTAUTH_SECRET` unset, which `repo-profile.json`'s
`requiredEnvHints` had predicted and nothing surfaced. The
run-planner had chosen `apps/web` + `yarn run dev`; the
preparation agent escalated to root `dev:all` and dragged the
missing workspace in. Directus: attempts 1–2 failed on
`Failed to resolve entry for package "@directus/extensions"`
— the N67 matcher's regex misses Vite's phrasing though the
function's own comment names this exact directus case;
repair 2 fixed it (a demo-gated predev build) and the server
came up; attempt 3 was the wrong-base failure (SPA served at
`/admin`, probe at `/`, proxy to an API that was never
planned — `localServices: []` against a manifest assumption
that requires one); repair 3 made the right multi-file fix
and left a stray closing brace (`vite.config.js:93:6`), and
the parse error's fingerprint collapsed back onto the generic
first line — `curl: (7) Failed to connect…` — so the
repeated-failure limiter killed the lane on its first
genuinely novel, trivially fixable cause. The N101 wrong-base
steering was structurally unreachable: it lives in the
exploration stage (directus died in preflight) and its
trigger requires a 404 (the proxy emitted 502). Recorded
repair candidates also diverge from the executed manifest on
exactly `appDir`/`startCommandUsed`, making the attempt
artifacts misleading for diagnosis.

**twenty (the disk wall behind the memory wall).** The
N101/N67 steering landed in the accepted diff (nx
prerequisite build, `--max-old-space-size=6144`,
`VITE_BUILD_SOURCEMAP=false`) and the build stopped dying at
the ceiling — so the run paid four preflight attempts and ≥4
yarn passes into a 10GiB overlay (the org per-sandbox
maximum; `/tmp` shares the filesystem, so yarn's `xfs-*` zip
staging competes with the repo). Three copies of the
dependency tree coexisted: the 3.14GiB global cache, the
unpacked `node_modules`, and the stale `node_modules` the
workspace reset deliberately preserves. The only cache prune
runs on the success path, so failing attempts got no
headroom; attempt 4 re-fetched everything from a pruned cache
and died ENOSPC in fetch/zip-convert. At repair round 1 the
agent found the correct halving fix — `nodeLinker: pnp` — and
the fidelity `mutatesManagerIdentity` rule vetoed it. The
`[makeademo:disk]` markers recorded the whole arc and reached
no repair hint; the `before` marker never survives the
tail-biased excerpt.

**midday's manifest passed fidelity empty.** The accepted
preparation carries an empty workspace diff (the patch hashes
to the empty string), `localDemoModeChanges: []`,
`mocksAndFixturesAdded: []`, `dataSeams: []`, two features
(the gate later needs three), and `authStrategy: "none"` on
surfaces its own descriptions call authenticated. Fidelity
passed it — "Prepared runtime preserves the screened product
application," trivially true of a preparation that changed
nothing. The N100 referential check verifies declared seams
appear in the diff; it is silent when nothing is declared.
The 409 killed the run before preflight could expose the
sham.

### N102 (Critical, bugfix) — PTY transport truth: sealed stdin, one-line sentinel, completed-means-harness-fault

Four coordinated pieces. (1) Detach stdin on every sealed
install/lifecycle/build command — `{ command; } </dev/null` in
the `withDiskMarkers` bracket and the install path, and on
`withCpuLivenessHeartbeat`'s wrapped payload — so no child
spinner (ora/inquirer/prisma) can drain the tty. (2) Stop
pre-queueing the sentinel as separate tty lines: send one
line carrying the command and its own `printf` trailer, so no
unconsumed input sits in the buffer across a multi-minute
command. (3) Classify "completed but sentinel lost" as a
harness fault: when the teed evidence file ends with the
wrapper's own after-markers, the command demonstrably
finished — re-run it; never charge a repair round or the
fingerprint budget, and never blame the repo. The timeout
summary says "with no CPU progress" only when the alive-line
record actually supports it. (4) Give `cpu-liveness` a
Linux-only execution test — the wrapper around a ~2-minute
CPU burner under an interactive pty, asserting at least one
heartbeat — settling the pgid-capture suspicion; fix the
capture if it sums the wrong group. Ghostfolio's three false
kills and both wasted repair rounds are the cost basis; the
prior-run byte-identical tail says this class predates N98.

### N103 (Critical, bugfix + infra) — one Daytona envelope: classify, wait, retry, attribute

Every control-plane touch (create, delete, start/stop,
network update, fs transfer, command transport) goes through
one wrapper with one classifier. The classifier extends the
N94 transient signature with the conflict class — HTTP 409,
`errorCode: Conflict`, and the message shapes `state change
in progress` / `An operation is already in progress` —
handled as wait-and-poll for settlement (an in-progress
operation means wait for it, not blindly re-issue: a
retry-after-timeout can itself manufacture the 409). 5xx gets
an escalating jittered ladder sized for windows, not blips
(the current five-second total budget dies against any
multi-minute control-plane event). Every attempt emits a
seam-attributed pipeline-log event
(`daytona.<operation>.attempt/retrying/failed` with sandbox
id), so a 27-minute gap can never again be unattributable and
`pipeline.failed` names its seam. Infrastructure-classified
errors never become Preparation Fallback Prompts — they fail
as infrastructure with retry-the-job semantics; midday's
maker-facing 409 prompt is the forbidden shape. Rider: the
matrix runner staggers entry launches by 30–60s jitter to
stop self-inflicting a 22-create herd in one millisecond.

### N104 (High, feature, infra) — agent liveness from the model stream, not the CPU

The jiffies heartbeat cannot attest remote work: an OpenCode
process awaiting a long model generation is silent and idle
by design, and that state is the agent seam's normal working
condition, not a wedge. Feed the existing PTY watchdog from
OpenCode's own event stream instead — a minimal plugin (or
event-bus tap) that prints a `[makeademo:agent-alive]` marker
on any streamed session/message-part event, filtered from
evidence and bootstrap detection exactly like
`[makeademo:alive]`. A provider stream that ticks keeps the
command alive through silent tool-argument generation; a
session that has genuinely stopped emitting events still dies
at the deadline. Fallback only if the event tap proves
impractical: a longer inactivity window scoped to agent
commands alone, documented as a stopgap (the blanket-raise
rejection stands for lifecycle commands). Cost basis: 11
kills this run, six of them the first preparation command,
~66 minutes plus repair-resume rounds.

### N105 (Critical, feature, largest) — verification believes behavior: aria-first harvest, transition evidence, floors not gates

The grounding currency changes from "the agent's words
collided with the screen's words" to "typed evidence
observed on the accessibility tree." Seven coordinated
pieces. (1) Harvest from the accessibility tree as the
canonical source — roles plus accessible names, the same
name-space Playwright locators resolve — with the CSS
selector harvest demoted to fallback; this admits icon-button
labels (excalidraw's Undo/Redo), unstyled error bodies
(ghost's stack traces), and is framework-agnostic. (2) Admit
behavioral evidence: an exercised action whose observed delta
is recorded — control rename, counter change,
disabled→enabled, element appearing, row-count change,
URL/hash change, dialog open. The interaction re-proof falls
back to the stored locator evidence when the exact-name
lookup returns zero matches, and a self-renaming control is
recorded as a state transition, never discarded — a toggle
that renames itself is proof of behavior, wording-free and
stack-free. (3) Disabled-state evidence is admissible
(`Undo [disabled] → [enabled]` is the canonical
history/save/submit demo beat). (4) The
`route.headings.length === 0` gate is lifted: headings stay
the primary assert candidates, and the per-feature text
top-up runs unconditionally so a tagged feature can take one
verified text assert when no heading token-matches it. (5)
Winner-take-all tagging gains a per-feature floor: after
scoring, every route-tagged feature with a non-zero score
keeps at least one assert; ties multi-tag instead of
zero-sum. (6) Control harvesting stays bounded but becomes
feature-aware: within the existing budget, controls whose
accessible names token-match any tagged feature are always
included, then positional fill — no magic-number cap raise.
(7) Error-state detection runs before wording logic and is
probe-independent: a 4xx/5xx document response routes to
error-state evidence unconditionally with a "runtime fault,
not a wording fault" summary, and a route harvesting zero
headings and zero text with a non-empty body captures a
bounded `innerText` sample so a bare stack trace carries its
own diagnosis. Stability rider: harvest waits for
network-quiet plus a short DOM-stable window, and a feature
about to be declared unobserved earns one fresh-navigation
re-harvest of its routes first — flaky misses become
confirmed misses for seconds, not rounds.

### N106 (High, feature) — the verdict ledger: verification explains itself

The gate emits a structured per-feature verdict, not prose:
`grounded-by: interaction | state-transition | assert |
declared-proof` with evidence references, or `failed-because:
error-state-route | no-assert-candidates | token-mismatch
(best score, best string) | route-shared-with-winners |
auth-wall | skeleton-rows | app-unreachable`, one enum per
feature per attempt, persisted in the validation report.
Steering is derived from the enum: `route-shared` says "give
this feature an entry route no other feature claims";
`error-state-route` says the runtime is broken and wording
cannot help; the wording-alignment message extends to
default-demo features (conduit's branch currently falls to a
generic reselect message pointing at a list containing the
failing route). The false hint dies: "Server-side runtime
errors were observed" only when stderr carries an error-class
line after filtering warning-only and `Found 0 errors`-shape
content. The cross-run fallback prompt carries the ledger,
the suggested hints, and the decisive stderr excerpt — the
current prompt renders `logsSummary` alone and hands the next
session the misleading half. The ledger is also the output
format of N108's probe and the input to N109's fingerprints —
it lands first so every later change in this batch is
measurable per feature across matrix runs instead of by
re-mining attempt JSONs.

### N107 (High, feature) — declared proof obligations: the feature says how to prove it

The N100 move applied to observability. Each prepared feature
may declare `expectedProof` — a typed expected outcome in
Action Catalog vocabulary (`expectVisibleText`,
`expectStateTransition {locator, from, to}`,
`expectElementAppears`) — and for maker-requested features
the declaration is required. The validator checks
referentially: each feature's entry route is claimed by no
other feature; obligations are present where required; a
declared locator uses the same accessible-name space the
harvest produces. The gate executes declared proofs as
first-class grounding (they subsume the wording bridge where
present; the token match remains the default for undeclared
read-only features), which closes the vacuous-pass hole from
both prior excalidraw runs — "undo/redo" must pass its
declared transition, not ride a nearby heading. The same
typed outcome is the currency Browser Scenes already require,
so Script Generation and Capture Path Validation consume the
proofs verification already executed — one assertion language
across three stages instead of three heuristics.

### N108 (High, feature) — the feature-verification skill and its probe

The user-facing task of this batch: teach the preparation
agent the rules it currently learns by dying. Two pieces,
tool first. (1) `verify-features`, a harness tool exposed in
the workspace (the Runtime Network Lockdown iterative-check
precedent): it runs the gate's own harvest and grounding code
against the agent's running prepared app and returns the N106
ledger. Because it executes the same code as the gate,
iterating against it is legitimate convergence — failures die
at authoring time, minutes in, instead of 40 minutes later at
exploration. (2) The `feature-verification` skill, pinned via
`skills-lock.json` and restored into the OpenCode sandbox
like the existing repo skills: a thin authoring playbook in
the N100 rider style — name features in on-screen vocabulary;
give each feature an entry route no other feature claims;
declare `expectedProof` per feature; design for behavioral
evidence (seed state so a demonstrable transition exists on
camera: history pre-populated so Undo starts enabled, a
followable author whose control will rename, a row to add to
a visibly non-empty table); then run `verify-features`, read
the ledger, fix, resubmit. Two stated guards: drift — the
skill is a client of the contract, thin on rules, sourcing
any stated rule from the gate's own constants, letting the
probe's ledger do the teaching; gaming — the authoritative
gate still reruns from fresh deterministic state in the
sealed sandbox, and content legitimacy stays with the
fidelity lane (error-state quarantine, the N92 judge), so the
probe narrows the loop without weakening the boundary.
Loading the skill on demand respects the N65 prompt diet
better than growing the preparation prompt again.

### N109 (High, bugfix) — repair lanes converge: cause fingerprints, no-op rejection, patch checks, wider prerequisite evidence

Five pieces. (1) `preparationFailureFingerprint` hashes the
decisive cause line extracted from the managed output (the
last error-class line: `Error:` / `x No package found` /
`[PARSE_ERROR]` / ENOSPC family), falling back to today's
normalized summary line when none exists — calcom's new
`NEXTAUTH_SECRET` cause and directus's novel parse error must
not collapse onto the invariant `curl: (7)` symptom that
killed both lanes mid-convergence. (2) A repair whose
workspace diff has `changedPaths.length === 0` is a
non-attempt: it charges no budget and fails fast with
"repair produced no change" (two of five repairs across
calcom/directus changed zero bytes and were accepted). (3)
After a repair patch lands, changed files get a cheap parse
check with the repo's own loader where one exists (`node
--check`, the config loader) — steering on failure, routed
back to the same session as an in-session correction, never a
hard veto where no parser applies (the N100 probe
philosophy); directus's stray brace must not cost a preflight
cycle again. (4) The N67 prerequisite matcher learns the
`Failed to resolve entry for package "<pkg>"` shape
cross-checked against `workspacePackages`, and the closure
evidence category widens from missing-module to
missing-asset: when the selected app's runtime error names a
file under a path a sibling workspace's build produces
(ghost's `adminAssets` template), that sibling enters the
build closure — the same sanctioned evidence family, one
notch wider, no app-shape special case. (5)
`requiredEnvHints` surfaces at preflight: a hinted variable
absent from `envUsed` is stated before the app starts —
calcom's attempt-3 failure was predictable from inputs the
harness already held.

### N110 (High, feature) — disk headroom is managed, not hoped for

Six pieces, all inside the fixed 10GiB org maximum. (1) The
package-manager cache prune runs before every install, not
only after a successful one — the attempts that need headroom
are the failing ones. (2) When an install is not reusing a
prior attempt's tree, the preserved `node_modules` is dead
weight and is dropped first. (3) Package-manager staging
moves off `/tmp`'s shared overlay onto the cache volume
(TMPDIR / the manager's own staging setting) so fetch churn
cannot race the repo for the same blocks. (4) An ENOSPC
classifier joins the failure readers, and the
`[makeademo:disk]` markers reach `suggestedRepairHints` on
install and build failures — this run they reached nothing
across five rounds; the `before` marker must survive the
tail-biased excerpt (filter markers explicitly, not
positionally). (5) World rule (9), mirroring the memory rule:
~10GB holds the repo, the cache, and `node_modules` at once;
prune dev-only weight rather than adding it. (6) For Yarn
Berry repos that ENOSPC at install, the harness itself may
apply the storage-halving linker fallback under the demo gate
— harness-owned, so `mutatesManagerIdentity` fidelity stays
intact; the agent still may not mutate manager identity.
Raising disk stays rejected: 10GiB is the measured org
ceiling, and doubling per-sandbox resources would halve
matrix parallelism for a repo that doubles its footprint on
the next reinstall.

### N111 (Medium, feature) — fidelity rejects vacuity and status games

Four adjudication candidates, all evidence-shaped. (1) An
accepted preparation whose workspace diff is empty while its
manifest claims demoable features with empty
`dataSeams`/`mocksAndFixturesAdded` is a truthful-manifest
candidate — midday's sham must reach the judge, not pass
trivially. (2) A `shapeProbe: "not-run"` cannot back a
feature whose manifest claims an observable state (excalidraw
claimed "Undo enabled immediately" against harvested
`[disabled]`). (3) Exploration observing an auth wall on a
route whose feature declares `authStrategy: "none"` is a
candidate — evidence-driven, no prose grepping. (4) An agent
edit that rewrites an HTTP status code on a harness-probed
path is a rejected-adaptation candidate (ghost's maintenance
page 503→200 is the shape: it converts a probe into a lie
while fixing nothing).

### Rejected as non-general

Preflight body fingerprinting (SPAs legitimately serve one
identical shell for every route; the general forms are
N111's status-edit candidate and N105's document-status
error detection); raising the button-harvest cap by constant
(a magic number tuned to excalidraw — feature-aware selection
within the existing budget instead); an admin-app carve-out
for ghost (app-shape special case — the missing-asset closure
evidence in N109 is the general form); grepping descriptions
for "authenticated" (wording-dependent — the auth-wall
observation in N111 is the evidence-driven form); the LLM
judge as a primary grounder (confirm-only on near-misses at
most; the deterministic gate stays the truth for every
stack); pixel-delta evidence (deferred, corroborating-only if
ever: once N105 transitions and N107 declared proofs exist,
excalidraw's class grounds on DOM-visible outcomes — revisit
only if a canvas feature genuinely cannot declare one);
blanket inactivity-window raises (unchanged for lifecycle
commands; N104's scoped agent-seam window is a documented
stopgap behind the event tap); retrying agent commands
wholesale (unchanged: not idempotent).

### Recommended order

N102 → N103 → N104 (stop the harness manufacturing failures:
transport truth, envelope, agent liveness — mechanical,
independently testable, and every later measurement is noise
until they land) → N106 (the ledger: the shared output format
of gate and probe, the input to fingerprints, and the
instrument that makes the rest of the batch measurable) →
N105 (the evidence core) → N107 (proof obligations) → N108
(the probe and the skill teach the finished contract, so they
land after the contract exists) → N109 (economics; its
fingerprints consume N106's enums) → N110 → N111. TDD per
item with the failing test verified red first; full gauntlet
per commit. The thirteenth matrix is the acceptance gate:
zero exit-124 verdicts whose evidence tail carries the
wrapper's own completion markers, and ghostfolio reaches its
real build/start frontier; no run dies on an unretried
control-plane error, conflict and 5xx windows cost logged,
seam-attributed waits, and no infrastructure text appears in
any fallback prompt; total inactivity kills at or under
three with the agent seam near zero; conduit and excalidraw
ground on transition or aria evidence — or fail with
enum-named causes — and no lane sees a "server-side runtime
errors" hint without an error line; a 5xx document can never
be diagnosed as a wording problem; no budget slot is charged
to an empty-diff repair and no lane dies while its cause
line is changing; twenty completes two sequential installs
inside 10GiB or fails citing ENOSPC with disk hints present;
no fidelity pass on an empty-diff manifest claiming demoable
features; and preparation transcripts show `verify-features`
runs before submission with exploration attempt counts
falling.

### Landed (2026-08-10, wave 1: the instruments)

N102 in seven commits. `06595d1` seal: the CPU-liveness
bracket runs its wrapped command as `{ command; } </dev/null`
so a stdin-draining child (prisma's ora spinner, any
readline prompt) inherits /dev/null instead of the PTY's
queued input — the exit sentinel can no longer be stolen.
`8b1a93d` makes the sampler interval injectable for the
execution proof. `c37c902` transport: the provider ships
every streamed command as one `exec bash -s <<'nonce' ||
exit` heredoc payload — the interactive shell consumes all
input up front (an empty tty buffer defeats /dev/tty
openers), and the exec'd bash is non-interactive with job
control off, so the whole pipeline shares one process group
and the CPU sampler finally watches the command instead of
an idle shell (why `[makeademo:alive]` was silent
batch-wide). `5146ad6` recovery: the teed
`[makeademo:command-end] exit=N` beacon lets a lost sentinel
resolve to the recorded true exit code — a completed command
killed as exit-124 becomes its real verdict with zero budget
charged; a recovered 124 stays ambiguous (the command may
run `timeout` itself) and is not recovered over. `a6c2392`
honesty: "with no CPU progress" appears in a timeout summary
only when heartbeat lines are actually on the record.
`5dc8ae3` proof: a Linux-gated real-PTY execution test
(stdin/tty drains survive; a busy loop heartbeats at 1s
sampling), plus the bootstrap pattern widened for heredoc
continuation echo.

N103 in four commits. `e62a580` the forbidden shape:
`AgentHarnessControlPlaneError` joins the infrastructure
family, so a control-plane failure rethrows at the reset
seam instead of becoming a maker-facing preparation fallback
prompt (midday's 409). `3f1cdf9` the envelope:
`daytona-control-plane.ts` classifies every failure conflict
(409 / errorCode Conflict / the in-progress message shapes —
wait 5s and re-issue, up to 24 polls) | transient (5xx,
connection loss — jittered 2s→90s ladder sized for
control-plane windows, not blips) | fatal (everything else,
always rethrown raw so the policy/not-found/not-started
matchers keep firing), with seam-attributed
`daytona.<op>.attempt/retrying/failed` events to local sinks
only. `c80c2ea` the wiring: sandbox create/delete/start,
network updates, PTY creation, and all filesystem transfers
run through it (transfers keep their own
infrastructure wrapping via `wrapExhausted: false`; PTY
creation absorbs transients only, leaving conflicts raw for
the stale-id loop; command execution stays excluded by
design — re-issue could double side effects). The bespoke
per-seam retry helpers are deleted. `b4061b4` the rider:
matrix entries launch 30–60s apart (cumulative jitter,
opt-in, enabled by the CLI) so one batch stops being its own
control-plane herd.

N104 in two commits. `c1b906c` the plugin: every stage
config dir gets an auto-loaded OpenCode plugin that turns
model event-bus activity into throttled (25s)
`[makeademo:agent-alive]` beats on stderr; the PTY merges
them into the stream, so a thinking-but-terminal-silent
agent feeds the inactivity watchdog and a truly wedged
OpenCode still dies at the deadline. `0bfbe92` the filters:
beats join the CPU heartbeat in bootstrap-noise
classification (a beat-then-crash OpenCode stays a launch
failure, never an artifact-repair burn) and in
failure-evidence excerpts. `a6a0453` regenerates the
dependency graphs for the three new modules.

### Mini-matrix checkpoint (2026-08-10, ghostfolio + homer, wave-1 gate)

Homer: passed end-to-end in 13.5 minutes — final video, zero
warnings, zero kills, six stages without a repair round.

Ghostfolio: preparation now completes in 11.5 minutes where
the twelfth run died on false exit-124 kills — the app
builds, starts, and gets browsed. Nine routes harvested with
aria + screenshots (including /en/portfolio and
/en/portfolio/allocations, with "portfolio", "allocation",
and "performance" present in the aria text), yet exploration
still failed the run with "no browser evidence for requested
features" after seven runtime-repair rounds (36 minutes).
The frontier moved exactly to the wave-2 boundary: the
evidence exists and the verifier cannot ground it — N105's
aria-first crediting, N106's ledger, and N107's declared
proof obligations are the fix, not another harness pass.

Instrument readings: zero exit-124 verdicts anywhere in
either run (N102 holds); zero inactivity kills (N104
consistent — beats are filtered from durable logs by
design, so their proof is the absence of false kills); the
launch stagger held ghostfolio 37s behind homer (N103 rider
fired); no control-plane deaths. One wave-1 gap surfaced and
closed the same day: every `daytona.<operation>.*`
attribution event ran dark because the harness never carried
its logger into the provider — `7a78f7f` threads a
`controlPlaneLogger` through so envelope events land in
`pipeline-log.jsonl`. Wave 2 (N106 → N105 → N107 → N108) is
unblocked.

### Landed (2026-08-10, wave 2: verification learns behavior)

N106 in four commits. `d0296e2` schema: the FeatureVerdict
ledger parses on validation reports (one verdict per
feature, grounded-by or failed-because, evidence ids,
decisive detail). `e9265c0` the ledger becomes the
grounding computation itself: `readFeatureVerdicts` walks
auth-wall → grounded (transition > interaction > assert) →
app-unreachable → stuck-overlay → skeleton-rows →
route-shared-with-winners → token-mismatch →
error-state-route → no-assert-candidates, and the failure
message is derived per-feature from the verdicts instead of
recomputed prose; suppressed routes blank their content so
error evidence outranks wording. `c9c5002` the stderr
runtime-error hint fires only when an error-class line
survives the warning and zero-errors filters — watch-mode
toolchains narrate success on stderr. `dd566e3` the
preparation fallback prompt renders the ledger and hints
generically (`- id: failed (enum) — detail`), so every
later enum flows through without renderer edits.

N105 in seven commits. `b9960fe` control transitions
(self-renames, disabled→enabled) become exercised evidence
with stored-locator re-proof. `8b72856` the accessibility
tree is the canonical assert-candidate source on every
route — cross-route repetition, not nav position, marks
chrome, so single-shell products keep their product
content. `6147d7e` text asserts emit on every route, not
only heading-free ones. `61c9e43` the assert floor: a
route-tagged feature the winners out-scored keeps its
best-scoring assert instead of losing the wording lottery
(floors, not gates). `947ebf7` the control budget spends
its slots on feature-token-matching names first, so a dense
toolbar cannot crowd out the feature's own control.
`1e5e83a` error-state outranks wording: 4xx/5xx document
responses (401/403 exempt on auth-wall routes) and
error-shaped bare bodies suppress wording verdicts and
carry their own diagnosis; the stderr signal now matches
compound error-class names (TypeError) the way rendered
error bodies spell them. `eef83f2` the stability rider: a
bounded network-quiet wait per navigation plus one fresh
re-harvest for any feature route about to be reported thin,
so streaming-SSR content stops reading as absence.

N107 in four commits. `9fac748` schema: PreparedDemoFeature
gains a typed `expectedProof` (visible-text |
element-appears | state-transition) and the verdict
vocabulary gains declared-proof-failed. `05eeb14` the
manifest contract and template teach the declaration —
per-kind required fields, accessible-name-space invariants,
seeding guidance. `46783cb` preparation validates declared
proofs referentially with batched steering: template
values, selector-shaped names, disabled-start transitions,
and indistinguishable proofs each die at authoring time
with the fix in the message; requiredness is checked after
coverage so agents prepare the right features before
declaring proofs. `f06494d` exploration executes each
declared proof from a fresh navigation of the feature's
entry route and the ledger treats results as first-class:
a passed proof grounds the feature regardless of wording, a
failed proof fails it even when wording would ground, and
an absent result (deadline, unreachable route) is missing
evidence — the wording chain still applies.

Deviation from plan (N107): the drafted hard check "entry
route claimed by no other feature" is contract guidance
rather than a validation gate. Single-page tools would be
unpreparable — cyberchef's every feature enters "/" — so
the hard checks are proof requiredness for maker-requested
features, per-kind proof validity, and cross-feature proof
distinctness; route uniqueness stays advice in the contract
invariants.

N108 in three commits. `9381992` exploration gains a
feature-entries crawl scope: entry routes plus the base URL
only, no link or navigation discovery, everything else —
harvest, interactions, declared proofs, ledger — identical
to the gate. `c885cdc` validatePreparation runs that probe
against the still-running app after the runtime curl
passes: a feature the gate would fail now fails preparation
minutes in with the gate's own classification, ledger, and
steering; a crashed or hung explorer passes through as
inconclusive (weather, not evidence) so the probe can never
fail a preparation the gate has not judged, and probe
evidence persists under feature-probe-evidence/ so the
later gate run does not overwrite it. `a1ebb91` the
feature-verification playbook ships as a harness-written
workspace artifact generated from the gate's own exported
vocabulary (featureVerdictFailureCauses, expectedProofKinds
— a new cause cannot compile without its agent-facing
explanation), and every preparation prompt names its path.

Deviation from plan (N108): the drafted verify-features
workspace tool and skills-lock pinned skill assumed the
sandbox agent could run a CLI. It cannot — availableTools
stays ["read","write"] with bash denied (a security seam
the probe must not weaken), and skills are never restored
inside the Daytona sandbox. The adaptation keeps the plan's
intent through the harness: the probe runs harness-side in
the preparation loop (same gate code, so iterating against
it is legitimate convergence), and the playbook arrives as
a workspace artifact referenced by path from prompts (the
N65 pattern) instead of an installable skill.

`028819b` regenerates the dependency graphs for the wave-2
modules. Full suite at wave end: 1092 tests green, lint,
typecheck, and knip clean. Suggested gate before wave 3
(N109–N111): rerun the ghostfolio + homer mini-matrix —
ghostfolio's "evidence exists, verifier cannot ground it"
frontier is exactly what N105–N108 exist to move.

### Mini-matrix checkpoint (2026-08-10, ghostfolio + homer, wave-2 gate)

Both passed with final videos. Homer 9.2 minutes;
ghostfolio 20.7 minutes — the repo that failed the twelfth
run after seven fruitless repair rounds now ships a video.
Both pipeline logs are 100% info-level: zero warnings, zero
errors, zero exit-124 verdicts, zero inactivity kills, zero
Daytona retries, zero OOM lines, zero preparation
fallbacks. Exploration, capture, and composite all passed
on their first attempt in both runs.

Wave-2 machinery readings, all firing as designed:
ghostfolio's three features grounded via **declared-proof**
with proofs drawn from seeded data ("Vanguard Total Stock
Market ETF", "Add activity", "By ETF Provider") — the N107
path is the grounding path, wording lottery not involved.
The N108 probe reported "Feature probe grounded all 3
prepared feature(s) on their entry routes" inside
preparation-preflight on both repos, and no probe was ever
inconclusive. Homer's single error-level event is the N107
identical-proof rejection doing its job: the first manifest
declared indistinguishable proofs for two features, the
batched steering named both, one retry fixed it. The N106
listen-failure hint steered ghostfolio's two runtime
repairs to real causes: round 1 moved the client serve to
port 3000 after the cold Angular build outlived the
readiness budget; round 2 bound it to 0.0.0.0 after the
server sat on localhost while the probe curled 127.0.0.1
(refused for a full 3-minute window with the server
claiming readiness — the binding, not the boot, was the
wall).

Two findings for the backlog, neither gating:

1. **Listen-failure first attempts are the remaining tax**
(ghostfolio two rounds ≈ 8 minutes, homer one). Both
sub-causes are now legible: cold first builds outliving the
~3.3-minute readiness budget, and localhost/IPv6-only
binds refusing the 127.0.0.1 probe. Candidate (small):
preparation-prompt steering to bind dev servers explicitly
to 127.0.0.1/0.0.0.0, and/or probing localhost as a
fallback before classifying listen failure.

2. **The allocations scene ships empty charts (N112
candidate).** Ghostfolio's portfolio-allocations scene
shows gray placeholder donuts and a masked "Proportion of
Net Worth ***** %" through its final frame, while the
overview scene shows real seeded values ($14,240, +14.80%)
and the add-activity scene shows a real dialog. Every gate
passed: the declared proof was `visible-text "By ETF
Provider"` — a static section label that renders with zero
data — and chart canvases are invisible to the DOM
emptiness checks (skeleton-rows sees table rows; a gray
donut ring is just a canvas; the route even had aria text
"100.00 % Developed Markets", so it was not content-empty).
This is the predicted "passes every gate, video shows an
empty surface" class, now narrowed to canvas/chart data
surfaces grounded by static-label proofs. Sketch: a
proof-quality floor (reject visible-text proofs that
exactly match a section heading harvested on the same
route with no data siblings), or chart-placeholder
evidence (canvas-only cards with no numeric/legend text
join skeleton-rows), or a capture-time flag for scenes
whose route carried masked values so the run report sends
a human to the clip. Evidence:
`matrix-2026-08-10T21-05-49-340Z-ghostfolio/capture/scene-clips/portfolio-allocations.webm`.

Cosmetic, watch only: ghostfolio serves 500 for
/assets/ghost.svg and for /api/v1/logo/YAHOO/VTI (sealed
upstream logo proxy) on demo routes — neither visibly mars
the captured frames; /en/portfolio/x-ray and /en/fire
throw on unfixtured surfaces, but neither is a demo
feature route. Wave 3 (N109 → N110 → N111) is unblocked.

### Landed (2026-08-10, wave 3: repair converges, disk survives, fidelity reads evidence)

N109 in five commits. `69dff98` failure fingerprints hash
the decisive cause line instead of the whole symptom, so a
drifting curl exit code or a timestamped npm debug-log path
cannot make the same wall look new to the repeated-failure
limit. `683e6a6` a repair round that changes nothing in the
workspace is a rejected non-attempt — steered back with the
unchanged evidence, never a budget charge. `016a8f4`
repaired files get a soft parse probe (node --check class)
with one in-session correction pass, so a syntax-broken
repair dies at write time instead of one failed preflight
later. `c090b36` prerequisite evidence widens to
entry-resolution failures and sibling-asset shapes, so
"module not found" repairs see the neighboring files that
disprove a bad path guess. `9571538` a failed preflight
states the requiredEnvHints gap against the manifest's
actual envUsed, naming the variables the preparation never
set.

N110 in six commits. `24a92cf` the package-manager caches
(yarn berry, npm, pnpm, and the staging directory) prune
before every install, not only after lifecycle — headroom
is created where the footprint peaks, with df markers
bracketing the pruning. `9886bd4` preserved node_modules
trees carried across a workspace reset drop before install
when their in-tree manager state marker
(.package-lock.json, .modules.yaml, .yarn-integrity,
.yarn-state.yml) does not match the current manager — a
foreign tree is dead weight the resolver will rebuild
anyway; bun (no marker) conservatively never drops.
`d3410f1` package-manager staging moves off /tmp: TMPDIR
points at /root/.makeademo-staging for install and
lifecycle commands, the pre-install prune clears it, and
the build-log harvest follows the staging path. `217607c`
ENOSPC evidence reaches verdicts: a disk-exhaustion
classifier plus the [makeademo:disk]/[makeademo:mem]
markers feed install, build, and lifecycle failure reports,
and the repair hint names the 10GB budget with per-manager
workspace-scoped install commands. `eddfdd3` world rule 9
tells the agent the same thing up front: the disk is a hard
ceiling shared with /tmp, and a footprint that grows to it
dies with ENOSPC on every retry. `2a48f27` the yarn berry
PnP fallback is harness-owned: after an ENOSPC-signed berry
install failure, the harness switches the workspace to
nodeLinker pnp (loose) with enableGlobalCache false — zips
park in the project .yarn/cache both prunes preserve —
drops the dead node_modules trees, retries once, and
records the decision as a /root sentinel that survives
workspace resets so every later round reapplies the config
before installing; the repair hint tells the agent to leave
the linker alone.

N111 in four commits, all candidates through the
judge-on-veto lane, none hard vetoes. `603dc88` the vacuity
candidate: an empty workspace diff under a manifest that
claims demoable features while declaring no demo machinery
at all (no localDemoModeChanges, fixtures, or data seams)
is midday's sham restated as evidence; a repo that
genuinely demos unchanged survives adjudication by saying
so. `6fc034b` an unverified fixture shape cannot back a
declared observable state: a data seam whose shapeProbe
records not-run or failed under a feature with an
expectedProof reaches the judge (excalidraw's "Undo
enabled" over a not-run probe). `e6f40b9` error-status
rewrites on probed responses reach the judge: a diff that
removes an HTTP error-status write and adds a success-status
write on the same file is treated as falsifying the probe
rather than repairing the feature — demo-gated flips
included, because the probe runs with the gate on.
`bd3b5b1` observed auth walls contradict declared no-auth
features: the failure report that dispatched the active
repair now threads its feature verdicts into the next
fidelity check, so a prior round's auth-wall verdict
against a feature whose manifest still declares
authStrategy "none" is a disproven claim, not prose the
judge never sees.

Deviation from plan (N111): the orchestration test stubs
needed one fixture correction, not a rule exception — the
stub manifest's empty-diff rounds were an accidental
replica of midday's sham, so the fixture now declares an
honest localDemoModeChanges entry instead of the rule
learning to excuse it.

Deviation from practice (wave discipline): the final three
commits were verified with targeted suites plus
fmt/lint/typecheck per commit under a token budget, with
knip and the full suite deferred to a single wave-end
gauntlet — recorded here: full suite 1131 tests green,
lint, typecheck, and knip clean. `5157dff` regenerates the
dependency graphs (one new edge: the orchestrator's N109
import of the stderr error signal). N112 (empty
chart-surface class) remains recorded, deliberately not
implemented.

Suggested gate before closing the plan: rerun the
mini-matrix with a disk-pressure repo (twenty, calcom, or
directus class) alongside a control — the acceptance
criteria read "twenty completes two sequential installs
inside 10GiB or fails citing ENOSPC with disk hints
present" and "no fidelity pass on an empty-diff manifest
claiming demoable features."

## Addendum (2026-08-11, wave-3 acceptance matrix — the disk-pressure five: twenty, directus, calcom, ghostfolio, homer)

The wave-3 gate ran the disk-pressure class (twenty,
directus, calcom) against two controls (ghostfolio,
homer). Both controls passed; all three heavy repos
failed — but none on raw ENOSPC. N110's disk work held:
twenty's install fit inside 10GiB (final disk 47%), and
no other entry showed a disk signature. Each failure sits
at a different stage, and two of the three share one
weakness — a retry that re-does work instead of building
on the last.

### Diagnoses

twenty — preparation-preflight (build), a cost N110's own
PnP fallback introduced. The install exhausted the 10GiB
disk in node-modules mode; the N110 berry PnP fallback
fired (sandbox event `install.disk-pressure.berry-pnp-fallback`)
and the install then fit under PnP. But twenty's build
and start are npx-driven (`npx nx run-many`, `npx
concurrently`, `npx wait-on`), and npm/npx cannot resolve
through PnP — there is no node_modules — so `yarn run
build` reached for `vite` from registry.npmjs.org and
died ECONNREFUSED on the sealed network, identically
across all five attempts. The fallback traded an honest
install ENOSPC for an opaque build-time network failure.

calcom — preparation-preflight (start), the resolver
overriding a good repair. The resolved start command was
`yarn run dev:all` → `turbo run dev --filter=@calcom/web
--filter=@calcom/website --filter=@calcom/console`;
`@calcom/website` and `@calcom/console` are proprietary,
absent from the OSS checkout. Turbo validates every filter
target up front and aborts exit 1 before `@calcom/web`
binds, so the readiness probe to :3000 got httpStatus 000.
The repair produced the correct fix — `startCommandUsed:
yarn run dev`, `appDir: apps/web`, passed on both
attempts — but `resolvePreparationRuntime` overrode it
back to `dev:all`/root every round: `findScopedRootScript`'s
`!targetsAnotherWorkspace` guard only rejects a root
script referencing other existing workspaces, so a script
fanning out to absent packages passed the guard and
clobbered the repair. Same fingerprint every round →
budget exhausted after 2.

directus — flow-planning, stateless-retry oscillation.
Not a crash, timeout, liveness kill, or resource failure —
exploration was rich (8 routes, 109 actions, all three
requested features grounded, no auth wall). The
flow-planning agent ran three times (the cap), each
writing valid JSON, each rejected by the FlowSpec contract
on one feature (`data-model-fields`) that carries two
rules: the interaction must come from the allowed set, and
the visible assert must target route-distinct content, not
globally-repeated navigation text. It oscillated — attempt
2 fixed the assert, attempt 3 fixed the interaction but
regressed the assert — never holding both, though the
validator named a working pair each time. Each retry ran
in a fresh opencode session and saw only the latest error,
with no memory of the prior fix.

Unifying theme: calcom and directus are the same weakness
one level apart — a retry that does not carry forward what
the last attempt got right. The resolver re-derives a
command that discards the repair; the flow planner
re-derives a spec that discards its own earlier
correction. N109's fingerprint/no-op machinery detects the
stuck loop but only ends the run; it does not make the
next attempt smarter. ghostfolio and homer passed as
controls, confirming the fixes below do not disturb the
working path.

### N113 (High, bugfix) — the disk fallback preserves module resolution

The yarn-berry disk fallback no longer switches to PnP,
which removes node_modules and breaks any npm/npx-based
build or start tooling (twenty). After an ENOSPC-signed
berry install failure it now switches to the node-modules
linker with `nmMode: hardlinks-global` — a real
node_modules tree with files deduped onto a global
content-addressable store — drops the copy-mode tree,
retries once, and records the decision as a `/root`
sentinel (`berry-hardlink-fallback`) that survives
workspace resets. A real node_modules keeps every
toolchain resolving; if the hardlinked tree still will not
fit, the install fails honestly with the existing ENOSPC
disk hint. The strategy never changes the module-resolution
contract, so it keys off nothing repo-specific.

### N114 (High, bugfix) — a runtime command may not select a package absent from the workspace

A shared `readAbsentWorkspacePackage` reads scoped package
selectors from a command and returns any that share a
known workspace's scope but are not themselves a workspace
package — quote- and tool-agnostic, keyed to the repo's
own workspace set. It guards two seams: `findScopedRootScript`
no longer selects a root orchestration script that fans
out to an absent package (so calcom's `dev:all` is skipped
for the workspace-local `yarn run dev`, matching the
repair), and `findRuntimeConfigurationIssue` rejects any
build or start command that references one (defense-in-depth
for an agent-authored command that bypasses resolution).
The diagnosis corrected the proposal: calcom's root cause
was the resolver overriding the repair, not a missing
persistence write, so the fix stops the override rather
than re-plumbing the manifest.

### N115 (Medium, feature) — artifact-stage retries accumulate their rejections

The shared artifact-stage retry loop now folds the distinct
rejection reasons a stage has accumulated into the next
attempt's prompt ("Each earlier attempt was rejected for a
different reason. A valid artifact must satisfy ALL of
these constraints at once — correcting one must not
reintroduce another:"), so a stage that fixes rule A can no
longer silently regress rule B (directus). It lives in the
retry loop, not in flow-planning, so it applies to every
artifact stage and any multi-rule contract.

### Landed (2026-08-11, wave 4: retries carry their evidence, disk keeps its node_modules)

`2bd90f5` N114 — the absent-workspace-package guard at both
the selection and validation seams. `a03e813` N113 — the
hardlinked node-modules disk fallback replacing PnP.
`c10435a` N115 — cumulative rejections folded into the next
artifact-stage prompt. All three TDD red-first with
synthetic fixtures (`@a/*` and `@acme/*` monorepos, a
three-attempt oscillation), never a twenty/calcom/directus-shaped
one, so no fix overfits the repos that motivated it. Full
suite 1135 tests green; lint, typecheck, and knip clean.
Dependency graphs unchanged (no module-structure change),
so no `generated:` commit. N112 (empty chart-surface class)
remains recorded, deliberately not implemented.

Suggested gate: rerun the same disk-pressure set — twenty
completes both installs inside 10GiB via the hardlinked
tree and builds (or fails honestly with ENOSPC and the
disk hint), calcom runs `yarn run dev` in apps/web and
binds :3000, and directus's flow planner converges instead
of oscillating.

## Addendum (2026-08-11, wave-4 rerun — the loopback family and the pre-capture gate: N116, N117)

The gate rerun (2026-08-11T20-47-14Z) validated N113 and
N114: twenty's hardlink fallback fired, both installs fit
at 43-45% disk, the build succeeded with no ECONNREFUSED,
and Vite bound — advancing from a build failure to a
readiness-probe miss; calcom booted on `yarn run dev` in
apps/web and reached footage capture (12 stages). Neither
of the two new failure classes below is caused by wave-4
code — both are older seams the rerun simply reached for
the first time. directus (a cosmetic `packageManager`
edit instead of the `predev` build it produced the prior
run) and ghostfolio (a prep-agent inactivity kill, then an
unreachable sandbox) were stochastic, passed other runs,
and are not code regressions.

### Diagnoses

twenty — preparation-preflight (readiness), a loopback
address-family mismatch. The build now succeeds and Vite
binds, printing `➜ Local: http://localhost:PORT/`, but the
readiness probe curled the IPv4 literal `127.0.0.1` and
was refused "after 0 ms" for the full budget while the
process stayed `running: true`. Under Node 24 the DNS
result order no longer prefers IPv4, so a dev server that
binds `localhost` (Vite's default) takes IPv6 `::1` first
and never listens on `127.0.0.1`. The probe is not the
only IPv4-literal consumer: the in-sandbox browser
explorer and capture both navigate `manifest.baseUrl`,
also `http://127.0.0.1:PORT`, so a probe-only localhost
retry would pass preflight and then fail exploration
against the same unreachable literal — the fault would
move downstream, not clear.

calcom — footage-capture, two pre-capture-gate gaps the
booted app exposed. (1) `capture-runtime-reset` restarts
the app for a clean take, then confirms health by probing
a single route — `preparationProbeUrl`, the first feature
`entryPath` — not the scene `goto` routes it is about to
film. A scene route that reverted to failing after the
reset is greenlit because it is never re-probed. (2) The
external-resource broker retries a capture-path pass to
hydrate blocked external resources and returns the latest
pass keyed only on remaining external attempts; a pass
that fails on an app-origin route 5xx while also carrying
an uncached CDN resource is retried after hydration, and a
byte-identical later pass with a lucky 2xx overwrites the
failure. Playwright's `page.goto` resolves on a 500, so
the 5xx surfaces only as a downstream assertion failure —
by classification alone indistinguishable from a
blocked-image assertion failure, so the broker cannot tell
a flaky app route from the external resource it is there
to hydrate. (calcom's underlying block is a genuine
Postgres gap the prep never provisioned — a separate
open decision — but the gates above must not greenlight a
route the capture will re-hit.)

### N116 (High, bugfix) — the dev server binds the loopback the pipeline dials

The root cause is Node's DNS order, not the probe, so fix
the bind rather than every consumer. Node 17+ defaults
`dns.lookup` to verbatim order (IPv6 first), which is why
a `localhost`-binding dev server takes `::1`. Pin the
app's own Node to `--dns-result-order=ipv4first` by
merging it into the `NODE_OPTIONS` the harness already
assembles for the submitted-code build and start
environment (`guardedRuntimeEnv`, alongside the runtime
network-guard `--require`, preserving any NODE_OPTIONS the
repo set). `localhost` then resolves to `127.0.0.1` first,
so the dev server binds the family the whole pipeline
dials — probe, in-sandbox browser explorer, and capture,
all through the unchanged `127.0.0.1` `baseUrl`. This is
the complete fix a probe-only localhost retry is not (that
would clear preflight and then fail exploration against
the same literal), and it is minimal: one flag on the env
already threaded through build, start, and every restart
(so capture, which films the app the reset left running,
inherits it too), with no `baseUrl` change and no
127.0.0.1 test churn. It targets the exact class that has
the bug — Node dev servers resolving `localhost` — while a
server that already binds `0.0.0.0` or an IP literal is
unaffected because the flag only reorders name
resolution. A genuine listen failure — nothing on any
loopback family — still refuses and classifies unchanged.
The `--host 127.0.0.1` fallback start command stays as a
second belt for the case where the harness supplies the
command outright.

### N117 (High, mixed) — the pre-capture gate re-probes what it films, and an app-origin server error sticks

Gap 1 (re-probe the scene routes). Thread the demo
script's distinct playwright-recording scene `goto` paths
into `resetCaptureRuntime`. After the readiness probe
confirms the app binds, probe each scene route once — the
app is already up, so no cold-render budget is spent — and
fail the reset naming any route that does not serve (a
refuse, a >=400, or a render timeout). The routes are
derived from the script the stage is about to film, never
a hardcoded path, so the gate generalizes to any repo. A
run with no scene routes falls back to the current single
readiness probe unchanged.

Gap 2 (an app-origin 5xx is a hard, sticky failure).
Instrument the capture-path script to record each scene's
main-document navigation status for same-origin (app)
responses, and classify an app-origin status >=500 as a
hard capture failure. Hydrating an external resource can
never fix the app's own route returning a server error, so
this verdict is sticky: the external-resource broker never
overwrites it with a later pass's success, and the
orchestrator never retries it as transient infrastructure.
The discriminator is origin, not classification, so
legitimate external-resource retries — always a different
origin — are untouched and keep their fail-then-hydrate-
then-succeed path. A route that 5xx's on any validation
pass is thus never greenlit for filming, even if a
byte-identical retry gets lucky.

Recommended order: N116 first (unblocks twenty and every
localhost-binding Node dev server, a single DNS-order flag
on the app env), then N117 gap 1 (re-probe scene routes),
then N117 gap 2 (the app-origin nav-status instrumentation
and its sticky verdict). N112 (empty chart-surface class)
remains recorded, deliberately not implemented.

### N118 (Medium, mixed) — post-landing review hardening for N114, N115, and N117

A full review of the landed wave-3/wave-4 range
(`e6f40b9..4dd8367`, 2026-08-11) confirmed every fix
behaves as designed and generalizes — lint, typecheck,
the 1148-test suite, and knip all pass — and surfaced
five residual gaps. None is a regression; each tightens
a landed fix. One task, five sub-items, in value order.

(1) N114 selector coverage: `readAbsentWorkspacePackage`
(`runtime-target-resolution.ts`) scans only the long-form
flags (`--filter/--workspace/--scope/--project(s)`), so
the cal.com failure class still slips through three
spellings it never sees: the positional
`yarn workspace <name> <cmd>`, npm's `-w <name>` short
flag, and comma lists (`--projects=a,b`). Extend the
scan to all three; keep the existing fail-safe posture
(judge only literal names, never paths, globs, or graph
patterns). Test first per spelling.

(2) N114 npm directory selectors: npm's `--workspace=`
also accepts a workspace *directory*. A bare selector
naming a root-level workspace dir whose package name
differs (`--workspace=docs` for a package named
`docs-site`) is flagged absent in unscoped-name repos —
the one known false positive. Add each workspace's dir
basename to the known short names.

(3) N117 gap-1 policy is cookie-less and cold by design:
a scene route behind a bare-401 document GET (no
redirect) or one that exists only after an earlier
scene's create action now fails the reset gate and spends
repair rounds reaching the authStrategy/fixture fix.
Move that cost from repair to prevention: state in the
script-generation contract (and its prompt) that every
`goto` path must serve cold and unauthenticated-or-
redirecting, so the script agent authors demo-gated
routes and fixture-backed paths from the start.

(4) Broker economics after a sticky verdict
(`runWithExternalResourceBroker`,
`default-harness-dependencies.ts`): once
`readStickyFailure` records an app-origin 5xx, later
passes still hydrate and restart before the sticky
verdict is returned, and the returned result carries
pass-1 evidence (its blocked-attempt list can be stale
after hydration). Decide once: short-circuit on sticky,
or keep hydrating for post-repair cache warmth — and
either way return the sticky classification with
final-pass evidence attached. Document the choice at the
seam.

(5) N115 cosmetic: when a rejection reason recurs after
being deduped (A, B, A again), `accumulatedArtifactError`
names B as "the most recent rejection" though the run
just rejected on A. Track last-seen order instead of
relying on insertion order.

Sub-items (1), (2), (4), and (5) are runtime changes and
follow TDD (failing behavior test first, through the
public seam). Sub-item (3) is prompt/contract steering
and is verified by its observable contract, not prompt
text. None blocks a matrix run; schedule behind any
active N-numbered failure class.

## Addendum (2026-08-12, two same-day matrices — install truth lands, and the walls behind the walls: N119–N122)

The morning batch (2026-08-12T06-26) exposed four pipeline
seams: a control-plane call that could hang a batch
forever, a PTY loss mode that reported a never-run install
as exit 0, a flow-planning rejection that restated a rule
the candidate already satisfied, and harness-executed
install/build/start commands that left no record of having
run. All four fixes landed the same day (wave 5, below).
The evening rerun (2026-08-12T20-27) validated every one
of them and surfaced four new signatures — each one layer
deeper than the wall it replaced. homer passed both
batches end-to-end.

### Landed (2026-08-12, wave 5: install truth and hang immunity)

- `bdedf67` — every Daytona control-plane attempt is
  bounded (default 10 min); a call that hangs without
  rejecting is abandoned as transport loss and re-issued
  through the transient ladder. Validated in production
  the same evening: directus's `fs.upload` hung exactly
  600000ms, was reclaimed, and the retry succeeded — the
  class that wedged the 2026-08-11 batch overnight now
  self-heals. Fired exactly once across five entries; no
  spurious timeouts.
- `e534d72` — a PTY stream that ends without the exit
  trailer is transport loss (new `"transport"` timeout
  kind), never a fabricated exit code. The sentinel is
  the only channel carrying the command's real status;
  the shell's own exit is bash's, not the command's.
  Closes the phantom-install class (ghostfolio's 27–42s
  "installs", 06-26 batch).
- `04f6d4a` — the flow-planning no-exercised-interaction
  rule now names its actual requirement (anchor on a
  tagged navigate, candidates enumerated) instead of
  reusing the pairing-rule wording; enforced only when a
  usable navigate exists (auth-wall navigates excluded
  for non-auth features), so the retry loop can never
  wedge on a navigate-free catalog.
- `feb0ee6` — `command.started`/`command.finished`
  sandbox-log events (label, bounded command text, exit,
  duration; written after transport-fault recovery) for
  every guarded heavy command, plus `app.start.requested`
  before the managed launch. Evening-run payoff was
  immediate: ghostfolio's installs are now provably real
  (deps events, exit 0, 19–21s), and diagnosis is a grep
  instead of wall-clock archaeology.

### Diagnoses (2026-08-12T20-27)

directus — run-plan synthesis, infrastructure. The Daytona
control plane had an incident window (20:30–20:41): one
repo-archive upload hung ten minutes (recovered by the new
attempt bound), immediately followed by an HTTP 502 storm.
The run then died writing the 7.5KB
`runtime-target-selection-contract.json` into the agent
workspace: the artifact-transfer seam is the only envelope
caller with a blip-sized ladder (`[1_000, 4_000]`, built
for one-off 502s on 2026-08-09), and ~15s of total budget
across its outer retries could not outlast a real window.
Every other seam's default ladder (~227s plus conflict
polling) would have survived this exact storm. → N119

ghostfolio — preparation-preflight, readiness semantics.
Six rounds visibly converged (round 1 crashed on a missing
module, rounds 2–5 had not bound yet, round 6 bound), and
then the probe killed the round 46 seconds after start on
its first HTTP response: a 404 served by the dev server
mid-compile. The prep's start command compiles the Angular
client at start time (manifest has no build command), the
server binds before its first bundle completes, and
`probeSubmittedCodeRuntime` retries only
`connection-refused` — any HTTP response is terminal by
design. A warm-up 404 is not "app route not discoverable";
it is "not ready yet", and the compile needed minutes the
probe never granted. → N120

twenty — feature verification, a browser-contract gap. The
build finally passed (round 4) and the app served. The
prep's data strategy was an MSW demo worker ("deterministic
local CRM data", per its own manifest limitation) — but the
explorer and capture browser contexts deliberately set
`serviceWorkers: "block"` (network-lockdown integrity:
a service worker can intercept requests route interception
never sees). Every route logged `[MSW] Failed to register
the Service Worker`, no data ever loaded, all four routes
rendered globally-repeated chrome, and the run failed as
"empty/unmeaningful app state". Service-worker mocking is
structurally impossible in this pipeline, and nothing ever
tells the prep agent. → N121

calcom — the database, now the binding constraint. Rounds
oscillated between two walls: preflight 500s where the
Next.js compile could not resolve Prisma-generated
artifacts (`packages/prisma/enums`) despite an exit-0
offline lifecycle — generated-state flakiness across
workspace resets — and, more telling, rounds 3 and 5 where
preflight fully passed and the feature probe found no
browser evidence for "show the event type dashboard" or
"choose an available time and complete a booking". Those
features read and write Postgres through Prisma on the
server; no mock at any browser boundary can reach them,
and prep has no way to provide a service. Product decision
recorded (2026-08-12): demos are never steered away from
data-backed features — the pipeline gains a data-backend
capability instead. → N122

### N119 (High, bugfix) — transfer retries sized for control-plane windows

Generality: the fix is at
`runTransferThroughEnvelope` (the provider's single funnel
for every idempotent filesystem transfer — contract
writes, artifact uploads, archive pushes — for every
repo); nothing is directus-specific. The transfer
docstring already declares the operations idempotent by
design, so a longer ladder is strictly safe; and the
envelope's own doctrine (N103) says control-plane windows
are multi-minute events a few-second budget always loses
to. Fix: drop `artifactTransferBackoffMs` to the default
control ladder (or a transfer ladder spanning minutes),
keeping `wrapExhausted: false` rethrow semantics.
`pty.create` keeps its short inner ladder deliberately —
its outer fresh-id/sandbox-restart loop supplies the
budget there; document that contrast at the seam. TDD at
the provider envelope seam.

### N120 (High, bugfix) — readiness treats any not-ready response as not ready yet

Generality: `probeSubmittedCodeRuntime` gates every repo's
preflight, and compile-at-start dev servers are a
framework-wide class (Angular's esbuild server, Vite
cold-transform, Next dev first-compile all bind before
they can serve). Two parts, both general:

(1) Within the readiness budget, an HTTP error response
is retryable exactly like connection-refused. Terminal
outcomes stay terminal: process exit (`runtime-exited`),
probe execution failure, and budget exhaustion — where
the final classification reads from the last observed
status, so a stable 404 still reports "app route not
discoverable" and a stable 500 still reports its server
error. Single-shot callers (`budgetMs = 0` — the N117
scene-route gate) are unchanged. Cost: a genuinely wrong
route burns its round's budget before failing; bounded,
and N118 sub-item (3) attacks that from the prevention
side.

(2) The budget extends while the managed app demonstrably
works: if app output grew since the last poll, the window
slides (absolute cap ~10 min, mirroring the
build-timeout scale); silence spends the base 180s
budget. A compiling server prints; a wedged one does not
— the same output-is-progress doctrine the inactivity
watchdog already applies to commands. Without (2), a
correct (1) still fails any app whose start-time compile
outlives 180s — ghostfolio's likely does.

TDD through the preflight seam with a fake workspace
whose probe responses transition refused → 404 → 200 and
whose app status carries growing output.

### N121 (High, mixed) — the browser contract bans service workers, and says so

Generality: MSW is the ecosystem-standard mocking layer
for SPAs — any repo whose prep agent reaches for
service-worker mocking hits this wall; twenty merely got
there first. The block itself is correct and stays (a
service worker bypasses route interception, so Runtime
Network Lockdown accounting would go blind); the gap is
that the constraint is enforced silently. Two parts:

(1) Contract steering: the preparation and repair
contracts (and prompts) declare that the demo browser
blocks service workers, and that data mocking belongs at
the fetch/API-client layer with deterministic generated
data — stable IDs and stable visible text, because
capture assertions bind to on-screen strings. In-memory
session state is acceptable ("created" rows may live only
for the browser session).

(2) Detection: a page-error pattern for service-worker
registration failure (generic
`/Failed to register.*Service ?Worker/i` — not an
MSW-specific string) in exploration and validation page
errors produces a targeted repair hint naming the
constraint and the fetch-layer alternative, so an agent
that chose a service worker is redirected in one round
instead of never.

Part (1) is contract/prompt work verified by observable
behavior; part (2) is a runtime seam and follows TDD.

### N122 (Critical, feature + infra, phased) — the data-backend ladder: detect, enforce, provide

Product decision (2026-08-12): never steer demos away
from data-backed features. Strategy: a closed loop where
the pipeline detects what a repo's data layer needs,
refuses to call preparation complete until every detected
need is addressed by some rung of a support ladder, and
the matrix carries one representative repo per rung as
its acceptance gate. Backend classes then cannot fall
through silently — an unsupported backend becomes a named
failure pointing at its rung. The rungs, in preference
order: embedded-config, provisioned-service, client-stub,
provider-recipe, declared-stub (the last still demos the
feature against deterministic generated data and declares
the substitution in the manifest — nothing is dropped).

(1) Detection — `servicesRequired` in the repo profile.
A pure profiling module reading only repo-declared
signals: `docker-compose.yml` services, `.env.example`
URL schemes (`postgres://`, `mysql://`, `mongodb://`,
`redis://`), Prisma `provider`, knex/drizzle/typeorm
configs, dependency names (`pg`, `mysql2`, `ioredis`,
`mongoose`). Output: normalized inventory with evidence
paths. Fixture-repo TDD per class, including "none".
Immediate side win: `findRuntimeConfigurationIssue` can
fail round 1 with "this start command needs Postgres and
nothing provides it" instead of six empirical rounds.

(2) Enforcement — the manifest answers the inventory.
The preparation contract gains a `dataStrategy`
declaration mapping every detected required service to a
rung; the manifest validator rejects prep output that
leaves one unaddressed, with a message naming the
service, its evidence, and the available rungs (the
flow-planning lesson: rejections state the fix; rules
fire only when satisfiable). This sub-item is the
"make sure" mechanism for every class.

(3) Rung 1, embedded steering (no infra): when detection
shows the repo supports an embedded backend, prefer it
(Prisma sqlite provider, directus's multi-driver config).
Acceptance: directus green on SQLite.

(4) Rung 3, client-boundary stubbing (with N121):
fetch/API-client interception serving deterministic
generated matrices. Acceptance: twenty green with
generated CRM data.

(5) Rung 2, ephemeral services (the infra lift): bake
postgres + mysql + redis binaries into the submitted-code
snapshot (`infra:`, versioned with the snapshot). One
deep module (`sandbox-services`): provision inside the
existing submitted-code sandbox on loopback only — no new
sandboxes (Daytona quota), no cross-sandbox networking,
Runtime Network Lockdown untouched. Provision during the
open install window and before the build step (SSG and
schema-introspection apps query at build time);
health-check; run the repo's own migrate/seed commands
through the guarded-command wrapper (disk markers, teed
evidence, and lifecycle events come free); reseed per
preflight round for determinism; teardown rides the app
lifecycle. Distinct preflight classifications and repair
hints per failure mode (service start, migration, seed).
Orchestration and command construction are TDD'd against
fake workspaces; the real-implementation exercise of an
actual Postgres boot is the matrix itself — stated
plainly: calcom (event types + booking on seeded
Postgres) and ghostfolio (postgres + redis) green are
the acceptance gate.

(6) Rung 4, provider recipes on demand: serverless/cloud
drivers get per-provider recipes only when a repo of that
class appears (Neon driver → `pg` swap, Turso → local
`sqld`, Firebase → local emulator), per the
smallest-correct-module rule. The sub-item (2) loop makes
deferral safe: an unrecognized cloud backend lands on the
declared-stub rung with generated data and an explicit
manifest declaration, never a silent gap.

Coverage guarantee: `tests/fixtures/pipeline-matrix.json`
keeps at least one repo per rung (homer: none, directus:
embedded, calcom: postgres, ghostfolio: postgres+redis,
twenty: client-stub); a new backend class enters the
ladder by adding its fixture repo first and driving it
red to green — the TDD loop at matrix scale.

### Recommended order

1. N119 — smallest diff, removes the only class that can
   kill a run in an infrastructure incident window;
   directus's only wall this batch.
2. N120 — ghostfolio's only remaining wall; one probe
   seam, both parts.
3. N121 — twenty's wall; contract text plus one detection
   seam, and a prerequisite for N122 sub-item (4).
4. N122 (1) + (2) — the structural loop: detection and
   enforcement land together so the manifest contract
   never demands what profiling cannot yet see.
5. N122 (3) + (4) — the cheap rungs; directus and twenty
   green without any provisioning infrastructure.
6. N122 (5) — the infra lift, started only after a matrix
   with 1–5 landed shows its acceptance repos clean of
   unrelated walls.
7. N122 (6) — on demand, never speculatively.

N118's hardening sub-items stay scheduled behind these
active failure classes, as before. The expected matrix
trajectory: after steps 1–3, directus and ghostfolio
green and twenty reaching data-strategy repair with a
named constraint; after step 5, five of five.

## Addendum (2026-08-13, wave-6 acceptance matrix — five failures, five causes: N123–N126)

The 2026-08-13T01-12 five-repo batch went 0/5 — but with
five distinct signatures, and every wave-5 fix visibly
working: N119 absorbed a 502 storm at 01:16–01:17
(upload and write-text retries, attempt 2 succeeded),
N120 carried calcom and twenty past startup 500s into
feature verification for the first time, N121 kept
twenty off service workers entirely (zero SW errors;
the prep built an Apollo-transport stub instead), and
N122(2) made every prep answer for its detected
services. Two failures are harness bugs (a raw Daytona
call outside the N103 envelope; a route-identity
mismatch that made flow planning unwinnable), one is a
repair-loop contradiction (evidence verified in one
context, replayed in another, two validators vetoing
each other's fix), one is agent quality missing a
steering hint (schema-incomplete client stub), and one
is the N122(5) wall arriving exactly as predicted. The
N122(5) gate — acceptance repos clean of unrelated
walls — is therefore not yet met: ghostfolio died to
infrastructure and homer/directus to harness bugs.

### Diagnoses (2026-08-13T01-12)

ghostfolio — repo-preparation, an unenveloped Daytona
call. The 11-minute prep agent command succeeded at
01:28:52; ~300ms later the run died on a raw "Request
failed with status code 502" with no `daytona.*.attempt`
events. The harness's next step after agent success is
reading the manifest via `tryReadWorkspaceJson` →
`workspace.execute("cat …")`, and the provider's
`execute` calls `sandbox.process.executeCommand` raw —
no envelope, no retry, no classification. Daytona was
broadly 502ing at that instant (teardown log persistence
502'd too). The `preparation.diff.patch.succeeded` and
three `artifact.written` events after the failure are
the catch path (diff capture, fallback, run manifest),
not the crime scene. Aggravation: the raw DaytonaError
is not an infrastructure error, so the pipeline wrote a
preparation fallback and the matrix report shows a bare
transport error as if the product failed. → N123

homer — flow planning, a latent route-identity bug. All
three attempts burned on one contradiction: the
declared-proof catalog action carried
`route: '#additional-page'` (the manifest entryPath,
copied verbatim at action creation) while the AppMap and
every other catalog action use the normalized
`/#additional-page`. The validator alternately rejected
"belongs to unselected route" and "unknown AppMap
route" — no agent output could satisfy it. The manifest
contract legally admits bare `#` entryPaths, so the trap
is armed on every run and sprung by whichever entryPath
form the prep agent happens to write. → N124

directus — deepest run to date, then an
exploration-vs-capture reality gap. The script passed
static contract using the browser-verified candidate
(`getByPlaceholder('Email Address', { exact: true })`,
matchCount 1, visible at exploration). Capture-path
validation timed out waiting for that same locator —
the element never appeared in the capture context.
Locator regrounding "passed" by re-verifying the same
locator in the exploration context, where it is
visible; the script-repair agent then deviated from the
candidate to work around the runtime failure, and
static contract vetoed the deviation (verbatim locator
equality). Pass/fail alternated until the script-repair
budget died. The terminal report ("locator does not
match browser-verified candidate") is the secondary
symptom; the root is evidence certified in a context
that capture does not reproduce, plus a repair loop
with no channel to say so. → N125

twenty — client-stub rung chosen correctly, fixture
schema-incomplete. Real repair progress: rounds 1–3
build failures, round 4 rendered but landed on the
sign-in page, round 5 had a genuine Apollo-link stub
(`dataStrategy: client-stub` for postgres and redis, no
service worker — N121 steering worked). But the stubbed
ClientConfig response is missing `authProviders` (and
Apollo logged dozens of missing fields), so every object
route crashed into the error boundary — "Cannot read
properties of undefined (reading 'authProviders')" — and
all three features failed as not observable. One missing
fixture field took down the app; nothing told the repair
agent which field or query. → N126

calcom — the data wall, honestly reported. N120 carried
preflight past the startup 500s that killed prior runs;
N122(2) forced a dataStrategy answer and the prep chose
`declared-stub` for postgres and redis ("no replacement
was added because an alternate screen or untyped mock
would not preserve the product flow" — the honest rung).
Consequence exactly as the 2026-08-12 addendum
predicted: `/event-types` renders its shell (that
verdict passed round 5), but the Prisma-backed routes
500 with no database behind them, so booking and
availability have no browser evidence. Five rounds,
correct classification. This is the acceptance case for
N122(5), blocked only by the gate above. → N122(5)

### N123 (Critical, bugfix + infra) — no Daytona call outside the envelope

Generality: the invariant is on the provider, not any
call site — no Daytona SDK rejection may escape
unclassified. Every control-plane request runs inside
`controlPlane.run`: transient ladder, attempt/retrying
events, exhaustion wrapped as an infrastructure error.
Audit every `this.sandbox.*` /
`this.submittedCodeSandbox.*` call site; known raw
today: `execute`, `executeStreaming`,
`executeSubmittedCode`, `executeStreamingInSandbox`,
`writeSandboxLogLine`, and the teardown log collectors
(calls already inside `runTransferThroughEnvelope`
attempt callbacks are covered). Command execution gets
the default control ladder — commands have no outer
retry loop, the same argument N119 made for transfers —
with the existing `withTimeout` composition kept inside
the attempt. Streaming executes envelope the initiation
call only; mid-stream disconnects stay with their
existing command-failure repair paths. Document the
at-least-once invariant on the `execute` seam docstring:
a retried command may run twice when the control plane
fails after execution; every `execute` caller is a
harness-authored idempotent command (`cat`, `mkdir -p`,
`rm -f`, log appends — a duplicated audit line is
acceptable), and agent commands ride the PTY seam,
which is unaffected. Classification falls out free:
default `wrapExhausted` makes exhausted retries an
infrastructure error, so the orchestrator stops writing
preparation fallbacks for infra deaths and the matrix
report names the incident instead of echoing a bare
502. TDD at the provider seam: 502-then-success on
`executeCommand` retries with attempt events; exhaustion
surfaces the wrapped error; a sandbox-log write survives
one 502.

### N124 (High, bugfix) — one route-identity space at evidence ingestion

Generality: every route stored in the ActionCatalog,
AppMap, or FlowSpec lives in one normalized route space;
authoring contracts stay permissive (bare `#` and `?`
entryPaths remain legal to write) and normalization
happens once, at the seam where an entryPath becomes a
route identity. Fix: a small helper converting a
manifest entryPath to route space by resolving against
the base URL (`#additional-page` → `/#additional-page`,
`?q=1` → `/?q=1`), applied at declared-proof action
creation — today the raw entryPath is copied verbatim
into the action's `route`. Sweep the other entryPath
consumers and normalize any that compare against route
identity; the navigation use resolves against the base
URL already and stays as-is. No double normalization
inside comparators (it would mask drift), and no
tightening of the authoring contract (the flow-planning
lesson: rules fire only when satisfiable — here the rule
must compare in the space the evidence actually uses).
Regression: entryPath `#x` yields a declared-proof
action whose route equals the AppMap-normalized form;
plus a catalog-level invariant test that every produced
action route parses in AppMap route space, so the class
cannot silently return.

### N125 (High, mixed) — evidence verified where it replays, and the ping-pong breaker

Generality: browser evidence must be verified in the
context in which it will be replayed, and a candidate
that failed at replay may not be re-certified unchanged.
Four parts:

(1) Failure identity flows into regrounding: a
capture-path locator failure on a browser-verified
candidate passes `{actionId, candidateId, locator}` and
the already-downloaded failure screenshot into the
regrounding input, replacing the generic "re-run App
Exploration" hint.

(2) Regrounding verifies by prefix replay: for a failed
candidate it executes the scene's action prefix before
verifying, reproducing capture context rather than
merely loading the route. Cost bounded by scene length.

(3) Honest reclassification: if the element is still
absent after prefix replay, the verdict is "evidence
unreproducible at replay" — an app-state divergence
dispatched to the preparation/runtime repair channel
with the exploration-vs-replay evidence pair. The
script channel cannot fix an app that no longer shows
the element; today it burns its whole budget trying.

(4) The breaker: if, for the same actionId, a
static-contract locator-equality rejection follows a
capture-path locator failure twice consecutively, stop
and fail with one combined diagnosis naming the
contradiction instead of exhausting the budget
silently. Cheap adjunct: the locator-equality error
prints both locators (expected candidate vs actual), so
a genuine drafting slip is fixable in one round.

TDD through the validation seams with fakes: regrounding
input carries the failed candidate; prefix replay
precedes verification; unreproducible evidence
reclassifies to the preparation channel; the breaker
trips on the alternating pattern; the contract error
names both locators.

### N126 (Medium, feature) — client-stub schema-gap hints

Generality: when a run declares a `client-stub`
dataStrategy and the app crashes at runtime, the
explorer converts crash diagnostics into a targeted
repair hint — the N121 mechanism, driven by pattern
tables, never by any app's specifics. Detector beside
the service-worker hint: error-boundary crash signals
(`Cannot read properties of undefined (reading 'X')`)
and client-cache missing-field signals (Apollo's
`Missing field 'X' while writing result`), extracting
the quoted identifiers generically. The hint names the
extracted fields and states the obligation: the stub
transport must satisfy the complete response schema for
the queries powering the entry routes, starting with
the named fields. Gated on the manifest actually
declaring a `client-stub` rung so it never fires noise
at apps crashing for unrelated reasons. Pattern tables
extensible per the N122 detection precedent. TDD: fake
observed errors containing both pattern classes produce
the hint with extracted names; no client-stub
declaration, no hint.

### Recommended order

1. N123 — kills runs nondeterministically in any
   incident window; ghostfolio's only wall this batch,
   and the misclassification fix rides along.
2. N124 — makes runs unwinnable on an agent wording
   coin-flip; homer's only wall.
3. N125 — directus's wall; the largest seam work of the
   four.
4. N126 — twenty's accelerator; smallest diff.
5. Matrix rerun, then evaluate the N122(5) gate:
   expected trajectory is ghostfolio green or failing as
   a named infrastructure incident, homer green through
   flow planning, directus green or honestly
   reclassified, twenty reaching schema-specific repair,
   and calcom still stopped at the data wall — which is
   the gate signal for N122(5), not a failure of this
   wave.

## Addendum (2026-08-13, wave-7 acceptance matrix — first multi-pass batch; the N122(5) gate misses on calcom alone)

The 2026-08-13T05-45 batch: homer and ghostfolio
PASSED end-to-end (final videos composited), directus,
twenty, and calcom failed. Every wave-6 fix behaved:
N123's envelope stamped all ~1300 control-plane calls
across the batch with attempt events (zero retries
needed — infrastructure was calm, so the envelope was
armed but untriggered), N124 unblocked homer through
flow planning on the first pass, N125's structured
failedAction fired in homer's capture round and routed
cleanly through plain script-repair (regrounding and
the breaker never needed to arm), and N126's gate
correctly stayed silent on twenty — the client stub was
never reached, so there were no quoted-field crash
diagnostics to match. The three failures are: one
harness sequencing bug in front of calcom's data wall
(N127), one classification hole plus a gate-silencing
repair on twenty (N128, N129), and one new prep-quality
wall on directus amplified by two pre-existing harness
seams (N130, N131).

### Diagnoses (2026-08-13T05-45)

homer — passed, 416s, with two absorbed events worth
recording. (a) Flow-planning attempt 1 failed FlowSpec
validation and re-ran invisibly: failed agent-artifact
validations emit no pipeline-log event at all, so
repair-round accounting from the log undercounts
(watchlist). (b) One capture-path failure
(dashboard-assert-services timed out because a leftover
`?search=notes` filter hid the tile group) was repaired
by typing "" instead of removing the step — the FlowSpec
still declares "enter a value and observe the search
control accept it", so the shipped demo has a dead beat
(watchlist: repairs may neuter a step's declared intent
without any validator noticing).

ghostfolio — passed, 1867s, on repair round 4 of 4:
zero budget margin (watchlist). The pass rode the
client-stub rung for both postgres and redis (an
Angular HTTP interceptor serving fixture envelopes; no
DATABASE_URL at all), which is legal under N122(2) but
means the add-investment-activity scene shows a write
that persists nothing (knownLimitations concedes it).
The four repair rounds were coherent: fidelity
violation → nx build path → missing env crash →
logo-endpoint 500s, each fixed in turn. As the N122(5)
acceptance repo, this run is "clean of unrelated
walls" — but its acceptance criterion (postgres+redis
green on the provisioned rung) is only now possible.

calcom — NOT stopped at the data wall alone; the
terminal failure is a harness sequencing bug. Rounds 1
and 3 ran fs.sync → install → offline lifecycle →
start; rounds 2 and 4 ran fs.sync → start directly.
The install uses --mode=skip-build, so `prisma
generate` outputs exist only via the separate lifecycle
step — and fs.sync re-materializes /workspace/repo,
destroying those untracked generated files. Rounds 2
and 4 therefore compiled against a repo with no
generated Prisma client: 1189 module-not-found
(`../enums`, `@calcom/prisma/enums`, ×1025) surfacing
as the 500 the matrix report shows, classified "missing
dependency". Zero Prisma connection errors anywhere in
the run (no ECONNREFUSED, no :5432, no P1001) — the
data wall never got to speak in the terminal round.
Round 3, the one correctly-sequenced round, showed the
real wall exactly as predicted: preflight passed,
/event-types rendered chrome with three skeleton rows
and a disabled "Loading..." user button, feature probe
failed 2 of 3 features. Aggravations: two of five
repair rounds were burned on fidelity oscillation (a
replacement-UI detour, then a .yarnrc.yml candidate the
adjudicator had already approved being re-litigated to
"unadjudicated" — a flake), and those fidelity rounds
were charged against the runtime-repair budget. The
rung chosen was declared-stub; no hint ever named the
database. → N127 (and watchlist)

directus — a new prep-quality wall, not the 2026-08-11
predev ghost and not infrastructure (305 Daytona calls,
all attempt 1). Upstream `packages/extensions` fans
`build` out to two tsdown invocations sharing one
--out-dir; tsdown cleans the dir at start of each run,
so whichever entry builds second deletes the other's
output — parallel order broke `dist/node.js` (round 3),
the round-4 serialization deterministically broke
`dist/index.*` the other way. Neither ordering can
work; the fix (--no-clean on one entry) was one
hypothesis past the budget. The predev fix DID land in
round 3 and ran the workspace build. Two harness seams
amplified it: (a) every preflight hint said "Set
buildCommandUsed to build @directus/extensions" while
runtime-target resolution unconditionally strips
agent-set buildCommandUsed and forces build undefined
for dev-server starts — the hinted channel does not
exist (→ N131); (b) the repeated-failure fingerprint
keys on the last error-class line, which for pnpm is
always the ` ELIFECYCLE  Command failed` epilogue, so
three distinct crashes counted as one repeat and the
run died on the repeated-failure limit (2) with the
global budget barely touched (→ N130).

twenty — never reached the client stub; the wall is the
Nx workspace build graph, terminating in a Vite
dev-server 500. Rounds 1–5: build failures around
twenty-shared (`twenty-shared/dist/vite.mjs` missing,
then a self-recursive `"build": "npx nx build
twenty-front"` rewrite). Round 6 "fixed" the build by
rewriting the app's build script to `npx nx build
twenty-shared` — a command that succeeds by no longer
building the app (→ N129). At runtime, `twenty-ui`'s
CSS build outputs don't exist, Vite's import-analysis
500s on the entry chunk `/src/index.tsx`, and every
route serves a full-screen Vite error overlay. The
probe classified this "empty/unmeaningful app state"
with a data-fixtures hint: the overlay text lives in a
shadow root the aria snapshot pierces but the
visible-content extraction does not, and an entry-chunk
5xx produces neither pageErrors nor field-quoting
diagnostics — so repairs were pointed at the data layer
while the fault was module resolution (→ N128). N126's
non-fire was correct behavior on wrong-layer input.

### The N122(5) gate

Gate text: acceptance repos (calcom, ghostfolio) clean
of unrelated walls. ghostfolio: clean — passed.
calcom: NOT clean — N127 sits in front of the data
wall, and the terminal round failed on it, not on the
missing database. Strict reading: the gate misses on
calcom alone. Product reading: the data wall is
directly observed in every correctly-sequenced round
(round 3 this batch, round 5 last batch), the blocking
bug is diagnosed with a one-line cause, and waiting one
more matrix to re-observe a wall we can already see
buys nothing. Decision: N122(5) implementation
proceeds; N127 must land before (or with) the
acceptance rerun, or calcom will fail for non-data
reasons again.

### N122(5) — landed (this session)

Implementation as specified in the 2026-08-12 plan:
postgres + mariadb (mysql protocol) + redis binaries
baked into the submitted-code snapshot (`infra:`
commit, dockerfile content test); one deep module
`sandbox-services` — loopback DSNs published as
constants, reset-then-boot provision scripts per
service (initdb/pg_ctl as postgres, mariadb-install-db
+ socket-auth root with TCP makeademo account,
redis-server with persistence off), `[makeademo:service]
ready` markers as evidence; manifest declarations gain
optional migrationCommand/seedCommand (schema reader,
contract JSON + invariants publishing the exact DSNs,
enforcement flip moving provisioned-service into the
backed rungs with provisionable-service and
command-placement checks); the template and the
data-strategy prompt steer embedded-config →
provisioned-service → client-stub → declared-stub; the
offline lifecycle provisions declared services after
install/reseal and before the build, runs migrate/seed
through the guarded wrapper with envUsed, and reseeds
by reprovisioning on every validation round; three new
preparation-routed classifications (service start /
migration / seed failure) with per-mode hints stating
the empty-database reseed contract. The real-Postgres
exercise is the matrix itself, per the plan.

### New items

### N127 (Critical, bugfix) — lifecycle must follow every workspace re-sync

calcom's terminal wall. Invariant: a round that
re-materializes /workspace/repo (fs.sync) must not
start the app against a tree whose install/lifecycle
outputs were destroyed by that re-sync. Either re-run
the deps + offline-lifecycle step unconditionally after
any fs.sync, or make the sync preserve untracked
generated outputs (node_modules survives; generated
source like prisma client does not). The skip logic
that decides "install unchanged, skip it" is deciding
about a tree the sync just replaced. Also blocks the
N122(5) acceptance rerun: with a provisioned database,
rounds 2/4-style sequencing would still 500 before
touching it.

Landed (this session), as the first option with the
install reuse kept: the offline lifecycle moved out of
the install gate and now follows every re-sync — the
skip decision stays sound because it only concerns
node_modules and the caches, the exact trees the sync
preserves. Install-reuse rounds (repair preflight with
unchanged dependency inputs, and the capture reset) run
the lifecycle standalone from the remembered executed
install command, so retry flags like directus's
engine-strict bypass carry over; with no in-process
install yet it falls back to the manifest command. The
reuse path also recreates the staging TMPDIR (pruned at
the end of every install round) and reapplies the Berry
disk-fallback linker when its sentinel is armed, since
the sync restores the repo's own .yarnrc.yml. A failed
reuse-round lifecycle keeps the install-failure /
lifecycle-timeout classification, and the orchestration
now also clears the reuse marker when a reuse round
fails at the install layer — without that, a
lifecycle-timeout's full-latitude source-only repair
would keep dependency inputs unchanged and replay the
identical timeout every round.

### N128 (High, bugfix) — an entry-chunk 5xx is a serve failure, not empty app state

twenty's misrouted terminal round. When exploration
observes the app's entry module (or any same-origin
script the document requires) answering 5xx, classify
as a serve/build failure routed to preparation repair
with the failing URL and status in the summary — before
any empty-state or data-strategy interpretation (N126
included). Companion fix: visible-content extraction
must see shadow-root text the aria snapshot already
captures (Vite's error overlay rendered a page of
diagnostic text that the probe read as "no visible
content"); the overlay text names the exact missing
import and belongs in the failure summary.

Landed (this session): the explorer script records
same-origin script responses answering 5xx (minus the
504 stale-module shape the crawler reloads through)
into `failedScriptResponses`, deduped and bounded; the
backend re-filters them against the app origin and,
when the run already failed grounding, classifies as
"app server error" (existing preparation-repair route)
with the failing URL and status in the summary. A named
missing-module page error still outranks it, and a run
that grounds its features never converts to failed.
Companion landed: when the selector harvest and
body.innerText both come up empty, `textSample` falls
back to the aria snapshot's text runs — which pierce
open shadow roots — unfiltered by cross-route dedupe,
so every overlay-only route carries its own evidence.

### N129 (High, bugfix) — the build gate must build the app under test

twenty round 6 bought a green build gate by rewriting
the app package's own build script to build a different
project. The gate's question must be "did the app under
test build", not "did buildCommandUsed exit 0". Options
in strength order: verify the app's build outputs exist
after the build step (framework-generic: the start
command's entry artifacts); reject repairs that rewrite
the selected app package's build script to a target
that no longer references the app; at minimum, surface
a fidelity check when a repair narrows the effective
build scope.

Landed (this session): option 2, at the fidelity seam.
`readPreparationFidelityCandidates` now raises a
candidate when a repair rewrites the selected app
package's own `build` script so that every command
segment carries an explicit workspace-target selector
(nx build/run/serve, --filter/--scope/--project(s),
yarn `workspace <name>`, npm -w/--workspace) and none
of the targets reference the app by package name or
directory. A script keeping any in-place step or naming
the app stays legal, and adjudication can rescue task
runners whose project names match none of the app's
identifiers. Option 1 (predict build artifacts
framework-generically) was deliberately not taken:
artifact locations are framework-specific and guessing
them across arbitrary repos is the overfitting this
plan forbids; the runtime side of the same failure is
now caught generically by N128's serve-failure
classification. Original repos never pass through the
fidelity seam, so unusual-but-legitimate build scripts
in submitted repos are unaffected.

### N130 (High, bugfix) — fingerprint on the cause, not the package-manager epilogue

directus died on the repeated-failure limit with three
distinct crashes. `readLastErrorCauseLine` must skip
wrapper epilogue lines — pnpm's ` ELIFECYCLE `,
`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, `Exit status N`,
npm's `npm ERR! Lifecycle script`, yarn's `Command
failed with exit code` — and land on the last
tool-authored error line above them, exactly as its
doc comment already promises. One fingerprint per
actual cause; the repeated-failure limit then means
what it says.

Landed (this session): a wrapper-epilogue pattern in
the cause-line reader covering the pnpm, npm (including
the Failed at / not-a-problem-with-npm / log-location
block), and yarn shapes; epilogue lines are skipped
while any tool-authored cause line exists and kept as
the answer only when nothing above them qualifies, so
a bare epilogue never turns into "no cause found". The
generic command-failed shape anchors to the line end so
execa-style lines that append the failing command keep
their identity. Locked by an orchestration test:
distinct causes above identical pnpm epilogues no
longer collapse into one repeated-failure fingerprint.

### N131 (Medium, bugfix) — stop hinting a channel the resolver deletes

The unbuilt-workspace-package hints say "Set
buildCommandUsed to …" while runtime-target resolution
strips agent-set buildCommandUsed and forces build
undefined for dev-server starts — directus's agent
obeyed the hint into a wall three rounds running.
Either honor a preflight-repair-set buildCommandUsed
(resolution keeps it when it names a real workspace
build target), or reword the hints to the channel that
exists (the repo's own pre-start hook / predev, or the
manifest's install scope). The hint and the resolver
must agree on who owns the build command.

Landed (this session): honor, plus hint wording that
states the contract. `resolvePreparationRuntime` now
keeps an agent-set buildCommandUsed whenever resolution
itself produced no build command (dev-server starts,
buildless targets) and the command — or the app script
body it runs one level down — references a known
workspace package by full name or directory (including
`./<dir>` path filters) while selecting no absent one.
A resolved build command still wins, and commands
naming no real workspace target are still stripped, so
backend ownership is unchanged everywhere except the
hinted channel. The three unbuilt-workspace-package
hints now say to name the package in the command and
that the backend keeps such a command even for
dev-server starts — hint and resolver state the same
contract.

### Watchlist (no fix scheduled; re-check next matrix)

- Failed agent-artifact validations emit no pipeline
  event (homer's invisible flow-planning retry);
  dashboards undercount repair rounds.
- Script repair can neuter a step's declared FlowSpec
  intent without failing anything (homer's "" search).
- Fidelity-repair rounds charge the runtime-repair
  budget, and the adjudicator re-litigated an
  already-approved .yarnrc.yml candidate to
  "unadjudicated" (calcom; one full round lost).
- ghostfolio passed on its last repair round — if 4 is
  the cap, zero margin.
- ghostfolio's manifest carried a stray top-level
  `"rung": null` alongside the per-service rungs;
  whitelist readers drop it, but whatever writes it is
  sloppy.

### Recommended order

1. N127 — gates the N122(5) acceptance rerun; calcom
   cannot show the provisioned database working while
   rounds still start against a wiped tree.
2. N130 — cheap, and it is currently terminating
   pnpm-monorepo runs that are making progress.
3. N128 — twenty's repairs cannot aim until the 500 is
   named as a serve failure with the overlay text.
4. N129 + N131 — the build gate and its repair channel,
   one seam conversation.
5. Matrix rerun: expected trajectory is homer and
   ghostfolio holding green (ghostfolio ideally
   choosing provisioned-service under the new
   steering), calcom green through preflight on a
   seeded Postgres (the N122(5) acceptance), directus
   surviving to the tsdown hypothesis with per-cause
   fingerprints, twenty reaching its client stub with
   the serve failure named.

## Addendum (2026-08-13, wave-7 rerun — all five failed: a Daytona platform incident plus a stale snapshot; the wave-7 code held)

The 2026-08-13T19-21 batch: all five entries failed,
and none of the failures implicate N127–N131. Two
environmental causes explain everything. First, a
Daytona platform incident spanning roughly 19:33–21:42
UTC: control-plane fs.upload/fs.sync/fs.write-text
calls hung without responding (each burning the full
10-minute attempt timeout), and sandbox egress DNS was
broken (EAI_AGAIN to registry.npmjs.org inside open
install windows). That killed homer, directus, and
twenty on the 90-minute wall clock — amplified by the
N123 envelope's own design, whose 10-min-per-attempt ×
8-attempt ladder let a single envelope legally consume
60–84 minutes (→ N133). Second, the deployed
submitted-code snapshot
(makeademo-submitted-code-browser-ca-20260809-mem8,
built 2026-08-09) predates the Dockerfile's N122(5)
services layer, so the postgres/mariadb/redis binaries
the provisioned-service rung depends on do not exist in
the sandbox — the rung's boot script fails on its first
shell line. That killed calcom and derailed ghostfolio
(→ N132). The N122(5) acceptance question is therefore
unanswered, not failed: no run in this batch ever
executed against a real provisioned database.

### Diagnoses (2026-08-13T19-21)

homer — wall-clock death, pure incident. One fs.upload
envelope opened at 20:02 and did not fail until 20:59 —
57 minutes inside a single control-plane call — and the
install windows that did open hit EAI_AGAIN resolving
registry.npmjs.org (sandbox egress DNS was down too, so
even successful uploads led to dead installs). Nothing
app-specific or wave-7-specific in the run at all.

directus — wall-clock death, pure incident. Two fs.sync
storms (19:49→20:28 and 20:38→21:39) consumed nearly
the entire budget before any repair hypothesis could
run; the tsdown --out-dir wall from the previous batch
was never reached. The per-cause fingerprints (N130)
never got input to discriminate.

twenty — wall-clock death, but with the batch's one
piece of real progress first: round 3 passed preflight
and ran exploration for the first time — the N129
fidelity veto and N131's honored build channel got the
workspace build through, and the serve failure of the
previous batch did not recur. The new wall is past the
build: object routes rendered only navigation chrome
because the client stub injected no data (watchlist).
Then the incident took over: round 4's lifecycle timed
out on yarn retrying a sealed-network fetch until exit
124, and round 5 died on ENOSPC in
/root/.makeademo-staging (watchlist) before the clock
ran out.

calcom — the N122(5) image gap, end to end. The
provisioned-service rung's postgres boot script failed
on its first line: `ls: cannot access
'/usr/lib/postgresql/*/bin': No such file or directory`
then `chown: invalid user: 'postgres'` — the snapshot
simply does not contain the binaries the rung was built
against. The run then oscillated: service boot fails →
repair drops the rung → the app starts but every
DB-backed feature (event types, booking) is
unobservable → repair re-adds the rung → boot fails
again — to the repair limit. The oscillation is
rational agent behavior against an impossible
environment; no harness bug.

ghostfolio — image gap, then an unhinted retreat path.
Round 1 hit the same missing-binaries boot failure and
the agent legally retreated to the client-stub rung —
but the retreat rewrote startup to `npm run start`
(`node dist/apps/api/main`), and dist/ had never been
built: MODULE_NOT_FOUND every round after. The resolver
derives no build command for this shape and the
unbuilt-workspace-package hints (N131) only match
workspace-package paths, not root-level dist/ output —
so no hint ever named the missing build (watchlist:
retreat-path build channel).

### New items

### N132 (Critical, infra) — the deployed snapshot must contain its own services layer

The Dockerfile has shipped the
mariadb-server/postgresql/redis-server layer since the
N122(5) landing; the deployed snapshot predates it, and
nothing between "Dockerfile changed" and "matrix run"
checks that the deployed image matches. Fix in two
parts. (1) Rotate: build a fresh snapshot from the
current Dockerfile via the established runbook
(`daytona snapshot create`, CPU 2 / memory 8GB / disk
10GB), repoint MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT,
run `bun run verify:daytona-image`. (2) Guard: the
verifier must provision all three services with the
real createServiceProvisionCommand inside the
submitted-code sandbox and demand each
`[makeademo:service] <name> ready` marker, so a
snapshot missing the binaries fails verification
instead of failing mid-matrix.

Landed (this session): the verifier guard runs every
provisionable service through the exact harness call
shape (sh -ec + shellQuote) and asserts the ready
markers; snapshot
makeademo-submitted-code-browser-ca-20260813-services-mem8
built from the unchanged Dockerfile and `.env`
repointed. The guard earned its keep immediately: the
first run against the fresh snapshot failed on a latent
bug in the mysql provision script — its first-ever real
execution (the matrix never got past the missing
binaries). mariadbd drops to the mysql user before
creating its socket and pid file, and both paths sat
directly in the root-owned services root: TCP bound
fine, then "Can't start server : Bind on unix socket:
Permission denied" and abort. Fixed by moving both
inside the mysql-owned data directory (regression test
on the script contract); postgres and redis were never
exposed — postgres writes only inside its chowned
subdirectory and redis runs as root. One retry also ate
a residual incident flicker (the parent sandbox
transiently could not resolve github.com — egress DNS,
the same symptom that killed homer's installs). The
rerun passed everything: all three ready markers, plus
the full pre-existing runtime verification.

### N133 (High, bugfix) — hung attempts must not inherit the transient ladder

The escalating ladder (2s→90s backoff, 8 attempts)
exists for fast-rejecting transients — 502s, resets —
where retrying is cheap and the 2026-08-12 batch proved
patience wins. A hung attempt is a different animal:
each one costs the full 10-minute attempt timeout
before the envelope even learns it failed, so the same
ladder prices a persistent control-plane outage at
60–84 minutes per envelope against a 90-minute run.
Attempts abandoned by the attempt timeout (error name
DaytonaControlPlaneAttemptTimeoutError) now count
against a separate hungAttemptLimit (default 2)
regardless of remaining ladder rungs: a persistently
hung envelope fails in ~21 minutes, while fast
transients keep the full ladder unchanged.

Landed (this session): the cap in the control-plane
envelope with two tests — persistent hangs stop at the
cap with the attempts count and classification
preserved in the terminal error, and a hang followed by
fast 502s still walks the whole ladder to success.

### Watchlist (no fix scheduled; re-check next matrix)

- ghostfolio's retreat path has no build channel: a
  client-stub retreat that switches startup to a
  root-level dist/ entry (`node dist/apps/api/main`)
  gets MODULE_NOT_FOUND with no hint and no resolver
  build derivation — the unbuilt-workspace hints only
  match workspace-package paths.
- twenty's client stub injected no data: object routes
  rendered navigation chrome only. The stub reached is
  not the stub working.
- twenty round 5 hit ENOSPC in /root/.makeademo-staging
  — staging-dir hygiene under repeated repair rounds.
- Incident-mode observability: nothing in the run
  distinguishes "the platform is down" from "the app is
  slow" until the wall clock kills the run; a batch
  health canary (verify:daytona-image before launch)
  is now the manual mitigation.

### Rerun

All five entries, after the N132 rotation is verified.
Expected trajectory: calcom and ghostfolio finally ask
the N122(5) acceptance question against real binaries;
homer green as before the incident; directus reaching
the tsdown hypothesis with N130's per-cause
fingerprints; twenty resuming from its round-3 progress
into the client-stub data question.

## Addendum (2026-08-13, wave-7 second rerun — all five failed: the batch starved its own uplink, and two apps hit real walls the harness misread)

The 2026-08-13T23-23 batch: all five entries failed,
but unlike the 19-21 batch the platform was healthy —
directus's 28MB archive upload succeeded on an ordinary
retry in the same minutes twenty's was dying, and no
envelope saw a hang outside the bulk transfers. Three
causes explain everything. First, launch-window network
contention of the batch's own making: five entries
entered the launch window together, putting two
multi-GB clones (calcom, ghostfolio) and three archive
uploads — including twenty's 294MB uncompressed tar —
on one developer uplink at once. The clones died
locally at 87s and 213s with exit 128 mid-transfer
(both repos clone fine solo, and there are no
disk-pressure events), and twenty's upload was killed
at exactly 600s twice — a live, slow transfer abandoned
as a "hang" — so the N133 cap correctly ended the run
in 25 minutes (→ N134). Second, a flow-planning rule
contradiction on homer: the prompt ordered "select
exactly min(3, inventory)" while the validator demanded
evidence the catalog could not supply for dark-mode, so
three fresh sessions produced three byte-identical
rejected FlowSpecs (→ N135). Third, a dead demo gate on
directus: the client stub keyed on
`import.meta.env.MAKEADEMO_DEMO`, which Vite never
delivers to browser code, so the stub was dead code,
the app's real calls stormed ECONNREFUSED
127.0.0.1:8055 through the Vite proxy, and the explorer
misclassified the wreckage as "requested feature not
observable" — five repair rounds aimed at the wrong
layer (→ N136). N132's snapshot held (the services
binaries verified clean before launch), and N133 did
its job — but the N122(5) acceptance question is
unanswered for the third consecutive batch: calcom and
ghostfolio died before ever reaching Daytona.

### Diagnoses (2026-08-13T23-23)

calcom — local clone death, launch-window contention.
`git clone` exited 128 at 87s, mid-transfer, while
ghostfolio's clone and three archive uploads shared the
uplink. The report row truncated the message at
"Cloning into …" and nothing durable recorded git's
trailing fatal: line (→ N134 part D). The same clone
succeeds solo after the batch. Never reached Daytona;
the N122(5) question was not asked.

ghostfolio — same shape as calcom at 213s: exit 128
mid-transfer during the launch window, full fatal line
lost to truncation, clean solo clone afterward. Never
reached Daytona.

twenty — the 294MB uncompressed screened-repo.tar
upload was abandoned at exactly 600s by the envelope's
attempt timeout, twice in a row, and the N133 cap ended
the run at 25 minutes. Working as designed — but the
design conflates a hung call with a live transfer that
is merely big: directus's 28MB upload succeeded on
retry at the same moment, proving the control plane
responsive. The transfer needed compression and a bound
that scales with payload (→ N134 parts A and C), not
more retries.

homer — flow-planning wedge, zero forward progress
after exploration. The inventory held three features
but the ActionCatalog grounds dark-mode with only a
navigate action (the theme toggle is an anchor
harvested into primaryNavigation; buttons is empty),
while the validator unconditionally demands a tagged
interaction and a tagged visible assertion per selected
feature. The prompt's "select exactly min(3,
inventory)" forced dark-mode in anyway, so attempt
after attempt — three, in three fresh sessions —
selected the same three features and died on the same
violation, byte-identical each time. The N131 lesson
recurs one seam up: the hint and the validator must
state the same contract (→ N135).

directus — deepest run of any batch, then five rounds
against a dead gate. The tsdown wall from two batches
ago was never hit, preflight passed, and exploration
ran — real cumulative progress (N129/N130/N131 all
earning keep). The preparation chose the client-stub
rung for all three services (despite the
provisioned-service rung being available and preferred —
watchlist) and gated the stub on
`import.meta.env.MAKEADEMO_DEMO`. Vite only exposes
VITE_-prefixed variables (or explicit `define` /
`envPrefix` entries) to browser code; `process.env`
works inside vite.config.ts, which is exactly why the
gate looked right to the agent that wrote it. The stub
never engaged, every real API call was refused
(ECONNREFUSED 127.0.0.1:8055 storm through the Vite
proxy), and the explorer classified the empty screens
as "requested feature not observable" — so repair
attacked feature selection and routes, never the
delivery mechanism (→ N136).

### New items

### N134 (High, infra) — the batch must not starve its own uplink

Four parts, one cause: bulk transfers were unbounded,
uncompressed, invisible, and concurrent. (A) Compress:
the screened archive is now `git archive
--format=tar.gz` (source trees compress several-fold;
twenty's 294MB becomes a fraction of itself), with the
quarantine member-check reading the gzip stream.
(B) Serialize: one in-process FIFO BulkTransferLimiter
per matrix batch, threaded through
DefaultDemoPipelineOptions, wraps each entry's
clone+archive and its sandbox archive upload so the
uplink carries one bulk transfer at a time — the
existing 30–60s launch stagger spreads control-plane
herds but not multi-minute transfers. (C) Size the
bound to the payload: fs.upload computes its
attemptTimeoutMs from the actual payload bytes (256KiB/s
worst-case floor plus headroom) whenever that exceeds
the 600s default, so a live large transfer is never
abandoned as a hang while true hangs keep the tight
bound. (D) See the failure: readGithubRepoSnapshot logs
`repo.clone.failed` with git's full stderr before
rethrowing, and the matrix report detail rides along
the message's last `fatal:`/`error:` line the way it
already rides `[makeademo:]` markers.

Landed (this session): all four parts with tests at
each seam — a real-git gzip test plus gunzipped
quarantine assertions, limiter FIFO/failure-release
unit tests plus seam tests proving the snapshot read
and the archive upload run inside the batch's one
limiter, a sparse-300MB upload test proving the scaled
attempt bound (and a small-payload test proving the
default is untouched), and clone-failure tests at both
the snapshot log and the report row.

### N135 (High, bugfix) — flow planning may only demand what the catalog can ground

The prompt and validator now share one groundability
predicate: a feature is groundable when the
ActionCatalog tags a visible assertion for it on a
route outside login/auth walls — the only per-feature
demand the validator enforces unconditionally (every
other FlowSpec rule is satisfiability-guarded).
Inferred flows must select exactly min(3, groundable
count) — at least one, three when possible — and record
each ungroundable inventory feature in a new
droppedFeatures field with a reason, so the concession
is auditable instead of silent. Zero groundable
features fails fast before any agent attempt, routed at
exploration/catalog quality ("repair App Exploration or
the ActionCatalog"), because no valid FlowSpec exists
and every attempt would be wasted. Maker-requested
features are untouched: an explicit request that cannot
be grounded must still fail loudly, never be silently
dropped. Validator messages name the groundable set and
the required count, so a wrong attempt's retry prompt
states the exact contract (the N131 lesson applied to
this seam). Contract version 2026-08-13.

Landed (this session): shared predicate module, schema
+ contract + validator + prompt updated together, with
tests for the grounded-two acceptance, the
three-feature rejection naming the count rule, the
missing-droppedFeatures rejection, and the
zero-groundable fast fail with zero attempts.

### N136 (High, bugfix) — a refused-loopback storm under a declared client stub is a delivery failure, not a feature failure

The explorer now converts a feature-observability
classification into "client stub not engaged" when the
run declared a client-stub rung and stderr shows
repeated ECONNREFUSED against loopback backends — the
signature of a stub that never engaged in the browser
bundle. The new classification routes to preparation
repair with full repo latitude (the gate is app
source), and its summary and hints name the delivery
contract: bundlers only expose allowlisted values to
browser code — for Vite, a VITE_-prefixed
import.meta.env variable or an explicit define. The
data-fixture playbook gains the same contract as step
7, so preparation stops writing gates the bundler
strips. Single refusals and provisioned-service runs
are never converted: a provisioned backend refusing
connections is a service problem, and one refusal is
noise.

Landed (this session): stderr conversion with positive
and both negative tests (provisioned-service rung and
single-refusal), repair routing test, and the playbook
step.

### Watchlist (no fix scheduled; re-check next matrix)

- N122(5) remains unanswered after three batches:
  calcom and ghostfolio have still never executed
  against real provisioned services. The rerun is the
  question.
- directus chose the client-stub rung for all three
  services despite the provisioned-service rung being
  available and preferred — if it recurs with N136's
  contract in place, the rung-steering prompts (N122(3))
  need revisiting.
- Carried: ghostfolio's retreat path has no build
  channel (root-level dist/ MODULE_NOT_FOUND gets no
  hint); twenty's client stub injected no data when
  reached; twenty's ENOSPC in /root/.makeademo-staging
  under repeated repair rounds.

### Rerun

All five entries. Expected trajectory: the clones and
uploads serialize through the batch limiter with
compressed archives — calcom and ghostfolio finally
reach Daytona and ask the N122(5) question; twenty's
archive upload fits comfortably inside one sized
attempt; homer plans two grounded features with
dark-mode recorded in droppedFeatures and proceeds to
capture; directus either engages the stub through a
bundler-visible gate or is steered to the
provisioned-service rung, and any dead gate that slips
through is named "client stub not engaged" on round
one instead of round five.

## Addendum (2026-08-14, wave-8 — homer green; the batch machinery held everywhere; four failures, each one layer deeper: N137–N140)

The 2026-08-14T03-07 batch: homer PASSED in 306s
(final video composited; three grounded features
selected, droppedFeatures empty). Every wave-7 fix
validated on its first exercise: both multi-GB clones
completed with zero exit-128s (N134 limiter + gzip —
calcom's archive 162MB, twenty's 294MB tar became
134MB and uploaded inside one ordinary attempt), the
N122(5) provisioned-Postgres rung executed for real on
three entries, N135's count rule was satisfied
normally, and N136 fired and was obeyed. The four
failures are new, deeper walls: a capture-stage race
with no repair path (calcom), an OOM-killed migration
hidden behind npm noise (twenty), N136's own blind
spot between "gate dead" and "gate live but partial"
(directus), and an asset-404 storm classified as empty
app state (ghostfolio).

### Diagnoses (2026-08-14T03-07)

homer — passed, 306s. Flow planning selected
service-tiles, operations-page, service-search — all
three groundable this round, droppedFeatures empty —
and capture and compositing ran clean.

calcom — five minutes from a final video; the N122(5)
acceptance question is ANSWERED YES. Provisioned
Postgres migrated and seeded via the repo's own
commands (`yarn workspace @calcom/prisma db-deploy` /
`db-seed`), preflight passed, DB-backed features
produced real browser evidence, the capture-path
dry-run passed. The terminal failure is a race in the
real continuous take: the script clicked "New
schedule" (which starts the app's own client-side
redirect) and immediately issued
`page.goto(/availability)`; the redirect aborted the
goto (net::ERR_ABORTED). The identical script passed
the dry-run fifteen minutes earlier — timing-dependent
by construction. Seam gap: a scene failure in the real
take goes straight to pipeline.failed; only the
dry-run routes to script-repair (→ N137).

twenty — provisioned Postgres booted and the declared
migration created schemas public/core and extensions
against the real service; then the migration's command
runner (a full NestJS bootstrap after SWC-compiling
7,314 files) was `Killed` at the sandbox's ~8GB memory
ceiling. That one-word fact is the literal last line
of the evidence; the failure summary headlined npm
config-warning noise instead, so six rounds (including
a detour through lifecycle-timeout and
lockfile-reconciliation install failures) never
addressed memory, and the run died at the 90-minute
deadline (→ N140).

directus — the N136 arc worked, then hit its own blind
spot. Rounds 1–4 fixed a Vite config crash, the predev
build, and an app-served 500 (the N117/N128 detector
caught it). Round 5 fired "client stub not engaged"
correctly. The round-6 repair obeyed the hint — gate
moved to VITE_MAKEADEMO_DEMO, read via
import.meta.env, declared in envUsed (which
guardedRuntimeEnv spreads into the app's process) —
and the stub partially engaged: screenshots show the
app chrome rendering "Directus Demo" from fixtures.
But uncovered endpoints still refused (12×
ECONNREFUSED 127.0.0.1:8055), an "owner not set"
onboarding modal blocked every route, and the target
route 404'd. Because refusals persisted, N136 fired
again with the now-false "the stub is dead code"
message and misdirected the final round; budget
exhausted (→ N138; modal and route on the watchlist).

ghostfolio — blank pages with the mechanism sitting in
the console evidence. Round 1 was an honest
provisioned-service seed failure (headline: the same
npm noise class as twenty — N140 applies), rounds 2–3
build failures, round 4 the known 404-mid-compile
readiness shape. Round 5 passed preflight, then
exploration found four routes serving their document
shell and rendering nothing: every asset request
doubles the locale prefix — /en/en/styles.css,
/en/en/chunk-*.js — all 404 (the Angular i18n build's
`<base href="/en/">` composing with the serve path),
so zero JavaScript loads. Classified
"empty/unmeaningful app state", which aimed repair at
data fixtures instead of the serve configuration
(→ N139).

### New items

### N137 (High, bugfix) — capture failures deserve the same repair path as validation failures

A scene failure during the real continuous take must
route through the bounded script-repair loop the
dry-run already uses (the N125 structured failedAction
machinery exists; the take should produce the same
failure shape), instead of ending the pipeline on the
first flake. Additionally, the script contract should
forbid the racy shape itself: a `goto` immediately
following a click that triggers client-side navigation
(require waitForURL or equivalent settling first) —
enforce at the static script validation seam so the
script is fixed before any take runs. Acceptance:
calcom's exact failure (click "New schedule" →
immediate goto aborted) either never validates or is
repaired and retaken within budget.

Landed: static validation now rejects an immediate
`goto` after a click proven to start client-side
navigation, continuous-take failures retain their
structured action identity, and the default pipeline
routes them through a bounded repair, full revalidation,
fresh reset, and retake.

### N138 (High, bugfix) — N136 must distinguish a dead gate from partial stub coverage

When the refused-loopback signature fires but the
probed routes rendered real content (exploration found
headings/controls, i.e. the stub demonstrably
delivered fixtures), reclassify as "client stub
partially engaged": name the refused request targets
(and paths where available from the runtime network
guard) so repair aims at the uncovered client seams,
not at delivery that already works. Keep routing to
repo-preparation-repair. The "dead code / delivery
channel" message fires only when routes rendered
nothing stub-shaped. Acceptance: directus round-6
evidence produces the partial-coverage classification
listing 127.0.0.1:8055, not the delivery message.

Landed: repeated refused-loopback evidence now records
both backend targets and proxy paths. Routes that
rendered headings or controls classify as
`client stub partially engaged` and steer repair toward
uncovered client seams; only hollow routes retain the
dead-gate diagnosis.

### N139 (High, bugfix) — a same-origin subresource-404 storm is a serve failure, not empty app state

Extend the N128 entry-chunk rule: when exploration's
console evidence shows the document's own styles and
script chunks 404ing (same-origin subresources), the
classification must become a serve/configuration
failure that names the failing asset path prefix —
including the doubled-prefix shape (/en/en/…) — never
"empty/unmeaningful app state". Acceptance:
ghostfolio's round-5 evidence classifies as a serve
failure whose message contains the /en/en/ prefix.

Landed: an already-failing exploration with a storm of
same-origin stylesheet/script 404s now reports an
`app server error`, names the common asset prefix (such
as `/en/en/`), and steers at document-base and serve-path
configuration instead of fixture content.

### N140 (High, bugfix) — surface the kill, not the epilogue, in service-command evidence

Provisioned-service migration/seed failure summaries
must headline the causal line — a trailing `Killed`,
`fatal:`, or nonzero-exit marker — not the npm
config-warning epilogue (the N130/N134-D lesson
applied to this seam). When the command was killed
(signal/OOM shape), say so and carry the
memory-ceiling hint (bounded NODE_OPTIONS
--max-old-space-size for the migration/seed command in
envUsed, prefer narrower targets); keep the
"service migration failure"/"service seed failure"
classifications and their preparation-repair routing so
the repair can actually bound the memory. Acceptance:
twenty's attempt-6 evidence produces a summary whose
first line names the Killed migration, and ghostfolio's
attempt-1 seed failure headlines its real error.

Landed: provisioned-service migration and seed reports
now headline the last causal `Killed`, `fatal:`, or
tool-authored nonzero-exit line ahead of warning noise.
Killed commands also carry bounded
`envUsed.NODE_OPTIONS --max-old-space-size` and
narrower-target guidance while retaining their existing
repair classifications.

### Watchlist (no fix scheduled; re-check next matrix)

- directus under a working stub: the "owner not set"
  onboarding modal blocks every route, and
  /admin/settings/data-model/+ 404s — fixture
  completeness (project-settings owner) and route
  coverage, visible only once N138 stops misdirecting.
- twenty's mid-run detour: automatic lockfile
  reconciliation failed in rounds 3–5 before the run
  returned to the migration wall — reconciliation
  robustness under berry.
- calcom absorbed one "features declare identical
  proofs" preparation-manifest rejection (round 1) —
  recovered, but worth watching for prompt drift.
- The capture dry-run passed a script the real take
  failed — beyond N137's repair path, dry-run/take
  parity may deserve its own look if recurrence shows.

### Rerun

All five entries after N137–N140 land. Expected:
calcom green (its only wall is the capture race);
twenty reaches a bounded migration or fails it with a
memory headline on round one; directus spends its
budget on stub coverage and the modal instead of
delivery; ghostfolio's serve-path fix gets named on
round one; homer stays green.

## Addendum (2026-08-14, wave-9 — ghostfolio's first video; N139 validated on its first exercise; a rule contradiction, a word-only stub, and a sandbox twenty outgrew: N141–N146)

The 2026-08-14T05-59 batch: TWO passes. homer green
again (655s), and ghostfolio produced its FIRST final
video (2,855s) — N139 fired on round 3 exactly as
specified ("App server error: 13 of the document's own
stylesheet/script assets returned HTTP 404 under…"),
round 4 fixed the serve path, and capture plus
compositing ran clean. The batch machinery held
end-to-end for the third consecutive run: no infra
casualties, all five entries ran their full course.
The three failures are each a different lesson: calcom
died in a contradiction between the new N137 static
rule and the catalog-conformance rule (the remedy the
first prescribes, the second forbids); directus
regressed onto a repair path that declared stubs in
words while shipping none, and fidelity took it at its
word; twenty never even reached last wave's migration
wall — it hit the sandbox's 8GiB memory ceiling and
10GiB disk during install and build, with every causal
line hidden by summarizer defects.

Wave-8 item scorecard: N139 VALIDATED (ghostfolio
passed). N137's static rule fired correctly on calcom
but its prescribed remedy is unsatisfiable (new
finding, → N141); its take-repair path was never
reached. N138 and N140 were not exercised — directus
failed before exploration, twenty before any service
command.

### Diagnoses (2026-08-14T05-59)

homer — passed, 655s (slower than wave-8's 306s, same
shape: three groundable features, clean capture).

ghostfolio — passed, 2,855s. Rounds 1–2 were dev-server
connect failures during compile, round 3 fired the new
N139 serve-failure classification naming the doubled
locale prefix, round 4 repaired the serve
configuration and every feature grounded, rounds 4–5
passed. First ghostfolio final video.

calcom — deepest run yet, killed by two rules that
contradict each other. Preflight passed (three
"requested feature not observable" rounds, then
green). But exploration's session degraded: the
catalog records that clicking "Apps" and "New" on
/availability landed on /auth/login (the explorer's
own login attempt also failed — clicking Continue
before hydration self-submitted the form as a native
GET, leaving csrfToken and empty email/password in the
URL). Flow planning nonetheless grounded
weekly-availability-event-duration on
click-interaction-3-2 — a click whose only observed
outcome is the auth wall — and coverage enforcement
then REQUIRED the script to contain it. Static
validation attempt 3: the N137 rule fired (goto after
a navigation-starting click) and suggested "an
assert-url action compiled to waitForURL". The repair
obeyed, adding assert-url confirm-new-navigation.
Attempt 4: the kind-conformance rule rejected it —
compatibleCatalogKinds("assert-url") is ["assert"],
and the only catalog entry carrying the observed
destination is the click itself (kind "click"); an
assert-url also requires action.path to equal its
source entry's route. The prescribed remedy is
structurally unexpressible; three script-repairs
ping-ponged between the two rules and exhausted the
budget without a take ever running (→ N141, N142).

directus — a nondeterministic repair path regressed
below wave-8's high-water mark. This round's
preparation abandoned stub delivery entirely: envUsed
carries only NODE_ENV (no VITE_MAKEADEMO_DEMO gate),
mocksAndFixturesAdded and localDemoModeChanges are
empty, all three dataStrategy rungs are
"declared-stub" whose own detail text admits "no
…-backed local fixture adapter was added", and
knownLimitations states data-backed routes require a
separately configured Directus API. Fidelity PASSED
this word-only manifest six times ("Prepared runtime
preserves the screened product application") — the
N122(2) enforcement checks that a legal rung is
declared, not that anything backs it. Rounds 1–5 were
spent untangling self-inflicted Vite config and module
errors (@directus/extensions unbuilt under the
filtered install; the predev build of 19 workspace
packages blew the readiness budget as round 5's
"listen failure"). Round 6: the app finally bound, and
the readiness curl of the first featureInventory
entryPath /settings/data-model/+ was proxied by the
Vite dev server to the absent API at 127.0.0.1:8055 —
HTTP 502, classified "build failure" (the app had
built and bound). Budget exhausted; N136/N138 never
ran because the failure precedes exploration
(→ N143, N144).

twenty — never reached the migration wall; died
shallower, against the sandbox itself, with every
causal line buried. Attempts 1 and 4: build failure —
the real cause is ERR_MODULE_NOT_FOUND for
/workspace/repo/node_modules/twenty-shared/dist/vite.mjs
(twenty-front's vite.config.ts imports a workspace
dependency nobody built), but the summary headlined an
ANSI-mangled code-frame fragment (";5;249meta_url =
…") — the excerpt slicer cut mid-escape-sequence and
never surfaced the causal line. Attempts 2 and 5:
network-closed lifecycle deadline (exit 124); the
excerpt is six IDENTICAL yarn RequestError/ECONNREFUSED
stacks (yarn reaching for the registry inside the
network-closed phase — the cache/lockfile was never
reconciled while the network was open), and buried
mid-excerpt sits the actual kill: "1726 Killed — yarn
rebuild" (OOM again), followed by a failed npm exec
vite build; the canned "Everything in the output below
completed successfully" framing is factually false for
this window. Attempt 3: ENOSPC — yarn's cache copy
died on the 10GiB disk (the [makeademo:disk] marker
shows 69% used AFTER failure cleanup; the peak hit
100%), and [makeademo:mem] peak-bytes reads within
kilobytes of exactly 8GiB in BOTH the deps and build
phases — the cgroup ceiling is being slammed, not
approached. Verdict: twenty does not fit the current
sandbox class, and the evidence layer hid it
(→ N145, N146).

### New items

### N141 (High, bugfix) — a static rule must not prescribe a remedy another rule forbids

Make the goto-after-click settle requirement
satisfiable. Either (a) permit an assert-url to ground
on a click catalog entry when the click's observed
navigation destination equals the assert-url path
(extend compatibleCatalogKinds/route agreement for
exactly this pairing), or (b) compile the settle into
the click itself — a click with observed client-side
navigation emits waitForURL(destination) in the
capture runtime, and the static rule stops firing on a
click that self-settles. Prefer (b) if capture-side
compilation is tractable: it removes the repair
round-trip entirely. Acceptance: calcom's exact
attempt-3 script shape (click-interaction-3-2 followed
by goto) either validates after one repair that the
conformance rule accepts, or never fires the rule
because the click self-settles.

### N142 (High, bugfix) — a click observed to land on an auth wall grounds nothing

Extend N135's groundability to interactions: a catalog
click whose observed navigation destination matches
the auth-wall route shape (/auth/login, /login,
/signin equivalents — the same predicate N135 applies
to routes) is auth-degraded evidence. Flow planning
must not reference it in a feature's
referencedActionIds, a feature left with no groundable
interaction drops (droppedFeatures, N135's count rule
then selects from the remainder), and coverage
enforcement therefore never forces a doomed click into
the script. Acceptance: calcom's wave-9 catalog
(click-interaction-3-2, expectedResult "/auth/login
became visible") produces a FlowSpec that does not
reference that click, and
weekly-availability-event-duration is either grounded
on other evidence or dropped with the reason recorded.

### N143 (High, bugfix) — a stub declared in words must show its mechanism

Fidelity must reject a dataStrategy rung whose claim
has no backing in the same manifest. A client-stub or
declared-stub rung requires delivery evidence: a
non-empty mocksAndFixturesAdded or
localDemoModeChanges entry, or a delivery gate in
envUsed (the N136 contract); a declared-stub rung
whose own detail text describes the absence of a
mechanism ("no fixture adapter was added") fails with
a message naming the rung, the service, and the
missing mechanism. This is a deterministic structural
check at the manifest validation seam — it costs no
agent round. Acceptance: directus's wave-9 manifest
(three declared-stub rungs, empty
mocksAndFixturesAdded, no env gate) fails fidelity on
round 1 with the stub-without-mechanism message
instead of passing six times.

### N144 (Medium, bugfix) — a 5xx from a bound app is a serve failure at the readiness seam too

Extend the N128/N139 family to the readiness probe:
when the app command is alive and the readiness curl
of the entry route returns 5xx, classify as a
serve/backend failure that names the probed route and
the status — never "build failure" (the app built) or
"listen failure" (it bound). When the runtime is a dev
server known to proxy unmatched routes, say so: the
directus shape is a 502 minted by the Vite proxy for a
route whose backend does not exist. Acceptance:
directus's wave-9 attempt-6 evidence (app running,
probe 502 on /settings/data-model/+) classifies as a
serve/backend failure naming the route, steering
repair at data delivery rather than the build.

### N145 (High, bugfix) — every failure summary headlines its causal line, in clean text, once

Apply the N130/N140 causal-headline rule to the
remaining summarizers — lifecycle-timeout and
submitted-code build/install — and fix the excerpt
hygiene defects wave-9 exposed: (1) strip ANSI escape
sequences before any slicing (attempts 1/4 headlined
";5;249meta_url…", a fragment of an escape code); (2)
headline the trailing causal line — Killed, fatal:,
ERR_MODULE_NOT_FOUND, nonzero tool exit — when the
killed window contains one, and drop the "Everything
in the output below completed successfully" framing
whenever the window contains a kill or nonzero exit
(twenty's attempt-5 buried "1726 Killed — yarn
rebuild" beneath that exact false claim); (3) collapse
repeated identical error blocks (six copies of the
same yarn RequestError stack crowded out the kill
line) to one instance with a repeat count. Acceptance:
twenty's attempt-1 evidence summarizes with
ERR_MODULE_NOT_FOUND naming twenty-shared/dist/vite.mjs
on its first line; attempt-5 summarizes with the
Killed yarn rebuild line first and the ECONNREFUSED
storm deduplicated with its count.

### N146 (High, infra) — right-size the sandbox for repos that measure it

twenty slammed the 8GiB memory ceiling in both the
deps and build phases and filled the 10GiB disk
mid-install; no summarizer fix makes it fit. Two
parts: (1) a larger sandbox class for heavyweight
repos, selected deterministically from the repo
profile the harness already computes (archive size,
workspace count) before the first lifecycle run — the
Daytona quota can absorb fewer, larger sandboxes for
flagged entries; (2) purge the harness staging
directory (the TMPDIR the sandbox points at
/root/.makeademo-staging — yarn's xfs-* temp dirs land
there and survive killed attempts) between lifecycle
attempts, so six repair rounds do not compound the
disk debt. Acceptance: twenty's install and build
complete without ENOSPC or an OOM kill, or fail with a
summary whose first line names the resource that
remains short.

### Watchlist (no fix scheduled; re-check next matrix)

- Script-repair has no ping-pong breaker: two static
  rules alternated for three rounds without the loop
  noticing (N125 built one for the validation loop).
  N141/N142 remove this instance; if a new rule pair
  recurs, the breaker generalizes.
- calcom exploration login robustness: the explorer
  clicked Continue before hydration and the form
  self-submitted as a native GET. Filling credentials
  and awaiting hydration/network-idle before submit
  would keep the session evidence clean at the source.
- twenty unbuilt-workspace-dependency hint: N145 makes
  the causal line visible; if repair still cannot act
  on it, a targeted hint naming the package to build
  first earns an item.
- Carried from wave-8, still unobserved (failures now
  occur earlier): the directus "owner not set"
  onboarding modal and /admin/settings/data-model/+
  route coverage; dry-run/take parity.
- twenty lockfile reconciliation under berry recurred
  (registry fetches inside the network-closed phase) —
  N145's evidence fix plus N146's headroom should
  expose whether reconciliation itself still fails.

### Rerun

All five entries after N141–N146 land. Expected: homer
and ghostfolio stay green; calcom produces a statically
valid script (no rule contradiction) and finally
exercises N137's take-repair path if a race recurs;
directus bounces the word-only stub at fidelity round 1
and re-treads the wave-8 stub arc into N138's
partial-coverage classification; twenty clears install
and build inside the larger class — or fails with the
resource or the unbuilt dependency named on line one —
and meets last wave's migration wall with N140 armed.

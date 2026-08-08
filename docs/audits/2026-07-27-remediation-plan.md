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

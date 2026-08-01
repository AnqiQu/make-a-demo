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

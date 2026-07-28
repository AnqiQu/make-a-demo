# Pipeline Audit — 2026-07-27

Read-only, end-to-end audit of the MakeADemo pipeline against its intended behavior and invariants
(see `CONTEXT.md`, `docs/adr/0020-use-artifact-driven-agent-harness.md`).

**Method.** Read all governing docs (root/nested `AGENTS.md`, `CONTEXT.md`, ADR-0020, PRDs), traced the
pipeline from `runDefaultDemoPipeline` through compositing, analyzed all 20 runs under
`.makeademo-terminal-runs`, and ran nine parallel deep-dives over every seam (several executed the real
modules against adversarial inputs). Findings marked **✓** were re-verified firsthand at the cited lines;
the rest were verified by code-read or by module execution during the deep-dives. The audit covers the
working tree as of this date, **including uncommitted changes** on `anqi-dev` (notably the in-progress
fidelity/harness diff). Nothing was modified.

> Line numbers reference the working tree at audit time and will drift; symbol names are the stable
> anchors.

---

## Where the pipeline actually stands

- **The architecture matches the ADR and works end-to-end** — the 07-17 run
  (`.makeademo-terminal-runs/terminal-2026-07-17T22-23-56-558Z`) produced a real 8-scene
  `final-video.mp4`. Artifact-driven handoffs, two-sandbox separation, typed actions instead of agent
  Playwright, and DNS-pinned controller fetches are all genuinely implemented.
- **Operationally it fails ~90% of the time on the only repo it has ever been run against** (all 20 runs
  are Midday; 1 success in the last 12). The dominant failure is not provider flakiness — it is a
  systemic loop: *exploration fails for the wrong reasons → misrouted to preparation repair → the repair
  agent's edits trip the fidelity validator → repair budget burns → the terminal error masks all of it.*
  The 07-25 run is a complete specimen: 20s `goto` timeouts against a dev server whose first compile the
  pipeline's own probe measured at 26.5s, classified "browser console/page error", three repair rounds,
  fidelity rejecting the repair agent's `bun.lock`/`layout.tsx` edits, an 11-minute unlogged gap, and a
  final recorded failure of literally `Request failed with status code 502`.
- **Generality is unproven** and several heuristics are Midday/Turborepo-shaped (`apps/<name>` regexes,
  `build:<name>` script conventions, Next-specific console filters).

**Verdict: structurally close, operationally far.** Two systemic fixes (exploration failure semantics,
fidelity calibration) would likely make Midday reliable; a further set of selection/contract fixes is
needed before arbitrary repos work.

## Cross-cutting root causes

Five patterns generate most of the individual bugs:

1. **In-band protocols without authenticity** — exit codes, network attempts, capture markers, and
   exploration results all travel through stdout/stderr that untrusted code (or the agent) also writes to.
2. **Content-sniffing instead of typed dispatch** — fidelity rules, repair routing, legacy-script
   detection, and "humanization" all regex over text (patches, logs, generated source) when typed data
   was available.
3. **Two hand-written encodings of one contract** — schema-shown-to-agent vs reader, JSON Schema vs
   parser, permission table vs prompt paths, RunPlan vs resolver. Each pair has already drifted.
4. **Provider/cleanup errors replacing semantic failures** — unguarded `await`s in `catch`/`finally`
   blocks.
5. **Validators tuned adversarially against the repair agent but not against reality** — strict on
   legitimate prep (config edits, lockfiles), bypassable by actual adversaries.

---

## Critical

### C1. The fidelity validator fails both directions, and the working tree made it worse ✓

- *Bypasses (verified by executing the validator):* a created, seam-named entrypoint
  (`src/services/demo-entry.ts` + package.json script redirect) replaces the whole product and
  **passes** — `preparation-fidelity.ts:167` exempts any `isDemoSeamPath` name
  (`services|api|db|config|...`). The demo gate is satisfied by a *comment* or by the generic `env`
  identifier harvested repo-globally (`:434-477`). Created files (e.g. a new `middleware.ts` or
  `.env.local` with `AUTH_DISABLED=true`) skip gate checks entirely. A fake `diff --git` header inside
  added content masks rules (`indexOf` patch lookup, `:512-520`).
- *Regression ✓:* the uncommitted diff **deleted `preservesNonDemoBehavior`** with no replacement —
  removing a production auth guard outright now passes as long as some conditional mentions the gate.
  The test named "rejects a demo flag declared beside a destructive authentication guard change" passes
  for a different reason than its name.
- *False positives ✓ (the observed failure mode):* `isDemoSeamPath` matches `configs?`, so editing
  `vite.config.ts`/`next.config.js` — the single most common legit prep edit, explicitly authorized by
  the prompt — now **fails** fidelity (`preparation-fidelity.ts:322`, `:404-409`). CSS `url()` without
  quotes fails asset-localization. And each fidelity failure triggers `materializeScreenedRepo` — **all
  preparation work discarded and rebuilt from scratch**, up to 5 times
  (`default-harness-dependencies.ts:2801`). This is the fidelity-vs-repair war in the run logs
  (bun.lock, `layout.tsx` rejections on 07-18/19/25).
- *Breadth:* every repo. *Smallest fixes:* drop the seam-name exemption for created start-path files;
  strip comments + bind gate identifiers to the patched file; restore removed-line reconciliation;
  exempt framework config files from the gate requirement; parse the patch once into a line-anchored map.

### C2. App exploration fails whole runs for unrelated noise and misroutes the repair ✓

Any page error or actionable console error anywhere in the crawl fails the entire exploration
(`submitted-app-explorer.ts:711-716`); crawl-navigation failures are pushed into `pageErrors` (`:1299`);
the only noise tolerance is a two-token Next.js-specific regex (`:796-800`). The 20s `goto` timeout
(`:1082`) is below dev-server first-compile latency the preflight probe itself measured (26.5s, run
07-25 preflight attempt-3). This directly violates "exploration should not fail merely because unrelated
areas are unavailable", and the failure routes to *preparation* repair, which starts the C1 war.
Additionally exit-code≠0 / unparseable stdout are terminal context-free throws that discard the JSON
payload even when present (`:154`, `:938`), and the single-line unterminated stdout protocol (`:1306`)
breaks on any trailing bytes.

*Smallest fixes:* scope the error gate to feature-tagged routes that produced no evidence; separate
`unreachableRoutes` from `pageErrors`; raise/goto-retry the navigation timeout (or warm routes first);
emit the result from a `finally` with a marker-prefixed line + file fallback; convert explorer process
failures into repairable reports.

### C3. Committed secrets ship into both sandboxes for common file shapes ✓

Quarantine matches basename prefix `.env` only (`secret-quarantine.ts:76`): `.envrc`, `prod.env`,
`.npmrc` (`_authToken`), `.netrc`, `.pgpass`, `*.tfvars` all ship verbatim in `screened-repo.tar` —
contradicting ADR-0020's "removed from the screened execution archive". The `git archive` exclusion
mechanism — the only code that actually removes secrets — has **zero test coverage and no
post-condition check** (every test stubs it). Meanwhile the screen's own secret rejections are
unreachable in production (quarantine always runs first), and a `package.json` >128 KiB silently skips
script screening with no "unscanned" state (`repo-snapshot.ts:285`).

*Smallest fixes:* one shared predicate module (the `.env` check currently exists in 4 places with
drift); content-based env-file fallback; enumerate tar members post-archive and throw if any excluded
path is present; treat unscanned `package.json` as rejection.

### C4. The dependency-install window runs untrusted lifecycle scripts with full egress, and the reseal can fail open ✓

The gate allowlists command *shape* but never requires `--ignore-scripts`
(`dependency-install-gate.ts:12-46`) while `updateNetworkSettings({networkBlockAll:false})` opens the
**whole sandbox**, not registries. `preinstall`/`postinstall` from the submitted repo and all transitive
deps run with open egress — the ADR's "allowlisted package-manager install window" doesn't deliver its
property. The reseal is an unguarded `await` in `finally` (`:82-84`): a Daytona 502 on close replaces
the install result *and* leaves the network open; the provider's close-error swallow logs
`runtime-locked` transitions it never confirmed (`daytona-sdk-preparation-workspace-provider.ts:924-937`).

*Smallest fixes:* append the script-suppressing flag per manager when absent; retry-and-verify the close
(read back settings); attach close failures as secondary causes.

### C5. Provider failures mask semantic outcomes; a finished demo can be reported as failure ✓

- Infra errors (`AgentHarnessSandboxUnavailableError`, timeouts) in workspace reset/app start are
  swallowed into a `failed` validation report (`default-harness-dependencies.ts:1904`, `:2115`) → routed
  to `"fail"` → wrapped into a **Preparation Fallback that blames the maker's repo for a Daytona
  outage**, with zero retry. (The sibling path at `:2045` does the right thing — rethrow.)
- On the success path, a cleanup failure **discards `completedResult`** — video rendered, pipeline
  reports failure (`default-demo-pipeline.ts:295-300`). The mirrored block in
  `agent-harness.ts:999-1001` is unreachable dead code with the opposite defect (silent swallow).
- `"transient infrastructure failure"` is classified but mapped to `"fail"` — the retry policy the ADR
  describes for it doesn't exist (`repair-router.ts:51-58`). One transfer blip after four successful
  agent stages kills the run.
- This is exactly the 07-25 run's ending: fallback written, then a raw `502` recorded as the failure
  with an 11-minute unlogged gap, sandbox log collection timing out (5s budget for a `cat` of the whole
  log, made worse by per-line O(n²) mirroring), and cleanup racing "Sandbox state change in progress".

*Smallest fixes:* rethrow infra errors at `:1904`/`:2115`; return `completedResult` and attach cleanup
failure when primary is undefined; add a small transient-retry budget; give log collection its own
scaled budget.

### C6. Monorepo target selection can start the wrong app or the whole repo (verified by execution)

- Root-script matching uses raw substring `command.includes(name)` ✓
  (`runtime-target-resolution.ts:477-481`): selecting `@a/web` runs `dev:web-admin` — silently demoing a
  different app.
- Zero detected browser candidates (evidence gated on a hardcoded `app|pages|routes|screens|src|views`
  dir allowlist) silently degrades to `appDir: "."` and the root orchestrator — `turbo dev --parallel`,
  every workspace, contradicting the ADR.
- Lockfiles are sorted lexicographically and the first match wins over the `packageManager` declaration ✓
  (`repo-profiler.ts:78`): a stale `package-lock.json` beats `pnpm-lock.yaml` → `npm ci` against a pnpm
  workspace fails at install.
- `isWithin(path, ".")` is unconditionally true ✓ (`prepared-feature-inventory.ts:151`): any repo with a
  runnable root app plus a second package makes `assertPreparationRuntimeTarget` throw **unrecoverably
  on every repair attempt**.

*Smallest fixes:* token-delimited name matching; fail with `RuntimeTargetSelectionRequiredError` instead
of defaulting to `"."`; precedence = `packageManager` field → single lockfile → declaration; one-line
`isWithin` ownership fix.

### C7. Legitimate demos are structurally unrepairable when maker text trips the placeholder scan ✓

`placeholderPattern` (`TODO|FIXME|example.com|placeholder|...`) runs over the **entire** script JSON
(`demo-script-contract.ts:40`), while demo-narrative **requires** each feature-intro scene to equal the
maker's feature label verbatim ✓ (`demo-narrative.ts:87-92`). A maker submitting "Add a TODO" or a
`user@example.com` fixture produces a script that *must* contain the banned token → script-repair loop
that cannot succeed → job fails. Todo apps are one of the most common demo shapes.

*Smallest fix:* scope the scan to agent-authored free-text fields only.

---

## High

### H1. In-band protocol trust (theme)

The submitted app's stdout is trusted as: the controller's fetch queue ✓ (`[makeademo:network-blocked]`
anywhere in any line → backend fetches attacker-chosen public URLs, fills the 512 MiB cache —
`runtime-network-guard.ts:303-341`); the exit-code source ✓ (`__MAKEADEMO_EXIT__:(\d+)` —
**first**-match, so agent/app text can forge success/failure,
`daytona-sdk-preparation-workspace-provider.ts:1481`); capture/validation markers (no nonce; a forged
`screenshotPath` in a failure marker is passed unvalidated to `downloadSubmittedCodeFiles` — pulls an
arbitrary sandbox file to the backend host). One fix pattern: per-run random nonce in every marker +
last-match sentinel + path prefix assertion.

### H2. Replay integrity is asymmetric

The Node-side guard hash-verifies every replayed file; the **browser** replay never checks
`sha256`/`sizeBytes` (`browser-runtime-network-policy.ts:69-97`) and the replay root is app-writable.
Replay is also keyed by URL only, with no resource-type binding and no `nosniff` header — bytes admitted
as an *image* can later be loaded as a *script*, breaking the determinism guarantee the cache exists for.

### H3. Local-path guard bypass (verified by execution)

`^(?:/(?!/)|#|\?).*$` blocks `//evil.com` but not `/\evil.com` (WHATWG treats `\` as `/`) — compiles to
`page.goto` resolving to `http://evil.com/` (`browser-action-plan.ts:118`). `goto` has a second
grounding layer but `assert-url` has none. Fix: resolve against `baseUrl` and compare origins instead of
regexing.

### H4. Generated-code rewriting defeats the validation stack (verified by execution)

`stylizeBrowserActions` re-parses compiled Playwright with greedy line regexes; a fill value containing
`.fill(`/`);` re-partitions the statement into a *different but valid* program — and `tsc` validation
runs on the **pre-stylized** source while the **post-stylized** file executes
(`stylized-playwright-script.ts:218-256`, `capture-sdk-contract.ts:253`). Also
`script.includes("chromium.launch")` content-sniffing can silently strip the whole harness. Fix: emit
humanized calls directly from `compileAction`; delete the stylizer and both sniffs.

### H5. Read-only/fidelity boundaries ignore gitignored paths ✓

Both the script-writing boundary and the preparation diff use `git ls-files -co --exclude-standard` /
gitignore-respecting `git add` (`default-harness-dependencies.ts:2775`, `:2835`) — an agent can write to
`dist/`, `.env.local`, `.next/`, any ignored path, invisibly to every rule. The `.makeademo` allowlist
in `read-only-boundary.ts:1-6` is dead code; enforcement itself is skipped when the optional dependency
is absent — as is the entire fidelity stage (`capturePreparationWorkspaceDiff` optional, silently
skipped) and feature-inventory assertion (only called inside one dependency implementation, not the
orchestrator).

### H6. Agent-stage loop pathologies

Unbounded OpenCode TUI transcripts embedded in retry prompts ✓ (6 sites,
`${result.stderr || result.stdout}` where stderr is always empty — token runaway); prompts delivered as
PTY keyboard input subject to ~4 KB `MAX_CANON` per line while single-line JSON dumps
(`Repo profile: ${JSON.stringify(...)}`) have no cap; timeouts handled in only 1 of 6 stage loops (hung
sessions reused, budgets burned); artifact-vs-exit-code precedence inverted in 5 of 6 loops (a valid
artifact written just before a crash is discarded); **no job-level wall-clock or token budget
anywhere** — worst case 7+ hours of paid agent time. `--dangerously-skip-permissions` is passed
alongside the deny-by-default permission table ✓ with no test proving the table still binds.

### H7. Exploration evidence quality

Feature grounding is trivially satisfiable (feature IDs inherited across crawl hops; the always-emitted
`navigate` action counts as the "non-assert" evidence — loading a page marks a feature demonstrated).
Route dedup keys on pre-redirect URLs (duplicate routes, colliding screenshots); budget is effectively 6
routes; `matchCount !== 1` silently discards a route's only locator evidence; SPA/iframe apps yield
near-empty catalogs that still pass; auth-wall heuristic has both FPs (marketing page + footer "Continue
with Google") and the ADR-mandated same-route-login FN.

### H8. Preflight/runtime probes

40s total port-bind tolerance (10×`curl` with 2s waits) vs 60–120s cold monorepo dev servers;
`"listen failure"` is not in the preparation classification list → routes through a stderr-keyword
lottery ✓; install/build inherit the implicit 10-min provider default; the 07-24 run's contradiction
("did not respond… exited with code 0" while the log shows `✓ Ready in 323ms`) comes from this
probe/reporting seam.

### H9. Capture stage fragility ✓

On any capture failure, `rm -rf runDirectory` deletes `stdout.log`, `scene-markers.jsonl`, the runtime
log — all evidence (`capture-scenes.ts:168-173`). Re-capture in one run is impossible
(`mkdir {recursive:false}` + fixed `runId: "capture"` → `EEXIST`; stale Playwright videos → "found 2"),
so the ADR's re-record-after-review path is unreachable. Missing exit code from the sandbox maps to
`?? 0` = success. Full app stdout flows untruncated into the Project record via `markProjectFailed`.

---

## Medium (condensed)

- **Repair routing by regex over untrusted logs:** `logsSummary` embeds full app stderr;
  `/locator|assert|network|auth/i` keyword matches steer script-vs-preparation routing; two classifiers
  order the keywords differently. Require typed classifications; route `unclassified` to fail explicitly.
- **Unreplayable browser resources during capture-path validation** get no `failureClassification` →
  `"harness/internal failure"` → terminal, while the identical runtime condition routes to preparation
  repair. One missing field.
- **Repeated-failure fingerprint** normalizes only timestamps/UUIDs/durations — stderr paths/ports
  defeat it, disabling the repeat-limit of 2 and burning all 5 repairs; install-scope expansion consumes
  no budget and its trigger classification (`"missing dependency"`) isn't in its accepted list, so the
  deterministic expansion path is mostly unreachable.
- **`findBuildScopeViolation` is Midday-shaped** ✓ (`/apps\/([^/]+)\//` + `build:<name>` convention) and
  duplicates `runtime-target-resolution`'s generic ownership; delete it.
- **Port/build detection:** `--port=`/`PORT=` forms unparsed; `baseUrl` uses min-port across all
  scripts, not the selected script's; `"serve -s dist"` treated as a dev server (no build); `bun build`
  emitted as a build command (invokes Bun's bundler). One shared port/command extractor fixes the class.
- **Contract drift pairs:** agent-facing manifest schema looser than the reader on 5 fields (each
  mismatch = a full repair round-trip); demo-narrative silently deletes agent-authored synthetic scenes
  that the published schema and examples advertise; `contractVersion` on the manifest is never read;
  JSON-Schema-vs-parser drift in demo-script (`actions`/`featureId` required vs optional).
- **Security-screen over-blocking ✓:** `/rm\s+-rf\s+\//` rejects `rm -rf /tmp/cache`;
  `/mkfs|forkbomb|crypto.?miner/` unanchored (`cryptoMiner.spec.ts` kills a repo); "no package.json" is
  a terminal *security* rejection satisfied by vendored `node_modules`. Snapshot walks
  `node_modules`/`dist` with no byte budget; clone has no filter/timeout.
- **Sandbox lifecycle:** create-retry can leak an agent sandbox that never auto-stops; compensating
  deletes are unguarded `await`s replacing root causes; `onStderr` declared at the seam but never
  invoked (agent-failure stderr evidence permanently empty); Daytona conflict-class errors ("state
  change in progress") unhandled.
- **Fidelity/inventory observability:** constant 3-hint `suggestedRepairHints` regardless of violation;
  `retryCount` hardcoded 0; requested-feature "exact text" invariant only normalized-compared;
  `authStrategy` never cross-checked against the diff.
- **Explorer inputs mutate app state** (fills password/email fields, clicks "Sign in"/"Publish"-class
  buttons under a small denylist); feature entry paths from the manifest aren't origin-checked before
  `page.goto`.
- **Capture budget mismatch:** 210s script timeout derived from a limit that excludes browser scenes;
  humanization (~0.5s/click, 100ms/char) runs during *validation* too — long feature sets time out
  through no fault of the script.
- **Secret-redaction gap:** agent stdout excerpts flow into JSONL logs, error messages, and the
  maker-facing fallback prompt with only path-based Pino redaction; a content redactor already exists in
  `json-artifact-diagnostic.ts` but is wired to one path.

## Low

Prototype-chain lookups in compositing asset/font checks (`Object.hasOwn`); no port restriction on
controller fetches; `TypeError` special-case aborts whole hydration pass; hydration buffers up to
~768 MiB resident vs 512 MiB cache cap; screenshot slug collisions; GitHub URL validator misses ports
and encoded dot-segments; private-key detector misses PGP/PuTTY/`.p8`/`.jks`; quarantined paths still
advertised to the agent as readable evidence (burns repair iterations); no `locale`/`timeZoneId` on
explorer context (nondeterministic text evidence); profiler is O(files×candidates×packages) synchronous
on the event loop (8s at 73k files/900 pkgs).

---

## Deletion / consolidation candidates

| Candidate | Size / evidence |
|---|---|
| `DefaultPlaywrightSceneRecorder` + helpers + its test file ✓ | ~430 source + 729 test lines; only referenced by its own test; production path explicitly forbids local capture |
| Legacy `demoPlaywrightScript` surface (schema field, contract checks, `chromium.launch` sniffs, `capture-scenes` passthrough) | ~190 lines across 4 files; removal also deletes H4's sniff and part of the string-literal false positives; note `captureScenesFromScript({scriptPath})` is a live disk-file→arbitrary-Playwright path today |
| Six near-identical agent-stage retry loops → one `runAgentArtifactStage` | ~300 lines; fixes H6's timeout/precedence/fingerprint inconsistencies *by construction* |
| Duplicated stage→artifact-path tables (runner permissions vs prompts vs orchestrator vs inline strings) | 4 encodings; drift = least-diagnosable failure mode |
| Secret predicates (`.env`/private-key) in 4 files → one module | fixes C3's drift class |
| Warning half of `static-repo-security.ts` (all warnings discarded; profiler recomputes them) | plus its unreachable secret rejections |
| `workspace.interface.ts`: `getPreviewUrl`, `downloadFiles` (zero production callers), `cancelActiveCommands` (make private), 20-of-22 members needlessly optional → ~a dozen hand-rolled guard blocks | plus `submitted-code-execution.ts` (16-line pass-through duplicated verbatim) and its tautological test |
| `findBuildScopeViolation`; explorer's `createRouteLocatorCandidates` (invalid selector dialect, no consumer); AppMap top-level flattening (doubles artifact size, no server reader) | |
| `approved-fonts.ts`/`approved-music.ts` (triplicate data), `mergeRuntimeMarkers`, `readSuccessfulCaptureProtocol` twin, `qualityFindings` (always `[]`), byte-identical `readSceneCallbackSource`/`escapeRegExp`/`shellQuote`/`normalizeFeature` copies, `terminal-demo-runner` pass-through, 6 unreachable "retry loop exited early" throws, dead `read-only-boundary` allowlist, `contractVersion`, unused font files | |

## Test-suite assessment

~27k test lines, nearly 1:1 with source, `knip` clean — yet the highest-risk seams have zero or
synthetic coverage: the `git archive` secret exclusion (all stubs), the real OpenCode binary (permission
table + `--dangerously-skip-permissions` interaction untested), the 350-line generated explorer script
(asserted by substring-matching its own source), SSRF redirect handling (the redirect test injects a
fake fetcher that bypasses every control), and marker/injection adversarial cases (none anywhere).
Several tests assert behavior that cannot occur in production (screen secret rejections, `.env.local` in
the read-only boundary) or pass for reasons other than their names claim (the fidelity "destructive auth
change" test). The best-tested module in capture is the dead one. Pattern: strong artifact-semantics
coverage, systematic mocking-away of exactly the boundaries the ADR calls load-bearing.

## Prioritized minimal plan

1. **Stop the failure spiral** — exploration: scoped error gate, `unreachableRoutes` split, realistic
   goto budget, `finally`-emitted marker protocol. Fidelity: exempt framework config files, restore
   `preservesNonDemoBehavior`, per-violation hints, stop full-workspace rebuild on fidelity failure.
   (Fixes most observed run failures.)
2. **Failure transparency** — rethrow infra errors at the two swallow sites; return `completedResult`
   despite cleanup failure; transient-retry budget for `"transient infrastructure failure"`; add
   `"listen failure"` to preparation classifications; scaled log-collection budget. (~40 lines total.)
3. **Security holes** — unified secret predicates + tar post-condition check + real-git integration
   test; require `--ignore-scripts`; verify network reseal; per-run nonce for all three in-band
   protocols; browser-replay hash + resource-type binding; resolve-and-compare local paths.
4. **Monorepo generality** — token-delimited script matching, fail-closed on zero candidates,
   `packageManager` precedence, `isWithin(".")` fix, shared port extractor. Then validate with runs on
   2–3 non-Midday repos.
5. **Contract convergence** — propagate reader constraints into the agent-facing schemas; scope the
   placeholder scan; align narrative with the published schema; single stage→artifact-path map.
6. **The big consolidation** — `runAgentArtifactStage`, compiler-emitted humanization (delete stylizer),
   and the deletion table above (~1,500+ lines net removal).

## Development-rules feedback (`AGENTS.md`)

- **Contradictory:** the repo declares "Issues and PRDs live in GitHub Issues" but the commit section is
  written around *Linear* issue keys and "Linear closing magic words", including "ask the user before
  committing whether the work relates to any Linear issues". Pick one tracker; the ask-every-commit rule
  is friction once the issue key is known from the branch.
- **Garbled:** "always use the `tdd` skill if you have to it" — presumably "if you have access to it".
- **Counterproductive in practice:** requiring `bun run graph:deps` before any change is "complete"
  produces 2,000-line generated-SVG diffs on every PR. Regenerate in CI or commit graphs only on
  structural changes.
- **Fine but not followed:** the testing rules are good, but the suite violates them at the places that
  matter — mocked seams at security boundaries, change-detector tests (`retry-policy.test.ts` asserts
  the constant edited in the current diff), tests of unreachable paths. A rule that would earn its keep:
  *"a seam's test must exercise the real implementation at least once."*
- **"Keep the codebase minimal"** is aspirational at 28k source lines with the dead-code volume above;
  knip passes because dead code is exported-and-used-by-tests. Consider test-aware knip config.

## Uncertainties needing another run or more evidence

1. **Generality is untested** — every artifact is Midday. The monorepo/product-selection findings were
   verified by executing the modules on synthetic layouts, but a real run on 2–3 dissimilar repos
   (single-package Vite app; pnpm monorepo with docs+app; SPA without SSR) is the only meaningful
   validation of stage-level behavior.
2. **The 11-minute gap + 502** in the 07-25 run: the masking mechanics are confirmed, but which exact
   call threw (fallback-prompt agent command vs a workspace op) needs one instrumented run — the sandbox
   log that would answer it was lost to the 5s collection timeout (itself finding C5).
3. **`--dangerously-skip-permissions` semantics** — whether OpenCode's permission table still binds
   under that flag is load-bearing for the whole write-boundary story and is only testable against the
   real binary in the sandbox image.
4. **PTY `MAX_CANON` truncation** — inferred from canonical-mode behavior; confirm with one >4 KB
   single-line prompt against the real transport before prioritizing the file-based prompt fix.
5. A handful of findings not independently re-verified (unmarked items — e.g., iframe blindness
   specifics, hydration memory ceiling, compositing prototype-chain details) are cited with exact lines
   and are cheap to confirm during implementation.

## Run-artifact evidence index

| Run | Outcome | Notes |
|---|---|---|
| `terminal-2026-07-17T22-23-56-558Z` | **succeeded** | full video: `composite/final-video.mp4`, 8 scenes |
| `terminal-2026-07-18T16-18-03-515Z` | failed | capture runtime protocol marker-count error |
| `terminal-2026-07-18T22-23-09-738Z` | failed | fidelity: `packages/supabase/src/cl…` |
| `terminal-2026-07-19T22-18-10-490Z` | failed | exploration found no groundable browser route |
| `terminal-2026-07-19T22-46-28-615Z`, `…23-28-47` | failed | fidelity: `apps/dashboard/src/app/[…` |
| `terminal-2026-07-23T23-36-28-858Z` | failed | lockfile reconciliation (xlsx / bun install) |
| `terminal-2026-07-24T00-34-54-607Z` | failed | preflight "did not respond / exit 0" contradiction (H8) |
| `terminal-2026-07-25T23-52-39-135Z` | failed | full C1/C2/C5 specimen; final error = bare Daytona 502 |
| earlier 07-14/15/17 runs | failed | Daytona timeouts / no-output / artifact-upload 502s |
| `terminal-2026-07-27T21-03-45-637Z` (memos) | failed | flow-lock catch-22: FlowSpec-selected `fill-interaction-2-1` fails dynamic validation from fresh state; script repair cannot drop it; regrounding reproduces it; no Flow Planning re-entry (see remediation-plan addendum) |
| `terminal-2026-07-27T21-17-51-757Z` (homer) | **succeeded** | first non-Midday end-to-end success; single-package Vite + workspace yaml |
| `terminal-2026-07-27T21-25-29-301Z` (linkwarden) | failed | actionable ambiguity error (good), but Expo `apps/mobile` counted as a browser candidate, blocking auto-selection of `apps/web` |

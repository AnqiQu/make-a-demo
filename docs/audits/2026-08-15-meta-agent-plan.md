# Meta-Agent Plan (2026-08-15)

Companion to `2026-07-27-remediation-plan.md`. That document tracks
defect remediation (N-items); this one tracks the design and phased
introduction of a bounded advisory meta-agent (M-items). Wave numbering
and evidence conventions are shared with the remediation plan.

## Motivation

The pipeline's deterministic classify → route → budget layer is the
asset that made waves 1–13 diagnosable, and nothing here weakens it.
But the system has no judgment **across rounds**: every stage agent
sees one failure report, and the orchestrator's only cross-round
faculties are fingerprint caps and budgets. Wave-13 showed the cost
three ways:

- ghostfolio: the repair agent produced the correct fix twice; the
  resolver silently discarded it both times; the run died on identical
  failures. The tell — "the accepted candidate declares a build, the
  executed lifecycle contains none" — is a cross-artifact comparison
  no stage agent can see.
- directus: five rounds of correct single-package hints against a
  dependency graph that needed one workspace-graph build.
- twenty: 97 minutes spent proving a capacity ceiling that the first
  OOM-killed migration had already established.

A meta-agent's comparative advantage is exactly this: it reads the
whole artifact trail, compares across rounds and stages, and decides
what the next round should be — or that there should not be one.

## Precedent

The codebase already contains one bounded-judgment agent: the
preparation-fidelity adjudicator (`preparation-fidelity-adjudication`
stage). Its contract is the template this plan generalizes:

- it judges within an enumerated space (per-candidate verdicts),
- its output is an artifact read back through a schema,
- any failure — nonzero exit, missing artifact, bad schema — returns
  undefined and the deterministic verdict stands (fail-open),
- it can only rescue false vetoes, never override real ones.

## Design rules

1. **Advisory, never controlling.** The meta-agent returns a typed
   decision from an enumerated space. Deterministic code validates it,
   applies it through existing machinery, and retains the veto.
2. **Gates stay gates.** Fidelity vetoes, contract validation, marker
   protocol, and failure classifications are never overridden. The
   meta-agent chooses among legal next moves.
3. **Fail-open.** Strategist error, timeout, or invalid output falls
   back to today's behavior. A meta-agent failure must never fail or
   stall a run.
4. **Consulted only when the cheap path is exhausted.** The trigger is
   a signal the orchestrator already computes (repeated failure
   fingerprint, budget pressure, capacity-class classification).
   Healthy runs never pay for it.
5. **Artifacts in, artifacts out.** Inputs are the existing artifact
   trail; decisions are persisted like any agent artifact
   (`agent-artifact-attempts/repair-strategy/attempt-N.json`) with a
   machine-readable rationale, so meta-agent judgment is itself
   auditable in wave diagnosis.
6. **Menu over prose, prose over power.** Where a decision can be a
   typed lever the orchestrator applies, prefer that. Where the space
   cannot be enumerated (steering the next repair), the advice is
   prose through one of two graded channels — an additive hint via
   the existing failure-report/hint channel, or a one-round directive
   via the privileged slot that supersedes approach guidance but
   never contract text (see Directives) — never direct workspace
   edits or command execution.

## Architecture

### The strategist seam

One new dependency-injected seam, mirroring `repairPreparation`:

    adviseRepairStrategy(input: {
      roundLedger: RepairRoundLedger;
      failureReport: ValidationReport;
      budgets: RepairBudgetSnapshot;
      preparationManifest: PreparationManifest;
    }): Promise<RepairAdvice | undefined>

`undefined` — from absence, error, timeout, or schema rejection —
means "no advice"; the orchestrator proceeds exactly as today.

### RepairAdvice (the decision space)

A discriminated union, deliberately small at first:

- `{ kind: "continue" }` — proceed with the normal repair round.
- `{ kind: "escalate-hint", hint }` — proceed, but inject `hint` into
  the repair prompt through the existing artifactError/hint channel.
  Additive: the hint competes with the prompt's default guidance.
- `{ kind: "directive", directive }` — proceed, injecting `directive`
  into the stage prompt's privileged directive slot, which explicitly
  supersedes the prompt's default approach guidance for this round
  (see Directives below). Never supersedes contract text.
- `{ kind: "stop", reason }` — spend no further budget on this run;
  fail now with `reason` appended to the final report. Applied only
  when a deterministic floor is met (see Stop authority).
- `{ kind: "spend-bonus-round" }` — grant one bonus round beyond the
  fingerprint cap (bounded by the existing bonusRounds arithmetic).

Additions (switch-strategy levers such as dev-serve-instead-of-build)
enter the union only when the deterministic layer has a corresponding
lever it knows how to apply. The union is the contract; anything the
orchestrator cannot mechanically apply does not belong in it.

### The round ledger

The strategist's edge is comparative context. Per repair round, the
ledger records what the artifact trail already contains, joined in one
structure: the failure report and classification, the repair
candidate's fingerprint and lifecycle fields, the post-resolution
manifest's lifecycle fields (candidate vs. resolved deltas are how a
ghostfolio-class field drop becomes visible), the workspace diff
summary, and the budget state. Building the ledger is deterministic
code with unit tests; the strategist only reads it.

### Consultation points

- Phase M1: inside the preparation repair loop, only when
  `fingerprintRepairAttempts >= 1` — the second occurrence of the same
  failure, exactly where today's options degenerate to "same again or
  give up."
- Phase M2: once at run start (triage), input = repo profile +
  submitted-code sandbox class; output = preparation strategy hints
  and an envelope-fit warning.
- Phase M3: offline, after a failed run; not in the pipeline at all.

### Directives: strategist-authored approach steering

A hint is not enough when the strategist's judgment is "the default
approach is failing — do it differently": the stage prompts carry
standing rules accumulated from N-items, and the recorded pattern
(the dependency-repair handcuff, the preserve-fields rule) is that a
mere suggestion loses to standing prompt text until it gets a
structurally privileged channel. Full prompt authorship is the
opposite error: it would silently regress every invariant the prompts
encode. The directive kind is the bounded middle.

Prerequisite refactor: each consulted stage prompt is split into an
**approach** section (defaults, steering, priority order — policy)
and a **contract** section (must/never rules, output artifact format,
fidelity boundaries — law). The prompt builder owns both; the
directive is injected into a labeled slot with explicit precedence:
it supersedes the approach section for this round and never the
contract section. A strategy that genuinely requires relaxing a
contract rule cannot be expressed in directive prose — that is what
typed levers and classification-driven escape hatches are for.

Directives are safe here for the same reason the whole advisory
design is safe: gates stay gates. A wrong directive's output still
faces the same deterministic validation as any other round. Scope
rules: a directive lasts one round and must be re-issued to persist,
so a failed directive dies by default rather than becoming standing
policy; it is persisted inside the advice artifact; and the next
round's ledger records its outcome, so directive quality is itself
auditable in wave diagnosis.

### Stop authority

Early abort is the highest-value and highest-risk advice. Twenty's
wave-13 run spent 97 minutes establishing what attempt 1 proved. Rule:
`stop` is only applied when a deterministic floor agrees — at least
two failed validation rounds, and the failure class is one the
orchestrator marks stop-eligible (capacity kills, ENOSPC,
wedged-infrastructure). The strategist can recommend stopping early;
it cannot make a healthy run stop.

### Execution shape

The strategist runs as an ordinary OpenCode stage
(`repair-strategy`) in the agent sandbox with read-only tools over
`/workspace/.makeademo/`, a short timeout (2–3 minutes), one
consultation per repair round maximum, metered like any agent stage.
Rare invocation means the strongest available model is affordable.

### Statefulness: fresh invocations over a stateful ledger

Each consultation is a fresh OpenCode session; the strategist never
threads `opencodeSessionId` across rounds the way repair agents do.
Repair agents are mid-task — their working memory is legitimately the
conversation plus their workspace edits. The strategist's job is
judgment over the record, so the record is the input, in full, every
time: a consultation must be a pure function of the ledger. That
keeps decisions auditable (what it saw is exactly what is persisted),
replayable (M1 acceptance replays recorded ledgers), free of
anchoring on stale conclusions, and immune to sandbox loss (sessions
die with sandboxes — N153 exists because they wedge; artifacts
survive). The requirement this creates: the ledger records the
strategist's own history — each prior advice, whether it was applied,
and the following round's outcome — so a fresh invocation can see
"my round-2 hint did not move the failure" without having been
present for round 2. Across runs there is no memory at all (see Open
questions).

## Phases

### M1 (repair strategist)

The seam, the ledger, the five-kind advice union, consultation on
repeated fingerprints, application machinery for each kind, and the
directive's prerequisite: splitting the consulted repair prompts into
approach and contract sections (a standalone refactor commit that
should land first — it makes existing rule contradictions visible by
construction even before the strategist exists).
Acceptance, from recorded waves: replaying ghostfolio wave-13's
ledger, the strategist surfaces the candidate-vs-resolved build-field
drop in a hint or stop rationale by round 2 (the deterministic fix is
N154; the strategist must merely see it — that proves the ledger
carries the right evidence). Replaying directus wave-13's ledger, the
round-2 hint names the workspace-graph build. TDD through the seam: a
fake strategist exercises every advice kind plus schema-invalid and
timeout fallbacks; one test runs the real ledger builder against
wave-13 artifacts.

Landed: `a9baa20`–`03eab61` implement M1. The two preparation-repair
prompts now separate default approach guidance from their invariant
contracts and expose a one-round directive slot between them. A
backend-built RepairRoundLedger preserves candidate and resolved
lifecycle fields, workspace-diff summaries, budget and advice history,
and is replay-tested against the four committed ghostfolio, directus,
and outline wave-13/wave-14 extracts. Repeated fingerprints consult a
fresh configured-model `repair-strategy` stage through durable ledger
and advice artifacts; missing, invalid, timed-out, or failed advice is
fail-open. All five advice kinds are mechanically applied: hints use
the existing hint channel, directives expire after one round, stop is
vetoed unless `isStopEligibleFailure` and the two-failure floor agree,
and bonus rounds remain bounded by the existing bonus arithmetic.

### M2 (run triage)

Startup consultation producing preparation-strategy hints consumed by
the repo-preparation prompt, plus an envelope-fit warning surfaced in
the run report. No blocking authority: triage cannot fail a run, only
annotate and steer. Acceptance: a twenty-class profile yields a
lighter-lifecycle hint and a capacity warning before any sandbox work.

Landed. Triage consults the strategist once at run start, gated on the
deterministic heavyweight submitted-code capacity classification
(`selectSubmittedCodeSandboxClass`), so standard-class runs never pay
for it — the design-rule-4 trigger vocabulary's "capacity-class
classification". A fresh configured-model `run-triage` stage reads the
repo-profile artifact plus the materialized screened repo and answers
through the remove-then-read `run-triage-advice.json` artifact
(schema: up to eight non-empty hints plus an optional warning; audit
copies under `agent-artifact-attempts/run-triage/`). Missing, invalid,
timed-out, or failed advice is fail-open. Hints flow additively into
both repo-preparation prompt attempts and never override contract
text; the warning is persisted as `envelopeFitWarning` on the pipeline
run manifest on passed and failed runs alike — the twenty acceptance
is the failed-run-report test.

### M3 (offline diagnostician)

A CLI (`bun run diagnose:run <run-directory>`) that reads a completed
run's artifacts and drafts a wave-diagnosis note: per-entry cause,
classification quality check, and candidate N-item sketches for the
remediation plan. Zero pipeline coupling; its output is reviewed by a
human before entering the plan. Acceptance: pointed at the wave-13
directories, it independently identifies the resolver field-drop and
the dependency-chain shape.

## Anti-goals

- No freeform tool use, command execution, or workspace edits from the
  strategist; it reads artifacts and returns one decision.
- No consultation on healthy runs; no per-action or per-stage
  consultation cadence.
- No gate overrides, no classification rewrites, no manifest editing.
- Not a substitute for deterministic fixes: known seam bugs still get
  N-items. The strategist exists for the unknown next one, and its
  hints must surface bugs (into wave diagnosis), never quietly route
  around them run after run.

## Open questions

- Strategy vocabulary for M2: which preparation strategies are real,
  parameterizable levers (dev-serve vs. production build, seed via
  API vs. UI vs. fixtures) versus prompt-hint prose, and where each
  lives in the manifest contract.
- Whether M1's ledger should include prior-run memory for the same
  repo (cross-run learning) or stay strictly within-run. Within-run
  first; cross-run only with evidence it pays.
- Whether script-repair loops (capture-side) get the same strategist
  or a separate one once N152's fingerprinting lands. One seam, two
  consultation points is the default answer.

## M1 implementation notes (2026-08-17)

Pre-implementation review closed four gaps the design left to
guesswork. These are decisions, not suggestions.

**Sandbox artifact paths.** Both new artifacts join the
`artifactPaths` registry (`schemas/artifact-paths.ts`), following the
fidelity-adjudication precedent: the harness writes the ledger to
`{makeADemoDirectory}/repair-round-ledger.json` before each
consultation; the strategist writes its advice to
`{makeADemoDirectory}/repair-advice.json`, which the harness removes
before each consultation and reads back through the schema after
(same remove-then-read shape as `fidelityAdjudication`).

**RepairRoundLedger sketch.** One entry per completed repair round:
`{ round, stage, failureClassification, causalHeadline,
failingFeatureIds, candidateLifecycle: { appDir, installCommandUsed,
buildCommandUsed, startCommandUsed, ports },
resolvedLifecycle: { same fields, post-resolution },
workspaceDiffSummary: { changedPathCount, topLevelDirs },
budget: { totalAttempts, fingerprintAttempts, bonusRounds },
advice: { kind, textDigest, applied } | null,
outcomeOfAdvice: "failure-unchanged" | "failure-moved" | "resolved"
| null }`. The candidate/resolved lifecycle pair is non-negotiable —
it is how a ghostfolio-class field drop becomes visible. Exact
naming may drift during TDD; the field *set* may not shrink.

**Stop eligibility is a deterministic predicate, not a vocabulary.**
No classification named "capacity kill" exists; OOM and disk
exhaustion live in summary text. Implement
`isStopEligibleFailure(report)` in the orchestrator: classification
in { "install failure", "lifecycle timeout", "service migration
failure", "start failure" } AND the causal headline matching a
resource-exhaustion marker (`Killed`, `ENOSPC`, an org-cap
rejection), OR the N153 wedged-target path. `stop` advice applies
only when this predicate holds and at least two rounds have failed.

**Acceptance fixtures are committed extracts, not run-dir reads.**
`.makeademo-terminal-runs/` is gitignored, so the replay tests
cannot reference it. Extract minimal JSON fixtures (the
validation-attempt files and manifest pairs needed to build each
ledger) into the test tree, naming the source run in a comment:
ghostfolio and directus from matrix-2026-08-15T05-38 (wave-13), and
from wave-14 (matrix-2026-08-17T04-03) the directus three-round
dependency arc and outline's repeated evidence-citation failure —
four ledger shapes total.

**Prompt split scope.** M1 splits exactly two builders into
approach/contract sections: `createRepoPreparationRepairPrompt` and
`createRuntimePreparationRepairPrompt`. Other stage prompts are out
of scope until their stages gain a consultation point.

**Model.** The strategist uses the session's configured
`${providerID}/${modelID}` like every other stage; no separate model
knob in M1.

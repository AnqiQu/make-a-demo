# Repair-Evidence Contract

Every validator's failure report (`ValidationReport` in
`src/server/agent-harness/schemas/artifacts.ts`) is the interface it owes
the repair agent. The recurring failure class behind N29a, N50, N51, N52,
the N53 rider, N56, and N57 was evidence distortion fixed one symptom at a
time; this contract names the invariants once so new gates comply by
design and existing gates are audited against it (N62).

## The five clauses

1. **Executed commands, verbatim.** A report names the command that
   actually ran — suppression flags, retries, and gate rewrites included —
   never the pre-transformation input. A repair agent cannot reason about
   a flag it never saw (N53: berry repos blamed `yarn install --immutable`
   for a `--mode` flag the gate appended).

2. **Bounded, deduped evidence channels.** Every channel carries per-class
   caps so one noisy class cannot saturate the prompt budget: console
   errors keep one entry per error class (N57d), interpolated fields are
   middle-elided with head and tail preserved (N65), and the OpenCode
   runner enforces a 96KB last-resort ceiling per prompt. Anything
   silently dropped must be named (`… characters elided …`).

3. **Observations separated from diagnoses.** A causal claim appears only
   when the validator can actually discriminate the cause; otherwise the
   report states what was observed and names the candidate causes (N57a:
   a zero-row table is reported as either an empty query result or a
   zero-height virtualized body — the gate cannot tell which). Steering
   hints are phrased as inference ("likely", with the reasoning) when
   they rest on heuristics (N67).

4. **All currently-known violations per attempt, never first-fault.**
   Serial constraint discovery burns one repair round per rule; a gate
   that can enumerate its violations reports them together with
   qualifying candidates named (N56 flow planning, fidelity's violations
   list, N71's per-feature gap enumeration).

5. **No infra errors in agent prompts.** Provider and control-plane
   failures are the harness's problem: command stalls ride the stall lane
   (N61), failed launches classify as infrastructure, and a
   `harness/internal failure` validation report gets one agent-free
   revalidation and then fails the run — it never dispatches a repair
   agent or spends repair budget (outline's fallback once asked a future
   coding agent to "fix" a Daytona 502).

## Gate audit (2026-08-08)

| Gate | 1 | 2 | 3 | 4 | 5 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Dependency install gate | ✓ N53 `executedCommand` | ✓ N65 elision | ✓ | ✓ | ✓ | Reconciliation reports carry the executed command variants. |
| Offline lifecycle pass | ✓ | ✓ N69 harvests referenced build.log tails | ✓ N55 hint keyed on download evidence only | ✓ | ✓ | Berry hides causes in `/tmp/xfs-*/build.log`; harvest is part of the channel. |
| Preparation preflight (build/start/probe) | ✓ `attemptedCommand` | ✓ | ✓ N50/N67 hints are explicit inferences | partial — first failing step ends the pass (build vs. start are sequential by nature) | ✓ N62 | Sequential steps cannot enumerate later failures; not a violation. |
| Preparation fidelity | n/a | ✓ | ✓ | ✓ violations list | ✓ | N68 truthfulness and N74 identity rungs report alongside other violations. |
| App exploration | n/a | ✓ N57d dedupe | ✓ N57a both-causes wording | ✓ per-feature enumeration (N71) | ✓ N21c stderr is evidence, not a gate | Route-aware console/page errors since N51. |
| Flow-spec validation | n/a | ✓ | ✓ | ✓ N56 collected violations + candidate ids | ✓ | Structural referential errors still throw first — they invalidate the artifact wholesale. |
| Script/capture-path validation | ✓ | ✓ bounded output (6.7) | ✓ | ✓ | ✓ | |

New gates must state, in their tests, which clauses their failure reports
exercise; a gate whose report violates a clause is a bug even when the
gate's verdict is correct.

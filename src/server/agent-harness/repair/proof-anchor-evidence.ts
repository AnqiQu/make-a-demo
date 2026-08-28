import type { StrategistMemoryProofAnchor } from "./strategist-memory";

// The feature-verification classifications whose repair concerns prepared
// app CONTENT — fixtures, seeded state, demo gating — rather than lifecycle
// commands. Lifecycle classifications are deliberately absent: they carry
// their own cross-run citations (N171/N178/N179), and the two sets never
// overlap, so at most one citation family speaks per failure.
const contentFailureClassifications = new Set([
  "app route not discoverable",
  "auth wall",
  "empty/unmeaningful app state",
  "feature auth barrier",
  "prepared feature not observable",
  "requested feature not observable",
]);

/**
 * Leads a content/grounding failure's evidence with the proof anchors this
 * repository's last passing run grounded (N184): the declared proof targets
 * and the routes verification observed them on, prepended to `logsSummary`
 * with a reproduce-or-justify instruction, so round one confronts what
 * "right" content looked like instead of re-rolling it (midday, wave-23:
 * preparation re-rolled the fixtures whose "INV-1042" its own last pass
 * had grounded, and only the lifecycle was remembered). Returns the failure
 * unchanged when its classification does not blame prepared content or no
 * anchors are recorded. The same caller contract as the lifecycle appenders
 * applies: fingerprint and ledger the raw report, never the enriched copy.
 */
export function appendProofAnchorEvidence<
  T extends { failureClassification?: string; logsSummary: string },
>(input: {
  failure: T;
  lastPassingProofAnchors: readonly StrategistMemoryProofAnchor[] | undefined;
}): T {
  if (
    input.lastPassingProofAnchors === undefined ||
    input.lastPassingProofAnchors.length === 0 ||
    !contentFailureClassifications.has(
      input.failure.failureClassification ?? "",
    )
  ) {
    return input.failure;
  }
  return {
    ...input.failure,
    logsSummary: [
      "Cross-run proof anchors: this repository's last passing run grounded these declared proofs — reproduce them, or justify why the prepared content must depart from them:",
      ...input.lastPassingProofAnchors.map(
        (anchor) => `- ${anchor.featureId}: ${anchor.proof} on ${anchor.route}`,
      ),
      "",
      input.failure.logsSummary,
    ].join("\n"),
  };
}

import { describe, expect, it } from "vitest";
import { appendProofAnchorEvidence } from "./proof-anchor-evidence";

const anchors = [
  {
    featureId: "invoicing",
    proof: 'visible text "INV-1042"',
    route: "/invoices",
  },
  {
    featureId: "transactions",
    proof: 'element "Transactions table" appears',
    route: "/transactions",
  },
];

describe("appendProofAnchorEvidence", () => {
  it("leads a content failure's evidence with the last passing run's grounded proofs", () => {
    // N184 (midday, wave-23): preparation re-rolled fixture content the
    // repository's own last pass had right, and round one had nothing to
    // cite because only the lifecycle was remembered.
    const failure = {
      failureClassification: "requested feature not observable",
      logsSummary:
        "App Exploration found no browser evidence for requested features: Invoicing.",
      stage: "preparation-preflight",
    };

    const enriched = appendProofAnchorEvidence({
      failure,
      lastPassingProofAnchors: anchors,
    });

    expect(enriched.logsSummary).toMatch(
      /^Cross-run proof anchors: this repository's last passing run grounded these declared proofs — reproduce them, or justify why the prepared content must depart from them:/,
    );
    expect(enriched.logsSummary).toContain(
      '- invoicing: visible text "INV-1042" on /invoices',
    );
    expect(enriched.logsSummary).toContain(
      '- transactions: element "Transactions table" appears on /transactions',
    );
    expect(enriched.logsSummary).toContain(
      "App Exploration found no browser evidence for requested features: Invoicing.",
    );
    expect(enriched.stage).toBe("preparation-preflight");
  });

  it("returns the failure unchanged when no anchors are recorded", () => {
    const failure = {
      failureClassification: "requested feature not observable",
      logsSummary: "No evidence.",
    };
    expect(
      appendProofAnchorEvidence({
        failure,
        lastPassingProofAnchors: undefined,
      }),
    ).toBe(failure);
    expect(
      appendProofAnchorEvidence({ failure, lastPassingProofAnchors: [] }),
    ).toBe(failure);
  });

  it("returns a lifecycle-command failure unchanged", () => {
    // Lifecycle classifications carry their own cross-run citations
    // (N178/N179); content anchors would only dilute that evidence.
    const failure = {
      failureClassification: "install failure",
      logsSummary: "Install command failed.",
    };
    expect(
      appendProofAnchorEvidence({
        failure,
        lastPassingProofAnchors: anchors,
      }),
    ).toBe(failure);
  });

  it("returns an unclassified failure unchanged", () => {
    const failure = { logsSummary: "Something unclassified died." };
    expect(
      appendProofAnchorEvidence({
        failure,
        lastPassingProofAnchors: anchors,
      }),
    ).toBe(failure);
  });
});

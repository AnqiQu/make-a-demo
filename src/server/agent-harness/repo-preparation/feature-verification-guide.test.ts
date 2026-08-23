import { describe, expect, it } from "vitest";
import {
  expectedProofKinds,
  featureVerdictFailureCauses,
} from "../schemas/artifacts";
import { createFeatureVerificationGuide } from "./feature-verification-guide";

describe("createFeatureVerificationGuide", () => {
  it("names every verdict failure cause the ledger can assign", () => {
    // The guide is the agent-facing rendering of the gate's vocabulary; a
    // cause the ledger can emit but the guide never names would leave repair
    // agents steering blind. The shared constant makes the drift impossible
    // to miss.
    const guide = createFeatureVerificationGuide();
    for (const cause of featureVerdictFailureCauses) {
      expect(guide).toContain(cause);
    }
  });

  it("explains every declared proof kind", () => {
    const guide = createFeatureVerificationGuide();
    for (const kind of expectedProofKinds) {
      expect(guide).toContain(kind);
    }
  });
});

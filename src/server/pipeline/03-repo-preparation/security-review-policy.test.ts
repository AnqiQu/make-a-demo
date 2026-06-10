import { describe, expect, it } from "vitest";

import {
  type SecurityReviewOutcome,
  evaluateSecurityReview,
} from "./security-review-policy";

describe("evaluateSecurityReview", () => {
  it("accepts Repo Preparation only when all four security reviewers accept", () => {
    const result = evaluateSecurityReview([
      accept("dependency-reviewer"),
      accept("runtime-security-reviewer"),
      accept("obfuscation-deception-auditor"),
      accept("prompt-injection-reviewer"),
    ]);

    expect(result).toEqual({ status: "accepted" });
  });

  it("rejects Repo Preparation when any reviewer rejects", () => {
    const result = evaluateSecurityReview([
      accept("dependency-reviewer"),
      {
        evidence: ["demo start reaches a remote telemetry endpoint"],
        reason: "Runtime attempts external communication before capture.",
        reviewer: "runtime-security-reviewer",
        status: "rejected",
      },
      accept("obfuscation-deception-auditor"),
      accept("prompt-injection-reviewer"),
    ]);

    expect(result).toEqual({
      blockers: ["Runtime attempts external communication before capture."],
      evidence: ["demo start reaches a remote telemetry endpoint"],
      status: "rejected",
    });
  });

  it("fails Repo Preparation when a reviewer does not return a structured decision", () => {
    const result = evaluateSecurityReview([
      accept("dependency-reviewer"),
      accept("runtime-security-reviewer"),
      accept("obfuscation-deception-auditor"),
      {
        reviewer: "prompt-injection-reviewer",
        status: "needs-more-information",
      },
    ] as SecurityReviewOutcome[]);

    expect(result).toEqual({
      blockers: [
        "prompt-injection-reviewer returned an invalid security review outcome.",
      ],
      status: "errored",
    });
  });
});

function accept(
  reviewer: SecurityReviewOutcome["reviewer"],
): SecurityReviewOutcome {
  return {
    evidence: [],
    reason: "No blocking security findings.",
    reviewer,
    status: "accepted",
  };
}

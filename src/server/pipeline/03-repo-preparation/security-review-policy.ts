const requiredSecurityReviewers = [
  "dependency-reviewer",
  "runtime-security-reviewer",
  "obfuscation-deception-auditor",
  "prompt-injection-reviewer",
] as const;

type SecurityReviewer = (typeof requiredSecurityReviewers)[number];

export type SecurityReviewOutcome = {
  evidence: string[];
  reason: string;
  reviewer: SecurityReviewer;
  status: "accepted" | "rejected";
};

export type SecurityReviewDecision =
  | { status: "accepted" }
  | { blockers: string[]; evidence: string[]; status: "rejected" }
  | { blockers: string[]; status: "errored" };

/**
 * Evaluates the agentic Repo Preparation security review.
 * All required reviewers must return a structured accept decision; rejection,
 * missing output, and malformed output fail preparation before demo build work.
 */
export function evaluateSecurityReview(
  outcomes: SecurityReviewOutcome[],
): SecurityReviewDecision {
  const blockers: string[] = [];
  const rejectedEvidence: string[] = [];

  for (const reviewer of requiredSecurityReviewers) {
    const outcome = outcomes.find((item) => item.reviewer === reviewer);

    if (!isStructuredOutcome(outcome, reviewer)) {
      return {
        blockers: [`${reviewer} returned an invalid security review outcome.`],
        status: "errored",
      };
    }

    if (outcome.status === "rejected") {
      blockers.push(outcome.reason);
      rejectedEvidence.push(...outcome.evidence);
    }
  }

  if (blockers.length > 0) {
    return { blockers, evidence: rejectedEvidence, status: "rejected" };
  }

  return { status: "accepted" };
}

function isStructuredOutcome(
  outcome: SecurityReviewOutcome | undefined,
  reviewer: SecurityReviewer,
): outcome is SecurityReviewOutcome {
  return (
    outcome !== undefined &&
    outcome.reviewer === reviewer &&
    (outcome.status === "accepted" || outcome.status === "rejected") &&
    typeof outcome.reason === "string" &&
    Array.isArray(outcome.evidence) &&
    outcome.evidence.every((item) => typeof item === "string")
  );
}

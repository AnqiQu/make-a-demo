import {
  type SecurityReviewOutcome,
  evaluateSecurityReview,
} from "./security-review-policy";

export type DependencyNetworkRequest = {
  command: string;
  reason: string;
  securityReviewOutcomes: SecurityReviewOutcome[];
};

export type DependencyNetworkDecision =
  | { status: "allowed" }
  | { reason: string; status: "denied" };

const agentOnlyEnvKeys = new Set([
  "ANTHROPIC_API_KEY",
  "CONTEXT7_API_KEY",
  "EXA_API_KEY",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL_EXA",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
]);

/**
 * Decides whether Repo Preparation may temporarily unblock outbound network.
 * Network access is limited to dependency installation after all security
 * reviewers have accepted the repo.
 */
export function evaluateDependencyNetworkRequest(
  request: DependencyNetworkRequest,
): DependencyNetworkDecision {
  if (request.reason !== "dependency-install") {
    return {
      reason:
        "Outbound network access is only allowed for dependency installation.",
      status: "denied",
    };
  }

  const review = evaluateSecurityReview(request.securityReviewOutcomes);
  if (review.status === "accepted") {
    return { status: "allowed" };
  }

  return {
    reason: review.blockers.join(" "),
    status: "denied",
  };
}

export function createSubmittedRuntimeEnv(
  agentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(agentEnv)) {
    if (value === undefined || isAgentOnlyEnvKey(key)) {
      continue;
    }

    runtimeEnv[key] = value;
  }

  return runtimeEnv;
}

function isAgentOnlyEnvKey(key: string): boolean {
  return (
    agentOnlyEnvKeys.has(key) ||
    key.startsWith("DAYTONA_") ||
    key.startsWith("OPENCODE_") ||
    key.endsWith("_API_KEY") ||
    key.endsWith("_TOKEN") ||
    key.endsWith("_SECRET")
  );
}

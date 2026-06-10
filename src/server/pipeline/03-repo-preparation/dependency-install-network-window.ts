import {
  type DependencyNetworkDecision,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "./preparation-workspace.interface";
import type { SecurityReviewOutcome } from "./security-review-policy";

export type DependencyInstallNetworkWindowInput = {
  command: string;
  securityReviewOutcomes: SecurityReviewOutcome[];
  workspace: PreparationWorkspace;
};

export async function runDependencyInstallWithNetworkWindow(
  input: DependencyInstallNetworkWindowInput,
): Promise<PreparationWorkspaceCommandResult> {
  const decision = evaluateDependencyNetworkRequest({
    command: input.command,
    reason: "dependency-install",
    securityReviewOutcomes: input.securityReviewOutcomes,
  });
  assertNetworkAllowed(decision);

  await input.workspace.setOutboundNetworkAccess(true);
  try {
    return await input.workspace.execute(input.command);
  } finally {
    await input.workspace.setOutboundNetworkAccess(false);
  }
}

function assertNetworkAllowed(
  decision: DependencyNetworkDecision,
): asserts decision is { status: "allowed" } {
  if (decision.status === "denied") {
    throw new Error(decision.reason);
  }
}

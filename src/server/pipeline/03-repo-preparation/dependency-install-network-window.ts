import {
  type DependencyNetworkDecision,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "./preparation-workspace.interface";
import {
  executeSubmittedCode,
  setSubmittedCodeNetworkAccess,
} from "./submitted-code-execution";

export type DependencyInstallNetworkWindowInput = {
  command: string;
  workspace: PreparationWorkspace;
};

export async function runDependencyInstallWithNetworkWindow(
  input: DependencyInstallNetworkWindowInput,
): Promise<PreparationWorkspaceCommandResult> {
  const decision = evaluateDependencyNetworkRequest({
    command: input.command,
    reason: "dependency-install",
  });
  assertNetworkAllowed(decision);

  await input.workspace.writeSandboxLog?.({
    command: input.command,
    event: "submitted-code-network.opening",
    reason: "dependency-install",
  });
  await setSubmittedCodeNetworkAccess(input.workspace, true);
  await input.workspace.writeSandboxLog?.({
    command: input.command,
    event: "submitted-code-network.opened",
    reason: "dependency-install",
  });
  try {
    return await executeSubmittedCode(input.workspace, input.command);
  } finally {
    await input.workspace.writeSandboxLog?.({
      command: input.command,
      event: "submitted-code-network.closing",
      reason: "dependency-install",
    });
    await setSubmittedCodeNetworkAccess(input.workspace, false);
    await input.workspace.writeSandboxLog?.({
      command: input.command,
      event: "submitted-code-network.closed",
      reason: "dependency-install",
    });
  }
}

function assertNetworkAllowed(
  decision: DependencyNetworkDecision,
): asserts decision is { status: "allowed" } {
  if (decision.status === "denied") {
    throw new Error(decision.reason);
  }
}

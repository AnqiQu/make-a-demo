import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceExecuteOptions,
} from "./preparation-workspace.interface";

export async function executeSubmittedCode(
  workspace: PreparationWorkspace,
  command: string,
  options: PreparationWorkspaceExecuteOptions = {},
): Promise<PreparationWorkspaceCommandResult> {
  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Preparation workspace cannot execute submitted code.");
  }

  return await workspace.executeSubmittedCode(command, options);
}

export async function setSubmittedCodeNetworkAccess(
  workspace: PreparationWorkspace,
  enabled: boolean,
): Promise<void> {
  if (workspace.setSubmittedCodeNetworkAccess === undefined) {
    throw new Error(
      "Preparation workspace cannot control submitted-code network access.",
    );
  }

  await workspace.setSubmittedCodeNetworkAccess(enabled);
}

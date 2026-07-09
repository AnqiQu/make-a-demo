import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceExecuteOptions,
} from "./workspace.interface";

export async function executeSubmittedCode(
  workspace: AgentHarnessWorkspace,
  command: string,
  options: AgentHarnessWorkspaceExecuteOptions = {},
) {
  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Submitted-code execution is not configured.");
  }

  return await workspace.executeSubmittedCode(command, options);
}

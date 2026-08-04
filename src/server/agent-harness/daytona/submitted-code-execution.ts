import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceExecuteOptions,
} from "./workspace.interface";

export async function executeSubmittedCode(
  workspace: AgentHarnessWorkspace,
  command: string,
  options: AgentHarnessWorkspaceExecuteOptions = {},
) {
  return await workspace.executeSubmittedCode(command, options);
}

import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceExecuteOptions,
} from "./workspace.interface";

class SubmittedCodeWorkspaceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmittedCodeWorkspaceSyncError";
  }
}

export async function executeSubmittedCode(
  workspace: AgentHarnessWorkspace,
  command: string,
  options: AgentHarnessWorkspaceExecuteOptions = {},
) {
  if (workspace.syncSubmittedCodeWorkspace !== undefined) {
    try {
      await workspace.syncSubmittedCodeWorkspace();
    } catch (error) {
      throw new SubmittedCodeWorkspaceSyncError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Submitted-code execution is not configured.");
  }

  return await workspace.executeSubmittedCode(command, options);
}

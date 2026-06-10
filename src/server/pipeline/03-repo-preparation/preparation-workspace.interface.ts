export type PreparationWorkspaceCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Executes commands and network-policy changes inside a Repo Preparation workspace.
 * Implementations must scope destructive work to the ephemeral workspace copy and
 * must not expose agent-only secrets to submitted app build or runtime commands.
 */
export interface PreparationWorkspace {
  execute(command: string): Promise<PreparationWorkspaceCommandResult>;
  setOutboundNetworkAccess(enabled: boolean): Promise<void>;
}

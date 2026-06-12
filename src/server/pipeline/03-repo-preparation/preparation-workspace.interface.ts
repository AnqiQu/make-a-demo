export type PreparationWorkspaceCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type PreparationWorkspaceUploadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type PreparationWorkspaceExecuteOptions = {
  env?: Record<string, string>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
};

/**
 * Executes commands and network-policy changes inside a Repo Preparation workspace.
 * Implementations must scope destructive work to the ephemeral workspace copy and
 * must not expose agent-only secrets to submitted app build or runtime commands.
 */
export interface PreparationWorkspace {
  execute(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  setOutboundNetworkAccess(enabled: boolean): Promise<void>;
  uploadFiles(files: PreparationWorkspaceUploadFile[]): Promise<void>;
}

export type PreparationWorkspaceCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type PreparationWorkspaceUploadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type PreparationWorkspaceDownloadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type PreparationWorkspaceExecuteOptions = {
  env?: Record<string, string>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
};

export type PreparationWorkspaceLogEntry = Record<string, unknown>;

/**
 * Executes commands and network-policy changes inside a Repo Preparation workspace.
 * Implementations must scope destructive work to the ephemeral workspace copy and
 * must not expose agent-only secrets to submitted app build or runtime commands.
 */
export interface PreparationWorkspace {
  cancelActiveCommands?(): Promise<void>;
  downloadFiles?(files: PreparationWorkspaceDownloadFile[]): Promise<void>;
  execute(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  /**
   * Executes submitted repo code inside the submitted-code runtime boundary.
   * Implementations must not run these commands in the agent workspace and must
   * apply submitted-code environment and network policy before execution.
   */
  executeSubmittedCode?(
    command: string,
    options?: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult>;
  getPreviewUrl(port: number): Promise<string>;
  /**
   * Emits structured audit logs inside the sandbox. Implementations must keep a
   * durable copy available from workspace storage and may additionally relay the
   * entry through provider-specific process logs when that route is available.
   */
  writeSandboxLog?(entry: PreparationWorkspaceLogEntry): Promise<void>;
  setOutboundNetworkAccess(enabled: boolean): Promise<void>;
  /** Controls outbound network for submitted-code execution only. */
  setSubmittedCodeNetworkAccess?(enabled: boolean): Promise<void>;
  uploadFiles(files: PreparationWorkspaceUploadFile[]): Promise<void>;
}

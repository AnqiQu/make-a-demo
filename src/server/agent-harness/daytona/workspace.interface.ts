import type { DependencyInstallCommandResult } from "../tools/dependency-install-gate";

export type AgentHarnessWorkspaceCommandResult = DependencyInstallCommandResult;

export type AgentHarnessWorkspaceUploadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type AgentHarnessWorkspaceDownloadFile = {
  destinationPath: string;
  sourcePath: string;
};

export type AgentHarnessWorkspaceExecuteOptions = {
  env?: Record<string, string>;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
};

export type AgentHarnessWorkspaceLogEntry = Record<string, unknown>;

/**
 * Product-level workspace seam for the agent harness.
 * Implementations must keep agent/OpenCode execution and submitted-code
 * execution in separate Daytona-backed trust boundaries.
 */
export interface AgentHarnessWorkspace {
  agentSandboxId?: string;
  submittedCodeSandboxId?: string;
  destroy(): Promise<void>;
  execute(
    command: string,
    options?: AgentHarnessWorkspaceExecuteOptions,
  ): Promise<AgentHarnessWorkspaceCommandResult>;
  executeSubmittedCode?(
    command: string,
    options?: AgentHarnessWorkspaceExecuteOptions,
  ): Promise<AgentHarnessWorkspaceCommandResult>;
  executeInAgentSandbox?(
    command: string,
    options?: { env?: Record<string, string> },
  ): Promise<AgentHarnessWorkspaceCommandResult>;
  executeInSubmittedCodeSandbox?(
    command: string,
    options?: { env?: Record<string, string> },
  ): Promise<AgentHarnessWorkspaceCommandResult>;
  syncSubmittedCodeWorkspace?(): Promise<void>;
  openSubmittedCodeDependencyNetwork?(): Promise<void>;
  closeSubmittedCodeDependencyNetwork?(): Promise<void>;
  enforceSubmittedCodeRuntimeNetworkLockdown?(): Promise<void>;
  setOutboundNetworkAccess?(enabled: boolean): Promise<void>;
  setSubmittedCodeNetworkAccess?(enabled: boolean): Promise<void>;
  getPreviewUrl?(port: number): Promise<string>;
  writeSandboxLog?(entry: AgentHarnessWorkspaceLogEntry): Promise<void>;
  uploadFiles?(files: AgentHarnessWorkspaceUploadFile[]): Promise<void>;
  downloadFiles?(files: AgentHarnessWorkspaceDownloadFile[]): Promise<void>;
  uploadArtifacts?(
    files: Array<{ destinationPath: string; sourcePath: string }>,
  ): Promise<void>;
  downloadArtifacts?(
    files: Array<{ destinationPath: string; sourcePath: string }>,
  ): Promise<void>;
  exposeLocalPreviewUrl?(port: number): Promise<string>;
  collectSandboxLogs?(): Promise<string[]>;
  collectNetworkStateLog?(): Promise<string[]>;
  cancelActiveCommands?(): Promise<void>;
}

export type AgentHarnessWorkspaceHandle = {
  destroy(): Promise<void>;
  id: string;
  workspace: AgentHarnessWorkspace;
};

export interface AgentHarnessWorkspaceProvider {
  create(): Promise<AgentHarnessWorkspaceHandle>;
}

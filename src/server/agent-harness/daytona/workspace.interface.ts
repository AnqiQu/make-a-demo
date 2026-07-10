import type { DependencyInstallCommandResult } from "../tools/dependency-install-gate";

export type AgentHarnessWorkspaceCommandResult = DependencyInstallCommandResult;

/**
 * Signals that a workspace command exceeded its caller-provided deadline.
 * Adapters must use this error only for command deadlines so orchestration can
 * safely convert it into bounded agent feedback and retry behavior.
 */
export class AgentHarnessCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Daytona command did not finish within ${timeoutMs}ms.`);
    this.name = "AgentHarnessCommandTimeoutError";
  }
}

/** Identifies a bounded artifact transfer failure at a specific trust boundary. */
export class AgentHarnessArtifactTransferError extends Error {
  readonly attempts: number;
  readonly operation: "download" | "upload";
  readonly sandboxId: string;

  constructor(input: {
    attempts: number;
    cause: unknown;
    operation: "download" | "upload";
    sandboxId: string;
  }) {
    const causeMessage =
      input.cause instanceof Error
        ? `${input.cause.name}: ${input.cause.message}`
        : String(input.cause);
    super(
      `Submitted-code artifact ${input.operation} failed after ${input.attempts} attempt(s) in sandbox ${input.sandboxId}: ${causeMessage}`,
    );
    this.name = "AgentHarnessArtifactTransferError";
    this.attempts = input.attempts;
    this.operation = input.operation;
    this.sandboxId = input.sandboxId;
    this.cause = input.cause;
  }
}

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
  timeoutMs?: number;
};

export type AgentHarnessWorkspaceLogEntry = Record<string, unknown>;

/**
 * Launch contract for the single submitted-code app owned by a workspace.
 * Implementations must run the command as a managed process in `cwd`, preserve
 * environment values literally, and replace any previously managed app.
 */
export type AgentHarnessSubmittedCodeAppStartInput = {
  command: string;
  cwd: string;
  env?: Record<string, string>;
};

/**
 * Observable state of the workspace-owned submitted-code app. An undefined
 * exit code means the managed command is still running.
 */
export type AgentHarnessSubmittedCodeAppStatus = {
  exitCode?: number;
  running: boolean;
  stderr: string;
  stdout: string;
};

export type AgentHarnessNetworkStateTransition = {
  at: string;
  state:
    | "dependency-install-closed"
    | "dependency-install-open"
    | "runtime-locked"
    | "runtime-unlocked";
};

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
  startSubmittedCodeApp?(
    input: AgentHarnessSubmittedCodeAppStartInput,
  ): Promise<void>;
  readSubmittedCodeAppStatus?(): Promise<AgentHarnessSubmittedCodeAppStatus>;
  stopSubmittedCodeApp?(): Promise<void>;
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
  /**
   * Uploads runtime inputs only to the submitted-code trust boundary.
   * Implementations must not copy these files into an agent sandbox.
   */
  uploadSubmittedCodeFiles?(
    files: AgentHarnessWorkspaceUploadFile[],
  ): Promise<void>;
  /**
   * Downloads runtime artifacts only from the submitted-code trust boundary.
   */
  downloadSubmittedCodeFiles?(
    files: AgentHarnessWorkspaceDownloadFile[],
  ): Promise<void>;
  uploadArtifacts?(
    files: Array<{ destinationPath: string; sourcePath: string }>,
  ): Promise<void>;
  downloadArtifacts?(
    files: Array<{ destinationPath: string; sourcePath: string }>,
  ): Promise<void>;
  exposeLocalPreviewUrl?(port: number): Promise<string>;
  collectSandboxLogs?(): Promise<string[]>;
  collectNetworkStateLog?(): Promise<AgentHarnessNetworkStateTransition[]>;
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

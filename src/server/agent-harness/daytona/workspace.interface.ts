import type { DependencyInstallCommandResult } from "../tools/dependency-install-gate";

export type AgentHarnessWorkspaceCommandResult = DependencyInstallCommandResult;

/**
 * Signals that a workspace command exceeded its caller-provided deadline.
 * Adapters must use this error only for command deadlines so orchestration can
 * safely convert it into bounded agent feedback and retry behavior.
 */
export class AgentHarnessCommandTimeoutError extends Error {
  readonly kind: "deadline" | "inactivity";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, kind: "deadline" | "inactivity" = "deadline") {
    super(
      kind === "inactivity"
        ? `Daytona command produced no output for ${timeoutMs}ms.`
        : `Daytona command did not finish within ${timeoutMs}ms.`,
    );
    this.name = "AgentHarnessCommandTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Signals that an OpenCode agent command exited nonzero without emitting any
 * output of its own — only PTY bootstrap echo. The agent runtime never spoke,
 * so the failure belongs to the sandbox/PTY/runner infrastructure seam and
 * must never be reported as an artifact-contract problem.
 */
export class AgentHarnessAgentLaunchError extends Error {
  readonly attempts: number;
  readonly exitCode: number;

  constructor(input: { attempts: number; exitCode: number; stage: string }) {
    super(
      `${input.stage} agent runner exited ${input.exitCode} with no OpenCode output in ${input.attempts} launch attempt(s) — agent-runtime infrastructure failure.`,
    );
    this.name = "AgentHarnessAgentLaunchError";
    this.attempts = input.attempts;
    this.exitCode = input.exitCode;
  }
}

/** Signals that a Daytona sandbox stayed unavailable after one bounded restart. */
export class AgentHarnessSandboxUnavailableError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Daytona sandbox ${sandboxId} remained unavailable after restart: ${causeMessage}`,
      { cause },
    );
    this.name = "AgentHarnessSandboxUnavailableError";
    this.sandboxId = sandboxId;
  }
}

/** Returns true only for failures owned by the agent/sandbox infrastructure seam. */
export function isAgentHarnessInfrastructureError(
  error: unknown,
): error is
  | AgentHarnessAgentLaunchError
  | AgentHarnessArtifactTransferError
  | AgentHarnessCommandTimeoutError
  | AgentHarnessSandboxUnavailableError {
  return (
    error instanceof AgentHarnessAgentLaunchError ||
    error instanceof AgentHarnessArtifactTransferError ||
    error instanceof AgentHarnessCommandTimeoutError ||
    error instanceof AgentHarnessSandboxUnavailableError
  );
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
  /** Maximum silence between streamed output chunks; omitted for no idle limit. */
  inactivityTimeoutMs?: number;
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
  endedAt?: string;
  exitCode?: number;
  running: boolean;
  signal?: string;
  startedAt?: string;
  stderr: string;
  stdout: string;
  terminationReason?: "controlled-stop" | "exited" | "signaled" | "unknown";
};

export type AgentHarnessNetworkStateTransition = {
  at: string;
  state:
    | "dependency-install-closed"
    | "dependency-install-open"
    | "runtime-locked";
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
  startSubmittedCodeApp?(
    input: AgentHarnessSubmittedCodeAppStartInput,
  ): Promise<void>;
  readSubmittedCodeAppStatus?(): Promise<AgentHarnessSubmittedCodeAppStatus>;
  stopSubmittedCodeApp?(): Promise<void>;
  syncSubmittedCodeWorkspace?(): Promise<void>;
  /**
   * Copies only backend-approved dependency metadata from the submitted-code
   * sandbox into the prepared agent workspace so a later clean sync retains a
   * deterministic package-manager repair. Implementations must reject paths
   * outside the repository and files other than recognized lockfiles.
   */
  promoteSubmittedCodeFiles?(paths: string[]): Promise<void>;
  setSubmittedCodeNetworkAccess?(enabled: boolean): Promise<void>;
  getPreviewUrl?(port: number): Promise<string>;
  writeSandboxLog?(entry: AgentHarnessWorkspaceLogEntry): Promise<void>;
  /**
   * Writes exact UTF-8 text into the agent sandbox without exposing it to the
   * submitted-code sandbox or transporting the contents as a shell argument.
   */
  writeTextFile?(path: string, contents: string): Promise<void>;
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

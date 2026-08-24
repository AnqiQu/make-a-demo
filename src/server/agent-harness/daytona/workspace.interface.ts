import { readErrorMessage } from "../../shared/text/read-error-message";
import type { DependencyInstallCommandResult } from "../tools/dependency-install-gate";

export type AgentHarnessWorkspaceCommandResult = DependencyInstallCommandResult;

/**
 * Signals that a workspace command's outcome was never observed: it exceeded
 * its caller-provided deadline, went silent past its inactivity window, or
 * its transport ended without carrying the command's exit status. Adapters
 * must use this error only for those unknown-outcome shapes so orchestration
 * can safely convert it into bounded agent feedback and retry behavior.
 */
export class AgentHarnessCommandTimeoutError extends Error {
  readonly kind: "deadline" | "inactivity" | "transport";
  readonly timeoutMs: number;

  constructor(
    timeoutMs: number,
    kind: "deadline" | "inactivity" | "transport" = "deadline",
  ) {
    super(
      kind === "inactivity"
        ? `Daytona command produced no output for ${timeoutMs}ms.`
        : kind === "transport"
          ? "Daytona PTY session ended without the command's exit trailer; the command's outcome is unknown."
          : `Daytona command did not finish within ${timeoutMs}ms.`,
    );
    this.name = "AgentHarnessCommandTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Signals that the whole pipeline job exceeded its wall-clock budget, or —
 * when `refusedRepairCycle` is present — that the orchestrator refused to
 * admit another repair cycle the remaining budget provably cannot fit
 * (N165: calcom's round 5 was admitted with ~1 minute left and killed 12
 * seconds in). The orchestrator throws this at stage-loop boundaries so a
 * repair spiral ends as one classified timeout with the accumulated stage
 * evidence instead of a many-hour hang; it must never be converted into
 * agent retry feedback. A refusal names the remaining budget and the bound
 * that outweighed it so the run report explains the early stop.
 */
export class AgentHarnessJobDeadlineError extends Error {
  readonly jobDeadlineMs: number;
  readonly refusedRepairCycle?: {
    fastestCompletedCycleMs?: number;
    remainingMs: number;
    requiredMs: number;
  };

  constructor(
    jobDeadlineMs: number,
    refusedRepairCycle?: {
      fastestCompletedCycleMs?: number;
      remainingMs: number;
      requiredMs: number;
    },
  ) {
    const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} minutes`;
    super(
      refusedRepairCycle === undefined
        ? `Agent harness job exceeded its ${Math.round(jobDeadlineMs / 60_000)}-minute wall-clock budget.`
        : `Agent harness job refused another repair cycle: ${minutes(refusedRepairCycle.remainingMs)} of its ${Math.round(jobDeadlineMs / 60_000)}-minute wall-clock budget remain and ${
            refusedRepairCycle.fastestCompletedCycleMs === undefined
              ? `no repair cycle has completed yet (admission floor: ${minutes(refusedRepairCycle.requiredMs)})`
              : `the fastest completed repair cycle took ${minutes(refusedRepairCycle.fastestCompletedCycleMs)}`
          }.`,
    );
    this.name = "AgentHarnessJobDeadlineError";
    this.jobDeadlineMs = jobDeadlineMs;
    if (refusedRepairCycle !== undefined) {
      this.refusedRepairCycle = refusedRepairCycle;
    }
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

/**
 * Signals that a Daytona control-plane operation (sandbox create/delete/
 * start, network update, filesystem transfer) stayed failed after the
 * envelope's bounded classify-and-retry. The failure belongs to the
 * infrastructure seam — it carries retry-the-job semantics and must never
 * be converted into agent repair feedback or a Preparation Fallback Prompt
 * (midday's maker-facing 409 prompt is the forbidden shape, 2026-08-09).
 */
export class AgentHarnessControlPlaneError extends Error {
  readonly attempts: number;
  readonly classification: "conflict" | "transient";
  readonly operation: string;
  readonly sandboxId?: string;

  constructor(input: {
    attempts: number;
    cause: unknown;
    classification: "conflict" | "transient";
    operation: string;
    sandboxId?: string;
  }) {
    const causeMessage =
      input.cause instanceof Error
        ? `${input.cause.name}: ${input.cause.message}`
        : String(input.cause);
    super(
      `Daytona control-plane operation ${input.operation} failed after ${input.attempts} attempt(s) (${input.classification}): ${causeMessage}`,
      { cause: input.cause },
    );
    this.name = "AgentHarnessControlPlaneError";
    this.attempts = input.attempts;
    this.classification = input.classification;
    this.operation = input.operation;
    if (input.sandboxId !== undefined) {
      this.sandboxId = input.sandboxId;
    }
  }
}

/** Signals that a Daytona sandbox stayed unavailable after one bounded restart. */
export class AgentHarnessSandboxUnavailableError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string, cause: unknown) {
    const causeMessage = readErrorMessage(cause);
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
  | AgentHarnessControlPlaneError
  | AgentHarnessJobDeadlineError
  | AgentHarnessSandboxUnavailableError {
  return (
    error instanceof AgentHarnessAgentLaunchError ||
    error instanceof AgentHarnessArtifactTransferError ||
    error instanceof AgentHarnessCommandTimeoutError ||
    error instanceof AgentHarnessControlPlaneError ||
    error instanceof AgentHarnessJobDeadlineError ||
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

/**
 * The command duration the seam guarantees when `timeoutMs` is omitted.
 * Providers must apply exactly this bound so callers and decorators can
 * reason about an omitted timeout without knowing the provider (N156: the
 * deadline cap substitutes this value before clamping to the job budget).
 */
export const defaultWorkspaceCommandTimeoutMs = 10 * 60_000;

export type AgentHarnessWorkspaceExecuteOptions = {
  /**
   * Decides whether a streamed output chunk counts as liveness for the
   * `inactivityTimeoutMs` watchdog (N170). Providers must consult it on
   * every chunk before touching the watchdog, must still deliver every
   * chunk to `onStdout`/`onStderr` regardless of the verdict, and must
   * fail open — a filter that throws counts the chunk as activity, never
   * as silence. Omitted means every chunk counts (the pre-N170 behavior).
   */
  activityFilter?: (chunk: string) => boolean;
  env?: Record<string, string>;
  /** Maximum silence between streamed output chunks; omitted for no idle limit. */
  inactivityTimeoutMs?: number;
  /**
   * Receives streamed stderr only from implementations with a separate error
   * channel. PTY-backed implementations merge both streams at the terminal, so
   * they deliver everything through `onStdout`; callers must not treat an
   * empty `onStderr` as proof that the command produced no error output.
   */
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  /**
   * How the adapter may respond to a transient control-plane failure whose
   * outcome is unknown (the request may or may not have reached the sandbox).
   * `"transient"` re-issues the command on an escalating ladder — at-least-once
   * semantics, legal only for idempotent commands. `"none"` never re-issues;
   * the failure surfaces as a classified infrastructure error.
   *
   * Defaults differ by sandbox: `execute` (agent sandbox) defaults to
   * `"transient"` because its commands are harness-authored bookkeeping that
   * must stay idempotent — callers running at-most-once commands (patch
   * application) must pass `"none"`. `executeSubmittedCode` defaults to
   * `"none"` because submitted-code commands can drive the app under test
   * (exploration crawls, capture scripts) and a masked success must never be
   * double-executed — provably idempotent reads opt into `"transient"`.
   * Command deadlines are never re-issued under either setting: a timeout is
   * the command's outcome, not transport loss.
   */
  retry?: "none" | "transient";
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
  executeSubmittedCode(
    command: string,
    options?: AgentHarnessWorkspaceExecuteOptions,
  ): Promise<AgentHarnessWorkspaceCommandResult>;
  startSubmittedCodeApp(
    input: AgentHarnessSubmittedCodeAppStartInput,
  ): Promise<void>;
  readSubmittedCodeAppStatus(): Promise<AgentHarnessSubmittedCodeAppStatus>;
  stopSubmittedCodeApp(): Promise<void>;
  syncSubmittedCodeWorkspace(): Promise<void>;
  /**
   * Copies only backend-approved dependency metadata from the submitted-code
   * sandbox into the prepared agent workspace so a later clean sync retains a
   * deterministic package-manager repair. Implementations must reject paths
   * outside the repository and files other than recognized lockfiles.
   */
  promoteSubmittedCodeFiles(paths: string[]): Promise<void>;
  setSubmittedCodeNetworkAccess(enabled: boolean): Promise<void>;
  writeSandboxLog(entry: AgentHarnessWorkspaceLogEntry): Promise<void>;
  /**
   * Writes exact UTF-8 text into the agent sandbox without exposing it to the
   * submitted-code sandbox or transporting the contents as a shell argument.
   */
  writeTextFile(path: string, contents: string): Promise<void>;
  uploadFiles(files: AgentHarnessWorkspaceUploadFile[]): Promise<void>;
  /**
   * Uploads runtime inputs only to the submitted-code trust boundary.
   * Implementations must not copy these files into an agent sandbox.
   */
  uploadSubmittedCodeFiles(
    files: AgentHarnessWorkspaceUploadFile[],
  ): Promise<void>;
  /**
   * Downloads runtime artifacts only from the submitted-code trust boundary.
   */
  downloadSubmittedCodeFiles(
    files: AgentHarnessWorkspaceDownloadFile[],
  ): Promise<void>;
  collectSandboxLogs(): Promise<string[]>;
  collectNetworkStateLog(): Promise<AgentHarnessNetworkStateTransition[]>;
}

export type AgentHarnessWorkspaceHandle = {
  destroy(): Promise<void>;
  id: string;
  workspace: AgentHarnessWorkspace;
};

/** Resource class chosen before submitted code starts running. */
export type SubmittedCodeSandboxClass = "heavyweight" | "standard";

/**
 * Creation policy for a paired agent/submitted-code workspace. Providers
 * realize the selected class by choosing WHICH snapshot backs the
 * submitted-code sandbox (a snapshot-created sandbox inherits the snapshot's
 * resource spec; resource overrides are rejected — N147), never by weakening
 * its network isolation or lifecycle cleanup guarantees. A provider without a
 * heavyweight variant configured must still create the workspace on its
 * standard class rather than fail.
 */
export type AgentHarnessWorkspaceCreateInput = {
  submittedCodeSandboxClass: SubmittedCodeSandboxClass;
};

export interface AgentHarnessWorkspaceProvider {
  create(
    input?: AgentHarnessWorkspaceCreateInput,
  ): Promise<AgentHarnessWorkspaceHandle>;
}

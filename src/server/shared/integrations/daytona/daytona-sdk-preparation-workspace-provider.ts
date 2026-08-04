import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { Daytona } from "@daytona/sdk";

import type {
  AgentHarnessNetworkStateTransition,
  AgentHarnessSubmittedCodeAppStartInput,
  AgentHarnessSubmittedCodeAppStatus,
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceCommandResult,
  AgentHarnessWorkspaceDownloadFile,
  AgentHarnessWorkspaceExecuteOptions,
  AgentHarnessWorkspaceHandle,
  AgentHarnessWorkspaceLogEntry,
  AgentHarnessWorkspaceProvider,
  AgentHarnessWorkspaceUploadFile,
} from "../../../agent-harness/daytona/workspace.interface";
import {
  AgentHarnessArtifactTransferError,
  AgentHarnessCommandTimeoutError,
  AgentHarnessSandboxUnavailableError,
} from "../../../agent-harness/daytona/workspace.interface";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";

type DaytonaSdkClient = {
  create(
    input?: unknown,
    options?: { timeout?: number },
  ): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
  get?(idOrName: string): Promise<DaytonaSdkSandbox>;
};

type DaytonaSdkSandbox = {
  fs: {
    downloadFiles(
      files: Array<{ destination: string; source: string }>,
      timeoutSec?: number,
    ): Promise<Array<{ error?: string; source: string }>>;
    uploadFiles(
      files: Array<{ destination: string; source: string }>,
      timeoutSec?: number,
    ): Promise<void>;
  };
  id?: string;
  name?: string;
  refreshData?(): Promise<void>;
  process: {
    createPty(options: {
      id: string;
      cwd?: string;
      envs?: Record<string, string>;
      cols?: number;
      rows?: number;
      onData: (data: Uint8Array) => void | Promise<void>;
    }): Promise<{
      disconnect(): Promise<void>;
      kill(): Promise<void>;
      sendInput(data: string | Uint8Array): Promise<void>;
      wait(): Promise<{ error?: string; exitCode?: number }>;
      waitForConnection(): Promise<void>;
    }>;
    createSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{
      exitCode?: number;
      result?: string;
      stderr?: string;
      stdout?: string;
    }>;
    executeSessionCommand(
      sessionId: string,
      request: {
        command: string;
        runAsync?: boolean;
        suppressInputEcho?: boolean;
      },
    ): Promise<{ cmdId?: string }>;
    getSessionCommand(
      sessionId: string,
      commandId: string,
    ): Promise<{ exitCode?: number }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
    ): Promise<{ stderr?: string; stdout?: string } | undefined>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<{ stderr?: string; stdout?: string } | undefined>;
  };
  start?(timeout?: number): Promise<void>;
  updateNetworkSettings(settings: {
    networkBlockAll?: boolean;
  }): Promise<void>;
};

type DaytonaSdkPty = Awaited<
  ReturnType<DaytonaSdkSandbox["process"]["createPty"]>
>;
type DaytonaSdkPtyOptions = Parameters<
  DaytonaSdkSandbox["process"]["createPty"]
>[0];

type ManagedSubmittedCodeApp = {
  commandId: string;
  endedAt?: string;
  sessionId: string;
  startedAt: string;
};

export type DaytonaSdkPreparationWorkspaceProviderOptions = {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  diskGB?: number;
  logWriteTimeoutMs?: number;
  ptyConnectionTimeoutMs?: number;
  sandboxCreateTimeoutSeconds?: number;
  sandboxLogSinks?: PipelineLogSink[];
  secrets?: Record<string, string>;
  snapshot?: string;
  submittedCodeSnapshot?: string;
};

const defaultSandboxDiskGB = 3;
const defaultCommandTimeoutMs = 10 * 60_000;
const defaultLogWriteTimeoutMs = 5_000;
const defaultPtyConnectionTimeoutMs = 30_000;
const defaultPtyDisconnectTimeoutMs = 5_000;
const defaultManagedProcessControlTimeoutMs = 30_000;
const defaultArtifactTransferTimeoutSeconds = 60;
const defaultSandboxCreateTimeoutSeconds = 300;
const sandboxCreateConnectionRetryLimit = 2;
/**
 * Server-side reaper for agent sandboxes, sized well past the longest observed
 * run so it never cuts a live pipeline short; destroy() remains the normal path.
 */
const agentSandboxAutoDeleteMinutes = 720;
const ptyStartupRetryLimit = 2;
const artifactTransferRetryLimit = 2;
const makeADemoArtifactDirectory = "/tmp/makeademo";
const workspaceMakeADemoDirectory = "/workspace/.makeademo";
const sandboxAuditLogPath = `${makeADemoArtifactDirectory}/sandbox-log.jsonl`;
/**
 * Log collection runs during teardown, exactly when a failing run most needs
 * its evidence: it gets a generous budget independent of the per-line write
 * timeout, and a byte cap so a runaway log cannot stall teardown.
 */
const sandboxLogCollectionTimeoutMs = 60_000;
const sandboxLogCollectionByteCap = 5 * 1024 * 1024;
const submittedCodeRuntimeTempDirectory = `${workspaceMakeADemoDirectory}/runtime-tmp`;

export async function createDaytonaSdkPreparationWorkspaceHandle(input: {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  logWriteTimeoutMs?: number;
  sandboxId: string;
  sandboxLogSinks?: PipelineLogSink[];
  ptyConnectionTimeoutMs?: number;
}): Promise<AgentHarnessWorkspaceHandle> {
  const client =
    input.client ??
    (new Daytona(
      input.apiKey === undefined ? undefined : { apiKey: input.apiKey },
    ) as DaytonaSdkClient);
  if (client.get === undefined) {
    throw new Error("Daytona client does not support sandbox lookup.");
  }
  const sandbox = await client.get(input.sandboxId);

  return createPreparationWorkspaceHandle({
    client,
    commandTimeoutMs: input.commandTimeoutMs ?? defaultCommandTimeoutMs,
    id: input.sandboxId,
    logWriteTimeoutMs: input.logWriteTimeoutMs ?? defaultLogWriteTimeoutMs,
    ptyConnectionTimeoutMs:
      input.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs,
    sandboxLogSinks: input.sandboxLogSinks ?? [],
    sandbox,
  });
}

export class DaytonaSdkPreparationWorkspaceProvider
  implements AgentHarnessWorkspaceProvider
{
  private readonly client: DaytonaSdkClient;
  private readonly commandTimeoutMs: number;
  private readonly diskGB: number;
  private readonly logWriteTimeoutMs: number;
  private readonly ptyConnectionTimeoutMs: number;
  private readonly sandboxCreateTimeoutSeconds: number;
  private readonly sandboxLogSinks: PipelineLogSink[];
  private readonly secrets: Record<string, string> | undefined;
  private readonly snapshot: string | undefined;
  private readonly submittedCodeSnapshot: string | undefined;

  constructor(options: DaytonaSdkPreparationWorkspaceProviderOptions = {}) {
    this.client =
      options.client ??
      (new Daytona(
        options.apiKey === undefined ? undefined : { apiKey: options.apiKey },
      ) as DaytonaSdkClient);
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.secrets = options.secrets;
    this.snapshot = options.snapshot;
    this.submittedCodeSnapshot = options.submittedCodeSnapshot;
    this.diskGB = options.diskGB ?? defaultSandboxDiskGB;
    this.logWriteTimeoutMs =
      options.logWriteTimeoutMs ?? defaultLogWriteTimeoutMs;
    this.ptyConnectionTimeoutMs =
      options.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs;
    this.sandboxCreateTimeoutSeconds =
      options.sandboxCreateTimeoutSeconds ?? defaultSandboxCreateTimeoutSeconds;
    this.sandboxLogSinks = options.sandboxLogSinks ?? [];
  }

  async create(): Promise<AgentHarnessWorkspaceHandle> {
    const createOptions = { timeout: this.sandboxCreateTimeoutSeconds };
    const sandbox = await this.createSandboxWithConnectionRetry(
      {
        // Server-side backstop: if the controller dies before destroy(), the
        // agent sandbox still gets reaped instead of running indefinitely.
        autoDeleteInterval: agentSandboxAutoDeleteMinutes,
        autoStopInterval: 0,
        disk: this.diskGB,
        ...(this.secrets === undefined ? {} : { secrets: this.secrets }),
        ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
      },
      createOptions,
    );
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    let submittedCodeSandbox: DaytonaSdkSandbox | undefined;
    try {
      submittedCodeSandbox =
        this.submittedCodeSnapshot === undefined
          ? undefined
          : await this.createSandboxWithConnectionRetry(
              {
                autoStopInterval: 0,
                autoDeleteInterval: 0,
                ephemeral: true,
                linkedSandbox: id,
                networkBlockAll: true,
                snapshot: this.submittedCodeSnapshot,
              },
              createOptions,
            );
    } catch (error) {
      // The linked-create failure is the root cause; a failing compensating
      // delete must not replace it. The auto-delete backstop reaps the parent.
      await this.deleteSandboxBestEffort(sandbox);
      throw error;
    }

    return createPreparationWorkspaceHandle({
      client: this.client,
      commandTimeoutMs: this.commandTimeoutMs,
      id,
      logWriteTimeoutMs: this.logWriteTimeoutMs,
      ptyConnectionTimeoutMs: this.ptyConnectionTimeoutMs,
      sandboxLogSinks: this.sandboxLogSinks,
      sandbox,
      ...(submittedCodeSandbox === undefined ? {} : { submittedCodeSandbox }),
    });
  }

  private async deleteSandboxBestEffort(
    sandbox: DaytonaSdkSandbox,
  ): Promise<void> {
    const [result] = await Promise.allSettled([this.client.delete(sandbox)]);
    if (result?.status === "rejected") {
      await this.writeProviderLogBestEffort({
        event: "sandbox.compensating-delete.failed",
        message: `Compensating delete failed for sandbox ${sandbox.id ?? sandbox.name}; the auto-delete backstop must reap it.`,
      });
    }
  }

  private async writeProviderLogBestEffort(
    entry: AgentHarnessWorkspaceLogEntry,
  ): Promise<void> {
    for (const sink of this.sandboxLogSinks) {
      try {
        sink.write(`${JSON.stringify(entry)}\n`);
      } catch {
        // Diagnostics must never mask the failure being reported.
      }
    }
  }

  private async createSandboxWithConnectionRetry(
    input: unknown,
    options: { timeout: number },
  ): Promise<DaytonaSdkSandbox> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= sandboxCreateConnectionRetryLimit;
      attempt += 1
    ) {
      try {
        return await this.client.create(input, options);
      } catch (error) {
        lastError = error;
        if (
          attempt === sandboxCreateConnectionRetryLimit ||
          !isDaytonaConnectionError(error)
        ) {
          throw error;
        }

        await wait(250 * (attempt + 1));
      }
    }

    throw lastError;
  }
}

function createPreparationWorkspaceHandle(input: {
  client: DaytonaSdkClient;
  commandTimeoutMs: number;
  id: string;
  logWriteTimeoutMs: number;
  ptyConnectionTimeoutMs: number;
  sandboxLogSinks?: PipelineLogSink[];
  sandbox: DaytonaSdkSandbox;
  submittedCodeSandbox?: DaytonaSdkSandbox;
}): AgentHarnessWorkspaceHandle {
  const workspace = new DaytonaSdkPreparationWorkspace(
    input.sandbox,
    input.submittedCodeSandbox,
    input.client,
    input.id,
    input.commandTimeoutMs,
    input.logWriteTimeoutMs,
    input.ptyConnectionTimeoutMs,
    input.sandboxLogSinks ?? [],
  );

  return {
    async destroy() {
      await workspace.destroy();
    },
    id: input.id,
    workspace,
  };
}

class DaytonaSdkPreparationWorkspace implements AgentHarnessWorkspace {
  readonly agentSandboxId: string;
  private readonly activePtys = new Set<ManagedPty>();
  private activeSubmittedCodeApp: ManagedSubmittedCodeApp | undefined;
  private readonly networkStateTransitions: AgentHarnessNetworkStateTransition[];
  /** True after org policy rejected a network open, proving the sandbox stayed blocked. */
  private networkOverrideRestricted = false;
  private readonly sandboxLogger: PipelineEventLogger;
  readonly submittedCodeSandboxId?: string;

  constructor(
    private readonly sandbox: DaytonaSdkSandbox,
    private readonly submittedCodeSandbox: DaytonaSdkSandbox | undefined,
    private readonly client: DaytonaSdkClient,
    private readonly workspaceId: string,
    private readonly commandTimeoutMs: number,
    private readonly logWriteTimeoutMs: number,
    private readonly ptyConnectionTimeoutMs: number,
    sandboxLogSinks: PipelineLogSink[],
  ) {
    this.agentSandboxId = workspaceId;
    const submittedCodeSandboxId =
      submittedCodeSandbox?.id ?? submittedCodeSandbox?.name;
    if (submittedCodeSandboxId !== undefined) {
      this.submittedCodeSandboxId = submittedCodeSandboxId;
    }
    this.networkStateTransitions =
      submittedCodeSandbox === undefined
        ? []
        : [{ at: new Date().toISOString(), state: "runtime-locked" }];
    this.sandboxLogger = createPipelineEventLogger({
      base: {
        component: "daytona-sandbox",
      },
      sinks: [
        { write: (line) => this.writeSandboxLogLine(line) },
        ...sandboxLogSinks,
      ],
    });
  }

  private agentSandboxDeleted = false;
  private submittedCodeSandboxDeleted = false;

  async destroy(): Promise<void> {
    if (
      this.agentSandboxDeleted &&
      (this.submittedCodeSandbox === undefined ||
        this.submittedCodeSandboxDeleted)
    ) {
      return;
    }
    await this.cancelActiveCommands();
    const failures: unknown[] = [];
    if (
      this.submittedCodeSandbox !== undefined &&
      !this.submittedCodeSandboxDeleted
    ) {
      try {
        await this.deleteSandboxThroughStateConflict(this.submittedCodeSandbox);
        this.submittedCodeSandboxDeleted = true;
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          this.submittedCodeSandboxDeleted = true;
        } else {
          failures.push(error);
        }
      }
    }
    if (!this.agentSandboxDeleted) {
      try {
        await this.deleteSandboxThroughStateConflict(this.sandbox);
        this.agentSandboxDeleted = true;
      } catch (error) {
        if (isDaytonaNotFoundError(error)) {
          this.agentSandboxDeleted = true;
        } else {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to delete Daytona sandboxes.");
    }
  }

  /**
   * Deletes a sandbox, retrying once past a state-change conflict. Daytona
   * reports 409 while a sandbox is still settling, which is transient rather
   * than a reason to leave the sandbox running.
   */
  private async deleteSandboxThroughStateConflict(
    sandbox: DaytonaSdkSandbox,
  ): Promise<void> {
    try {
      await this.client.delete(sandbox);
    } catch (error) {
      if (!isDaytonaStateConflictError(error)) throw error;
      await this.client.delete(sandbox);
    }
  }

  async execute(
    command: string,
    options: AgentHarnessWorkspaceExecuteOptions = {},
  ): Promise<AgentHarnessWorkspaceCommandResult> {
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreaming(command, options);
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.sandbox.process.executeCommand(
        command,
        undefined,
        options.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      () => new AgentHarnessCommandTimeoutError(timeoutMs),
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  private async executeStreaming(
    command: string,
    options: AgentHarnessWorkspaceExecuteOptions,
  ): Promise<AgentHarnessWorkspaceCommandResult> {
    const output: string[] = [];
    const decoder = new TextDecoder();
    const exitSentinel = createExitSentinel();
    const inactivityDeadline = createCommandInactivityDeadline(
      options.inactivityTimeoutMs,
      (driftMs) => this.logHostClockDriftBestEffort(driftMs),
    );
    const pty = await this.createConnectedPty(this.sandbox, {
      cols: 120,
      cwd: "/workspace",
      envs: options.env ?? {},
      id: `makeademo-${randomUUID()}`,
      onData: (data) => {
        inactivityDeadline.touch();
        const chunk = decoder.decode(data);
        output.push(chunk);
        const visibleChunk = removeExitMarker(chunk, exitSentinel);
        if (visibleChunk.length > 0) {
          options.onStdout?.(visibleChunk);
        }
      },
      rows: 30,
    });

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    try {
      await pty.sendInput(
        `stty -echo\n${command}\nprintf '\\n${exitSentinel}:%s\\n' $?\nexit\n`,
      );
      inactivityDeadline.touch();
      const result = await withTimeout(
        Promise.race([pty.wait(), inactivityDeadline.expired]),
        timeoutMs,
        () => new AgentHarnessCommandTimeoutError(timeoutMs),
      );
      const stdout = output.join("");
      const exitCode =
        readExitCode(stdout, exitSentinel) ?? result.exitCode ?? 0;

      return {
        exitCode,
        stderr: result.error ?? "",
        stdout: removeExitMarker(stdout, exitSentinel),
      };
    } catch (error) {
      if (error instanceof AgentHarnessCommandTimeoutError) {
        await this.terminatePtyBestEffort(pty, timeoutMs);
      }
      throw error;
    } finally {
      inactivityDeadline.dispose();
      this.activePtys.delete(pty);
      await this.disconnectPtyBestEffort(pty, timeoutMs);
    }
  }

  private async cancelActiveCommands(): Promise<void> {
    await Promise.allSettled([
      this.stopSubmittedCodeApp(),
      ...[...this.activePtys].map(async (pty) => {
        await this.terminatePtyBestEffort(pty, defaultPtyDisconnectTimeoutMs);
        await this.disconnectPtyBestEffort(pty, defaultPtyDisconnectTimeoutMs);
      }),
    ]);
  }

  async collectSandboxLogs(): Promise<string[]> {
    const collect = () =>
      withTimeout(
        this.sandbox.process.executeCommand(
          `sh -lc ${shellQuote(`test ! -f ${sandboxAuditLogPath} || tail -c ${sandboxLogCollectionByteCap} ${sandboxAuditLogPath}`)}`,
          undefined,
          undefined,
          toSdkTimeoutSeconds(sandboxLogCollectionTimeoutMs),
        ),
        sandboxLogCollectionTimeoutMs,
        `Daytona sandbox log collection did not finish within ${sandboxLogCollectionTimeoutMs}ms.`,
      );
    let response: Awaited<ReturnType<typeof collect>>;
    try {
      response = await collect();
    } catch (error) {
      if (!(await this.restartSandboxIfNotStarted(this.sandbox, error))) {
        throw error;
      }
      try {
        response = await collect();
      } catch (retryError) {
        if (isDaytonaSandboxNotStartedError(retryError)) {
          throw new AgentHarnessSandboxUnavailableError(
            readSandboxId(this.sandbox),
            retryError,
          );
        }
        throw retryError;
      }
    }
    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to collect Daytona sandbox audit log.");
    }

    return (response.stdout ?? response.result ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }

  async writeSandboxLog(entry: AgentHarnessWorkspaceLogEntry): Promise<void> {
    const { source, timestamp, workspaceId, ...fields } = entry;
    await this.sandboxLogger[readSandboxLogLevel(entry)](
      {
        ...fields,
        ...(typeof timestamp === "string" ? { eventTime: timestamp } : {}),
        source: source ?? "makeademo",
        workspaceId:
          typeof workspaceId === "string" && workspaceId.trim().length > 0
            ? workspaceId
            : this.workspaceId,
      },
      readSandboxLogMessage(entry),
    );
  }

  private async writeSandboxLogLine(line: string): Promise<void> {
    const response = await withTimeout(
      this.sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} && printf '%s' ${shellQuote(line)} >> ${shellQuote(sandboxAuditLogPath)}`,
      ),
      this.logWriteTimeoutMs,
      `Daytona sandbox log write did not finish within ${this.logWriteTimeoutMs}ms.`,
    );

    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to write Daytona sandbox audit log.");
    }
  }

  async executeSubmittedCode(
    command: string,
    options: AgentHarnessWorkspaceExecuteOptions = {},
  ): Promise<AgentHarnessWorkspaceCommandResult> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreamingInSandbox(
        this.submittedCodeSandbox,
        command,
        options,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const response = await withTimeout(
      this.submittedCodeSandbox.process.executeCommand(
        command,
        undefined,
        options.env,
        toSdkTimeoutSeconds(timeoutMs),
      ),
      timeoutMs,
      () => new AgentHarnessCommandTimeoutError(timeoutMs),
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async startSubmittedCodeApp(
    input: AgentHarnessSubmittedCodeAppStartInput,
  ): Promise<void> {
    const sandbox = this.requireSubmittedCodeSandbox();
    await this.stopSubmittedCodeApp();

    const sessionId = `makeademo-app-${randomUUID()}`;
    try {
      await withTimeout(
        sandbox.process.createSession(sessionId),
        this.managedProcessControlTimeoutMs,
        `Daytona managed-process session creation did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
      );
      const response = await withTimeout(
        sandbox.process.executeSessionCommand(sessionId, {
          command: createManagedAppCommand(input),
          runAsync: true,
          suppressInputEcho: true,
        }),
        this.managedProcessControlTimeoutMs,
        `Daytona managed-process launch did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
      );
      const commandId = response.cmdId?.trim();
      if (commandId === undefined || commandId.length === 0) {
        throw new Error(
          "Daytona did not return a command id for the submitted-code app.",
        );
      }
      this.activeSubmittedCodeApp = {
        commandId,
        sessionId,
        startedAt: new Date().toISOString(),
      };
    } catch (error) {
      await Promise.allSettled([
        withTimeout(
          sandbox.process.deleteSession(sessionId),
          this.managedProcessControlTimeoutMs,
          `Daytona managed-process cleanup did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
        ),
      ]);
      throw error;
    }
  }

  async readSubmittedCodeAppStatus(): Promise<AgentHarnessSubmittedCodeAppStatus> {
    const sandbox = this.requireSubmittedCodeSandbox();
    const app = this.activeSubmittedCodeApp;
    if (app === undefined) {
      throw new Error("No submitted-code app session is active.");
    }

    const [command, logs] = await Promise.all([
      withTimeout(
        sandbox.process.getSessionCommand(app.sessionId, app.commandId),
        this.managedProcessControlTimeoutMs,
        `Daytona managed-process status did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
      ),
      withTimeout(
        sandbox.process.getSessionCommandLogs(app.sessionId, app.commandId),
        this.managedProcessControlTimeoutMs,
        `Daytona managed-process log collection did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
      ),
    ]);
    const exitCode = command.exitCode;
    if (exitCode !== undefined && app.endedAt === undefined) {
      app.endedAt = new Date().toISOString();
    }

    return {
      ...(app.endedAt === undefined ? {} : { endedAt: app.endedAt }),
      ...(exitCode === undefined ? {} : { exitCode }),
      running: exitCode === undefined,
      startedAt: app.startedAt,
      stderr: logs?.stderr ?? "",
      stdout: logs?.stdout ?? "",
      ...(exitCode === undefined ? {} : { terminationReason: "exited" }),
    };
  }

  async stopSubmittedCodeApp(): Promise<void> {
    const app = this.activeSubmittedCodeApp;
    if (app === undefined) {
      return;
    }
    const sandbox = this.requireSubmittedCodeSandbox();
    await withTimeout(
      sandbox.process.deleteSession(app.sessionId),
      this.managedProcessControlTimeoutMs,
      `Daytona managed-process cleanup did not finish within ${this.managedProcessControlTimeoutMs}ms.`,
    );
    if (this.activeSubmittedCodeApp === app) {
      this.activeSubmittedCodeApp = undefined;
    }
  }

  private requireSubmittedCodeSandbox(): DaytonaSdkSandbox {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }
    return this.submittedCodeSandbox;
  }

  private get managedProcessControlTimeoutMs(): number {
    return Math.min(
      this.commandTimeoutMs,
      defaultManagedProcessControlTimeoutMs,
    );
  }

  async setSubmittedCodeNetworkAccess(enabled: boolean): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    await this.setSandboxNetworkAccess(this.submittedCodeSandbox, enabled);
    const at = new Date().toISOString();
    if (enabled) {
      this.networkStateTransitions.push({
        at,
        state: "dependency-install-open",
      });
      return;
    }
    this.networkStateTransitions.push(
      { at, state: "dependency-install-closed" },
      { at, state: "runtime-locked" },
    );
  }

  async collectNetworkStateLog(): Promise<
    AgentHarnessNetworkStateTransition[]
  > {
    return [...this.networkStateTransitions];
  }

  async syncSubmittedCodeWorkspace(): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    const archiveName = `prepared-workspace-${randomUUID()}.tgz`;
    const remoteArchivePath = `${makeADemoArtifactDirectory}/${archiveName}`;
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-daytona-sync-"),
    );
    const localArchivePath = join(localDirectory, archiveName);

    try {
      const archiveResult = await withTimeout(
        this.sandbox.process.executeCommand(
          createPreparedWorkspaceArchiveCommand(remoteArchivePath),
          undefined,
          undefined,
          toSdkTimeoutSeconds(this.commandTimeoutMs),
        ),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive did not finish within ${this.commandTimeoutMs}ms.`,
      );
      if ((archiveResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            "Failed to archive prepared Daytona workspace",
            archiveResult,
          ),
        );
      }

      const downloadResults = await withTimeout(
        this.sandbox.fs.downloadFiles(
          [{ destination: localArchivePath, source: remoteArchivePath }],
          0,
        ),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive download did not finish within ${this.commandTimeoutMs}ms.`,
      );
      const failedDownload = downloadResults.find(
        (result) => result.error !== undefined,
      );
      if (failedDownload !== undefined) {
        throw new Error(
          `Failed to download prepared Daytona workspace archive ${failedDownload.source}: ${failedDownload.error}`,
        );
      }

      await withTimeout(
        this.submittedCodeSandbox.fs.uploadFiles([
          { destination: remoteArchivePath, source: localArchivePath },
        ]),
        this.commandTimeoutMs,
        `Daytona prepared workspace archive upload did not finish within ${this.commandTimeoutMs}ms.`,
      );
      const extractResult = await withTimeout(
        this.submittedCodeSandbox.process.executeCommand(
          createSubmittedCodeWorkspaceExtractCommand(remoteArchivePath),
          undefined,
          undefined,
          toSdkTimeoutSeconds(this.commandTimeoutMs),
        ),
        this.commandTimeoutMs,
        `Daytona submitted-code workspace restore did not finish within ${this.commandTimeoutMs}ms.`,
      );
      if ((extractResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            "Failed to restore prepared files in submitted-code sandbox",
            extractResult,
          ),
        );
      }
    } finally {
      await Promise.allSettled([
        withTimeout(
          this.sandbox.process.executeCommand(
            `rm -f ${shellQuote(remoteArchivePath)}`,
            undefined,
            undefined,
            toSdkTimeoutSeconds(this.commandTimeoutMs),
          ),
          this.commandTimeoutMs,
          `Daytona prepared workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        withTimeout(
          this.submittedCodeSandbox.process.executeCommand(
            `rm -f ${shellQuote(remoteArchivePath)}`,
            undefined,
            undefined,
            toSdkTimeoutSeconds(this.commandTimeoutMs),
          ),
          this.commandTimeoutMs,
          `Daytona submitted-code workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        rm(localDirectory, { force: true, recursive: true }),
      ]);
    }
  }

  async promoteSubmittedCodeFiles(paths: string[]): Promise<void> {
    const submittedCodeSandbox = this.requireSubmittedCodeSandbox();
    const approvedPaths = [...new Set(paths)].sort().map(assertLockfilePath);
    if (approvedPaths.length === 0) return;
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-lockfile-promotion-"),
    );
    const transfers = approvedPaths.map((path, index) => ({
      destination: `/workspace/repo/${path}`,
      localPath: join(localDirectory, String(index)),
      source: `/workspace/repo/${path}`,
    }));
    try {
      const downloads = await this.runSubmittedCodeArtifactTransfer({
        fileCount: transfers.length,
        operation: "download",
        run: () =>
          submittedCodeSandbox.fs.downloadFiles(
            transfers.map(({ localPath, source }) => ({
              destination: localPath,
              source,
            })),
            defaultArtifactTransferTimeoutSeconds,
          ),
      });
      const failed = downloads.find((result) => result.error !== undefined);
      if (failed !== undefined) {
        throw new Error(
          `Failed to download reconciled lockfile ${failed.source}: ${failed.error}`,
        );
      }
      await this.sandbox.fs.uploadFiles(
        transfers.map(({ destination, localPath }) => ({
          destination,
          source: localPath,
        })),
        defaultArtifactTransferTimeoutSeconds,
      );
    } finally {
      await rm(localDirectory, { force: true, recursive: true });
    }
  }

  private async setSandboxNetworkAccess(
    sandbox: DaytonaSdkSandbox,
    enabled: boolean,
  ): Promise<void> {
    try {
      await sandbox.updateNetworkSettings({ networkBlockAll: !enabled });
      this.networkOverrideRestricted = false;
    } catch (error) {
      if (isRestrictedNetworkPolicyError(error)) {
        if (enabled) {
          // Org policy keeps the sandbox blocked, so the window never opens
          // and installs simply run without network — fail-closed.
          this.networkOverrideRestricted = true;
          return;
        }
        if (this.networkOverrideRestricted) {
          // The open was rejected by the same policy, so the sandbox stayed
          // blocked and this close is already satisfied.
          return;
        }
      }

      throw error;
    }
  }

  async uploadFiles(files: AgentHarnessWorkspaceUploadFile[]): Promise<void> {
    const uploadedFiles = files.map((file) => ({
      destination: file.destinationPath,
      source: file.sourcePath,
    }));
    await this.sandbox.fs.uploadFiles(uploadedFiles);
    await this.submittedCodeSandbox?.fs.uploadFiles(uploadedFiles);
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const transferId = randomUUID();
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-agent-artifact-"),
    );
    const localPath = join(localDirectory, transferId);
    const remoteTemporaryPath = `${path}.upload-${transferId}`;
    const payloadBytes = Buffer.byteLength(contents);
    try {
      await writeFile(localPath, contents, "utf8");
      const directoryResult = await this.sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(dirname(path))}`,
      );
      if ((directoryResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            `Failed to create Daytona artifact directory for ${path}`,
            directoryResult,
          ),
        );
      }
      await this.sandbox.fs.uploadFiles(
        [{ destination: remoteTemporaryPath, source: localPath }],
        defaultArtifactTransferTimeoutSeconds,
      );
      const promotionResult = await this.sandbox.process.executeCommand(
        `mv -f -- ${shellQuote(remoteTemporaryPath)} ${shellQuote(path)}`,
      );
      if ((promotionResult.exitCode ?? 0) !== 0) {
        throw new Error(
          formatCommandFailure(
            `Failed to promote Daytona artifact ${path}`,
            promotionResult,
          ),
        );
      }
    } catch (error) {
      throw new Error(
        `Daytona agent artifact filesystem transfer failed for ${path} (${payloadBytes} bytes): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await rm(localDirectory, { force: true, recursive: true });
      try {
        await this.sandbox.process.executeCommand(
          `rm -f -- ${shellQuote(remoteTemporaryPath)}`,
        );
      } catch {
        // The sandbox is ephemeral and promotion already removed this path on success.
      }
    }
  }

  async uploadSubmittedCodeFiles(
    files: AgentHarnessWorkspaceUploadFile[],
  ): Promise<void> {
    const submittedCodeSandbox = this.requireSubmittedCodeSandbox();
    await this.runSubmittedCodeArtifactTransfer({
      fileCount: files.length,
      operation: "upload",
      run: () =>
        submittedCodeSandbox.fs.uploadFiles(
          files.map((file) => ({
            destination: file.destinationPath,
            source: file.sourcePath,
          })),
          defaultArtifactTransferTimeoutSeconds,
        ),
    });
  }

  async downloadSubmittedCodeFiles(
    files: AgentHarnessWorkspaceDownloadFile[],
  ): Promise<void> {
    const submittedCodeSandbox = this.requireSubmittedCodeSandbox();
    const results = await this.runSubmittedCodeArtifactTransfer({
      fileCount: files.length,
      operation: "download",
      run: () =>
        submittedCodeSandbox.fs.downloadFiles(
          files.map((file) => ({
            destination: file.destinationPath,
            source: file.sourcePath,
          })),
          defaultArtifactTransferTimeoutSeconds,
        ),
    });
    const failed = results.find((result) => result.error !== undefined);
    if (failed !== undefined) {
      throw new Error(
        `Failed to download submitted-code sandbox file ${failed.source}: ${failed.error}`,
      );
    }
  }

  private async runSubmittedCodeArtifactTransfer<T>(input: {
    fileCount: number;
    operation: "download" | "upload";
    run: () => Promise<T>;
  }): Promise<T> {
    const sandboxId =
      this.submittedCodeSandboxId ?? "unknown-submitted-code-sandbox";
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= artifactTransferRetryLimit + 1;
      attempt += 1
    ) {
      await this.writeArtifactTransferLogBestEffort({
        attempt,
        event: `artifact.transfer.${input.operation}.started`,
        fileCount: input.fileCount,
        level: "info",
        sandboxId,
      });
      try {
        const result = await input.run();
        await this.writeArtifactTransferLogBestEffort({
          attempt,
          event: `artifact.transfer.${input.operation}.succeeded`,
          fileCount: input.fileCount,
          level: "info",
          sandboxId,
        });
        return result;
      } catch (error) {
        lastError = error;
        const willRetry =
          attempt <= artifactTransferRetryLimit &&
          isTransientDaytonaArtifactTransferError(error);
        await this.writeArtifactTransferLogBestEffort({
          attempt,
          error: formatErrorDiagnostic(error),
          event: willRetry
            ? `artifact.transfer.${input.operation}.retrying`
            : `artifact.transfer.${input.operation}.failed`,
          fileCount: input.fileCount,
          level: willRetry ? "warn" : "error",
          sandboxId,
        });
        if (!willRetry) {
          throw new AgentHarnessArtifactTransferError({
            attempts: attempt,
            cause: error,
            operation: input.operation,
            sandboxId,
          });
        }
        await wait(250 * attempt);
      }
    }

    throw new AgentHarnessArtifactTransferError({
      attempts: artifactTransferRetryLimit + 1,
      cause: lastError,
      operation: input.operation,
      sandboxId,
    });
  }

  private async writeArtifactTransferLogBestEffort(input: {
    attempt: number;
    error?: string;
    event: string;
    fileCount: number;
    level: "error" | "info" | "warn";
    sandboxId: string;
  }): Promise<void> {
    try {
      await this.writeSandboxLog({
        ...input,
        message: `${input.event} for ${input.fileCount} file(s).`,
      });
    } catch {
      // Artifact transfer behavior must not be replaced by observability failures.
    }
  }

  private logHostClockDriftBestEffort(driftMs: number): void {
    void this.writeSandboxLog({
      driftMs,
      event: "host.clock.drift",
      message: `Host clock drifted ${driftMs}ms past the command inactivity window (host asleep?); re-armed the watchdog instead of killing the command.`,
    }).catch(() => {
      // The drift diagnostic must never replace or break the guarded command.
    });
  }

  private async executeStreamingInSandbox(
    sandbox: DaytonaSdkSandbox,
    command: string,
    options: AgentHarnessWorkspaceExecuteOptions,
  ): Promise<AgentHarnessWorkspaceCommandResult> {
    const output: string[] = [];
    const decoder = new TextDecoder();
    const exitSentinel = createExitSentinel();
    const inactivityDeadline = createCommandInactivityDeadline(
      options.inactivityTimeoutMs,
      (driftMs) => this.logHostClockDriftBestEffort(driftMs),
    );
    const pty = await this.createConnectedPty(sandbox, {
      cols: 120,
      cwd: "/workspace",
      envs: options.env ?? {},
      id: `makeademo-${randomUUID()}`,
      onData: (data) => {
        inactivityDeadline.touch();
        const chunk = decoder.decode(data);
        output.push(chunk);
        const visibleChunk = removeExitMarker(chunk, exitSentinel);
        if (visibleChunk.length > 0) {
          options.onStdout?.(visibleChunk);
        }
      },
      rows: 30,
    });

    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    try {
      await pty.sendInput(
        `stty -echo\n${command}\nprintf '\n${exitSentinel}:%s\n' $?\nexit\n`,
      );
      inactivityDeadline.touch();
      const result = await withTimeout(
        Promise.race([pty.wait(), inactivityDeadline.expired]),
        timeoutMs,
        () => new AgentHarnessCommandTimeoutError(timeoutMs),
      );
      const stdout = output.join("");
      const exitCode =
        readExitCode(stdout, exitSentinel) ?? result.exitCode ?? 0;

      return {
        exitCode,
        stderr: result.error ?? "",
        stdout: removeExitMarker(stdout, exitSentinel),
      };
    } catch (error) {
      if (error instanceof AgentHarnessCommandTimeoutError) {
        await this.terminatePtyBestEffort(pty, timeoutMs);
      }
      throw error;
    } finally {
      inactivityDeadline.dispose();
      this.activePtys.delete(pty);
      await this.disconnectPtyBestEffort(pty, timeoutMs);
    }
  }

  private async createConnectedPty(
    sandbox: DaytonaSdkSandbox,
    options: DaytonaSdkPtyOptions,
  ): Promise<ManagedPty> {
    let lastError: unknown;
    let sandboxRestarted = false;
    for (let attempt = 1; attempt <= ptyStartupRetryLimit + 1; attempt += 1) {
      let pty: ManagedPty | undefined;

      try {
        const rawPty = await sandbox.process.createPty({
          ...options,
          id: attempt === 1 ? options.id : `makeademo-${randomUUID()}`,
        });
        pty = new ManagedPty(rawPty);
        this.activePtys.add(pty);
        await withTimeout(
          pty.waitForConnection(),
          this.ptyConnectionTimeoutMs,
          `Daytona PTY did not connect within ${this.ptyConnectionTimeoutMs}ms.`,
        );
        return pty;
      } catch (error) {
        lastError = error;
        if (pty !== undefined) {
          this.activePtys.delete(pty);
          await this.disconnectPtyBestEffort(pty, this.ptyConnectionTimeoutMs);
        }

        if (
          !sandboxRestarted &&
          (await this.restartSandboxIfNotStarted(sandbox, error))
        ) {
          sandboxRestarted = true;
          continue;
        }

        if (attempt > ptyStartupRetryLimit) {
          if (isDaytonaSandboxNotStartedError(error)) {
            throw new AgentHarnessSandboxUnavailableError(
              readSandboxId(sandbox),
              error,
            );
          }
          throw error;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Daytona PTY startup failed.");
  }

  private async restartSandboxIfNotStarted(
    sandbox: DaytonaSdkSandbox,
    error: unknown,
  ): Promise<boolean> {
    if (
      !isDaytonaSandboxNotStartedError(error) ||
      sandbox.start === undefined
    ) {
      return false;
    }
    await sandbox.refreshData?.();
    await sandbox.start(defaultSandboxCreateTimeoutSeconds);
    return true;
  }

  private async disconnectPtyBestEffort(
    pty: ManagedPty,
    operationTimeoutMs: number,
  ): Promise<void> {
    const timeoutMs = Math.max(
      1,
      Math.min(operationTimeoutMs, defaultPtyDisconnectTimeoutMs),
    );
    await Promise.allSettled([
      withTimeout(
        pty.disconnect(),
        timeoutMs,
        `Daytona PTY disconnection did not finish within ${timeoutMs}ms.`,
      ),
    ]);
  }

  private async terminatePtyBestEffort(
    pty: ManagedPty,
    operationTimeoutMs: number,
  ): Promise<void> {
    const timeoutMs = Math.max(
      1,
      Math.min(operationTimeoutMs, defaultPtyDisconnectTimeoutMs),
    );
    await Promise.allSettled([
      withTimeout(
        pty.kill(),
        timeoutMs,
        `Daytona PTY termination did not finish within ${timeoutMs}ms.`,
      ),
    ]);
  }
}

class ManagedPty {
  private disconnected = false;
  private killed = false;

  constructor(private readonly pty: DaytonaSdkPty) {}

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    await this.pty.disconnect();
  }

  async kill(): Promise<void> {
    if (this.killed) {
      return;
    }
    this.killed = true;
    await this.pty.kill();
  }

  sendInput(data: string | Uint8Array): Promise<void> {
    return this.pty.sendInput(data);
  }

  wait(): Promise<{ error?: string; exitCode?: number }> {
    return this.pty.wait();
  }

  waitForConnection(): Promise<void> {
    return this.pty.waitForConnection();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  error: string | (() => Error),
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(typeof error === "string" ? new Error(error) : error()),
        timeoutMs,
      );
    }),
  ]);
}

// A timer firing this far past its window means local timers were frozen (host
// asleep) while the sandbox kept working — the silence was never measured.
const inactivityDriftToleranceMs = 30_000;

function createCommandInactivityDeadline(
  timeoutMs: number | undefined,
  onDrift?: (driftMs: number) => void,
): {
  dispose(): void;
  expired: Promise<never>;
  touch(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: ((error: Error) => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (windowMs: number) => {
    dispose();
    const armedAtMs = Date.now();
    timer = setTimeout(() => {
      const driftMs = Date.now() - armedAtMs - windowMs;
      if (driftMs > inactivityDriftToleranceMs) {
        onDrift?.(driftMs);
        arm(windowMs);
        return;
      }
      expire?.(new AgentHarnessCommandTimeoutError(windowMs, "inactivity"));
    }, windowMs);
  };

  return {
    dispose,
    expired,
    touch() {
      if (timeoutMs === undefined) {
        return;
      }
      arm(timeoutMs);
    },
  };
}

function toSdkTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isDaytonaConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "DaytonaConnectionError" ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT")
  );
}

function isDaytonaSandboxNotStartedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /failed to resolve container IP|no IP address found|Is the Sandbox started/i.test(
      error.message,
    )
  );
}

function readSandboxId(sandbox: DaytonaSdkSandbox): string {
  return sandbox.id ?? sandbox.name ?? "unknown";
}

function isTransientDaytonaArtifactTransferError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    /Connection|Timeout/i.test(error.name) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Operation timed out|socket hang up/i.test(
      error.message,
    )
  );
}

function formatErrorDiagnostic(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** Identifies a Daytona conflict raised while a sandbox state change settles. */
function isDaytonaStateConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    errorCode?: unknown;
    message?: unknown;
    statusCode?: unknown;
  };
  return (
    candidate.statusCode === 409 ||
    candidate.errorCode === "Conflict" ||
    /state change in progress|state is changing/i.test(
      String(candidate.message ?? ""),
    )
  );
}

function isDaytonaNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    errorCode?: unknown;
    name?: unknown;
    statusCode?: unknown;
  };
  return (
    candidate.statusCode === 404 ||
    candidate.errorCode === "Not Found" ||
    candidate.name === "DaytonaNotFoundError"
  );
}

/**
 * Per-command exit sentinel. The nonce keeps submitted code from forging a
 * trailer on stdout, and the sentinel is matched last-first so any earlier
 * lookalike in the command's own output cannot win.
 */
function createExitSentinel(): string {
  return `__MAKEADEMO_EXIT_${randomUUID().replaceAll("-", "")}__`;
}

function readExitCode(output: string, sentinel: string): number | undefined {
  const matches = [...output.matchAll(new RegExp(`${sentinel}:(\\d+)`, "g"))];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
}

function removeExitMarker(output: string, sentinel: string): string {
  return output.replaceAll(new RegExp(`\\n?${sentinel}:\\d+\\n?`, "g"), "");
}

function readSandboxLogLevel(
  entry: AgentHarnessWorkspaceLogEntry,
): "error" | "info" | "warn" {
  const event = typeof entry.event === "string" ? entry.event : "";
  if (event.includes("failed") || event.includes("invalid")) {
    return "error";
  }

  if (event.includes("warning")) {
    return "warn";
  }

  return "info";
}

function readSandboxLogMessage(entry: AgentHarnessWorkspaceLogEntry): string {
  if (typeof entry.message === "string") {
    return entry.message;
  }

  return typeof entry.event === "string" ? entry.event : "Sandbox log event.";
}

function createManagedAppCommand(
  input: AgentHarnessSubmittedCodeAppStartInput,
): string {
  const environment = Object.entries(input.env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid submitted-code environment variable: ${name}`);
      }
      return shellQuote(`${name}=${value}`);
    });
  const runtimeEnvironment = [
    ...environment,
    shellQuote(`TMPDIR=${submittedCodeRuntimeTempDirectory}`),
  ];

  return `mkdir -p ${shellQuote(submittedCodeRuntimeTempDirectory)} && cd ${shellQuote(input.cwd)} && env ${runtimeEnvironment.join(" ")} sh -lc ${shellQuote(input.command)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertLockfilePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const lockfileNames = new Set([
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]);
  if (
    normalized.length === 0 ||
    posix.isAbsolute(normalized) ||
    posix.normalize(normalized) !== normalized ||
    normalized.startsWith("../") ||
    !lockfileNames.has(posix.basename(normalized))
  ) {
    throw new Error(
      `Submitted-code promotion path must be a repository-relative recognized lockfile: ${path}`,
    );
  }
  return normalized;
}

function createPreparedWorkspaceArchiveCommand(archivePath: string): string {
  const excludedArchivePaths = [
    "./.git",
    "./.git/*",
    "./*/.git",
    "./*/.git/*",
    "./.makeademo",
    "./.makeademo/*",
    "./node_modules",
    "./node_modules/*",
    "./*/node_modules",
    "./*/node_modules/*",
    "./.vite",
    "./.vite/*",
    "./*/.vite",
    "./*/.vite/*",
    "./.turbo",
    "./.turbo/*",
    "./*/.turbo",
    "./*/.turbo/*",
    "./.npm",
    "./.npm/*",
    "./*/.npm",
    "./*/.npm/*",
    "./.pnpm-store",
    "./.pnpm-store/*",
    "./*/.pnpm-store",
    "./*/.pnpm-store/*",
    "./.yarn/cache",
    "./.yarn/cache/*",
    "./*/.yarn/cache",
    "./*/.yarn/cache/*",
    "./.next/cache",
    "./.next/cache/*",
    "./*/.next/cache",
    "./*/.next/cache/*",
    "./.bun",
    "./.bun/*",
    "./*/.bun",
    "./*/.bun/*",
    "./.cache",
    "./.cache/*",
    "./*/.cache",
    "./*/.cache/*",
  ];
  const excludeFlags = excludedArchivePaths
    .map((path) => `--exclude=${shellQuote(path)}`)
    .join(" ");

  return `sh -lc ${shellQuote(
    [
      `mkdir -p ${shellQuote(makeADemoArtifactDirectory)}`,
      `tar ${excludeFlags} -czf ${shellQuote(archivePath)} -C /workspace .`,
    ].join(" && "),
  )}`;
}

function createSubmittedCodeWorkspaceExtractCommand(
  archivePath: string,
): string {
  const preservedWorkspacePaths = [
    "-name node_modules",
    "-name .npm",
    "-name .pnpm-store",
    "-path '*/.yarn/cache'",
    "-name .bun",
  ].join(" -o ");

  return `sh -lc ${shellQuote(
    [
      "preserved=$(mktemp -d /workspace/.makeademo-reset.XXXXXX)",
      "preserved_paths=$(mktemp)",
      'cleanup() { rm -f -- "$preserved_paths"; rm -rf -- "$preserved"; }',
      "trap cleanup EXIT",
      `find /workspace -mindepth 1 \\( ${preservedWorkspacePaths} \\) -prune -print > "$preserved_paths"`,
      `while IFS= read -r path; do relative="\${path#/workspace/}"; mkdir -p -- "\$preserved/\$(dirname -- "\$relative")" || exit 1; mv -- "\$path" "\$preserved/\$relative" || exit 1; done < "$preserved_paths"`,
      'for path in /workspace/* /workspace/.[!.]* /workspace/..?*; do { [ -e "$path" ] || [ -L "$path" ]; } || continue; if [ "$path" != "$preserved" ]; then rm -rf -- "$path" || exit 1; fi; done',
      `while IFS= read -r path; do relative="\${path#/workspace/}"; mkdir -p -- "\$(dirname -- "\$path")" || exit 1; mv -- "\$preserved/\$relative" "\$path" || exit 1; done < "$preserved_paths"`,
      `tar -xzf ${shellQuote(archivePath)} -C /workspace`,
    ].join(" && "),
  )}`;
}

function formatCommandFailure(
  message: string,
  result: {
    exitCode?: number;
    result?: string;
    stderr?: string;
    stdout?: string;
  },
): string {
  const exitCode = result.exitCode ?? 0;
  const stderr = result.stderr ?? "";
  const stdout = result.stdout ?? result.result ?? "";

  return `${message} (exit code ${exitCode}). stderr: ${stderr} stdout: ${stdout}`;
}

function isRestrictedNetworkPolicyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "Network access is restricted and cannot be overridden at the sandbox level",
    )
  );
}

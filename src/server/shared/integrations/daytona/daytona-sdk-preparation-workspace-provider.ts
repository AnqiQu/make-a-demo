import { randomUUID } from "node:crypto";

import { Daytona } from "@daytona/sdk";

import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceDownloadFile,
  PreparationWorkspaceExecuteOptions,
  PreparationWorkspaceLogEntry,
  PreparationWorkspaceUploadFile,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import {
  type PipelineEventLogger,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";

type DaytonaSdkClient = {
  create(input?: unknown): Promise<DaytonaSdkSandbox>;
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
    ): Promise<void>;
  };
  getSignedPreviewUrl(
    port: number,
    expiresInSeconds?: number,
  ): Promise<{ url?: string }>;
  id?: string;
  name?: string;
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
  updateNetworkSettings(settings: { networkBlockAll: boolean }): Promise<void>;
};

type DaytonaSdkPty = Awaited<
  ReturnType<DaytonaSdkSandbox["process"]["createPty"]>
>;

export type DaytonaSdkPreparationWorkspaceProviderOptions = {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  diskGB?: number;
  logWriteTimeoutMs?: number;
  previewUrlTimeoutMs?: number;
  ptyConnectionTimeoutMs?: number;
  sandboxLogSinks?: PipelineLogSink[];
  snapshot?: string;
};

const defaultSandboxDiskGB = 3;
const defaultCommandTimeoutMs = 10 * 60_000;
const defaultLogWriteTimeoutMs = 5_000;
const defaultPreviewUrlTimeoutMs = 30_000;
const defaultPtyConnectionTimeoutMs = 30_000;
const makeADemoArtifactDirectory = "/tmp/makeademo";
const workspaceMakeADemoDirectory = "/workspace/.makeademo";
const sandboxAuditLogPath = `${makeADemoArtifactDirectory}/sandbox-log.jsonl`;
const workspaceSandboxAuditLogPath = `${workspaceMakeADemoDirectory}/sandbox-log.jsonl`;

export async function createDaytonaSdkPreparationWorkspaceHandle(input: {
  apiKey?: string;
  client?: DaytonaSdkClient;
  commandTimeoutMs?: number;
  logWriteTimeoutMs?: number;
  previewUrlTimeoutMs?: number;
  sandboxId: string;
  sandboxLogSinks?: PipelineLogSink[];
  ptyConnectionTimeoutMs?: number;
}): Promise<PreparationWorkspaceHandle> {
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
    previewUrlTimeoutMs:
      input.previewUrlTimeoutMs ?? defaultPreviewUrlTimeoutMs,
    ptyConnectionTimeoutMs:
      input.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs,
    sandboxLogSinks: input.sandboxLogSinks ?? [],
    sandbox,
  });
}

export class DaytonaSdkPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly client: DaytonaSdkClient;
  private readonly commandTimeoutMs: number;
  private readonly diskGB: number;
  private readonly logWriteTimeoutMs: number;
  private readonly previewUrlTimeoutMs: number;
  private readonly ptyConnectionTimeoutMs: number;
  private readonly sandboxLogSinks: PipelineLogSink[];
  private readonly snapshot: string | undefined;

  constructor(options: DaytonaSdkPreparationWorkspaceProviderOptions = {}) {
    this.client =
      options.client ??
      (new Daytona(
        options.apiKey === undefined ? undefined : { apiKey: options.apiKey },
      ) as DaytonaSdkClient);
    this.commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.snapshot = options.snapshot;
    this.diskGB = options.diskGB ?? defaultSandboxDiskGB;
    this.logWriteTimeoutMs =
      options.logWriteTimeoutMs ?? defaultLogWriteTimeoutMs;
    this.previewUrlTimeoutMs =
      options.previewUrlTimeoutMs ?? defaultPreviewUrlTimeoutMs;
    this.ptyConnectionTimeoutMs =
      options.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs;
    this.sandboxLogSinks = options.sandboxLogSinks ?? [];
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const sandbox = await this.client.create({
      disk: this.diskGB,
      ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
    });
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    return createPreparationWorkspaceHandle({
      client: this.client,
      commandTimeoutMs: this.commandTimeoutMs,
      id,
      logWriteTimeoutMs: this.logWriteTimeoutMs,
      previewUrlTimeoutMs: this.previewUrlTimeoutMs,
      ptyConnectionTimeoutMs: this.ptyConnectionTimeoutMs,
      sandboxLogSinks: this.sandboxLogSinks,
      sandbox,
    });
  }
}

function createPreparationWorkspaceHandle(input: {
  client: DaytonaSdkClient;
  commandTimeoutMs: number;
  id: string;
  logWriteTimeoutMs: number;
  previewUrlTimeoutMs: number;
  ptyConnectionTimeoutMs: number;
  sandboxLogSinks?: PipelineLogSink[];
  sandbox: DaytonaSdkSandbox;
}): PreparationWorkspaceHandle {
  const workspace = new DaytonaSdkPreparationWorkspace(
    input.sandbox,
    input.id,
    input.commandTimeoutMs,
    input.logWriteTimeoutMs,
    input.previewUrlTimeoutMs,
    input.ptyConnectionTimeoutMs,
    input.sandboxLogSinks ?? [],
  );

  return {
    async destroy() {
      await workspace.cancelActiveCommands();
      await input.client.delete(input.sandbox);
    },
    id: input.id,
    workspace,
  };
}

class DaytonaSdkPreparationWorkspace implements PreparationWorkspace {
  private readonly activePtys = new Set<ManagedPty>();
  private readonly sandboxLogger: PipelineEventLogger;

  constructor(
    private readonly sandbox: DaytonaSdkSandbox,
    private readonly workspaceId: string,
    private readonly commandTimeoutMs: number,
    private readonly logWriteTimeoutMs: number,
    private readonly previewUrlTimeoutMs: number,
    private readonly ptyConnectionTimeoutMs: number,
    sandboxLogSinks: PipelineLogSink[],
  ) {
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

  async execute(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreaming(command, options);
    }

    const response = await withTimeout(
      this.sandbox.process.executeCommand(command, undefined, options.env),
      this.commandTimeoutMs,
      `Daytona command did not finish within ${this.commandTimeoutMs}ms.`,
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  private async executeStreaming(
    command: string,
    options: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult> {
    const output: string[] = [];
    const decoder = new TextDecoder();
    const rawPty = await this.sandbox.process.createPty({
      cols: 120,
      cwd: "/workspace",
      envs: options.env ?? {},
      id: `makeademo-${randomUUID()}`,
      onData: (data) => {
        const chunk = decoder.decode(data);
        output.push(chunk);
        const visibleChunk = removeExitMarker(chunk);
        if (visibleChunk.length > 0) {
          options.onStdout?.(visibleChunk);
        }
      },
      rows: 30,
    });
    const pty = new ManagedPty(rawPty);
    this.activePtys.add(pty);

    try {
      await withTimeout(
        pty.waitForConnection(),
        this.ptyConnectionTimeoutMs,
        `Daytona PTY did not connect within ${this.ptyConnectionTimeoutMs}ms.`,
      );
      await pty.sendInput(
        `stty -echo\n${command}\nprintf '\\n__MAKEADEMO_EXIT__:%s\\n' $?\nexit\n`,
      );
      const result = await pty.wait();
      const stdout = output.join("");
      const exitCode = readExitCode(stdout) ?? result.exitCode ?? 0;

      return {
        exitCode,
        stderr: result.error ?? "",
        stdout: removeExitMarker(stdout),
      };
    } finally {
      this.activePtys.delete(pty);
      await pty.disconnect();
    }
  }

  async cancelActiveCommands(): Promise<void> {
    await Promise.allSettled(
      [...this.activePtys].map((pty) => pty.disconnect()),
    );
  }

  async writeSandboxLog(entry: PreparationWorkspaceLogEntry): Promise<void> {
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
        `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} ${shellQuote(workspaceMakeADemoDirectory)} && printf '%s' ${shellQuote(line)} >> ${shellQuote(sandboxAuditLogPath)} && cp ${shellQuote(sandboxAuditLogPath)} ${shellQuote(workspaceSandboxAuditLogPath)}`,
      ),
      this.logWriteTimeoutMs,
      `Daytona sandbox log write did not finish within ${this.logWriteTimeoutMs}ms.`,
    );

    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to write Daytona sandbox audit log.");
    }
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    try {
      await this.sandbox.updateNetworkSettings({ networkBlockAll: !enabled });
    } catch (error) {
      if (isRestrictedNetworkPolicyError(error)) {
        return;
      }

      throw error;
    }
  }

  async getPreviewUrl(port: number): Promise<string> {
    const preview = await withTimeout(
      this.sandbox.getSignedPreviewUrl(port, 60 * 60),
      this.previewUrlTimeoutMs,
      `Daytona preview URL creation did not finish within ${this.previewUrlTimeoutMs}ms.`,
    );
    if (preview.url === undefined || preview.url.trim().length === 0) {
      throw new Error("Daytona did not return a preview URL.");
    }

    return preview.url;
  }

  async uploadFiles(files: PreparationWorkspaceUploadFile[]): Promise<void> {
    await this.sandbox.fs.uploadFiles(
      files.map((file) => ({
        destination: file.destinationPath,
        source: file.sourcePath,
      })),
    );
  }

  async downloadFiles(
    files: PreparationWorkspaceDownloadFile[],
  ): Promise<void> {
    const results = await this.sandbox.fs.downloadFiles(
      files.map((file) => ({
        destination: file.destinationPath,
        source: file.sourcePath,
      })),
      0,
    );
    const failed = results.find((result) => result.error !== undefined);
    if (failed !== undefined) {
      throw new Error(
        `Failed to download Daytona sandbox file ${failed.source}: ${failed.error}`,
      );
    }
  }
}

class ManagedPty {
  private disconnected = false;

  constructor(private readonly pty: DaytonaSdkPty) {}

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    await this.pty.disconnect();
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
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function readExitCode(output: string): number | undefined {
  const match = output.match(/__MAKEADEMO_EXIT__:(\d+)/);
  if (match?.[1] === undefined) {
    return undefined;
  }

  return Number(match[1]);
}

function removeExitMarker(output: string): string {
  return output.replace(/\n?__MAKEADEMO_EXIT__:\d+\n?/g, "");
}

function readSandboxLogLevel(
  entry: PreparationWorkspaceLogEntry,
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

function readSandboxLogMessage(entry: PreparationWorkspaceLogEntry): string {
  if (typeof entry.message === "string") {
    return entry.message;
  }

  return typeof entry.event === "string" ? entry.event : "Sandbox log event.";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRestrictedNetworkPolicyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "Network access is restricted and cannot be overridden at the sandbox level",
    )
  );
}

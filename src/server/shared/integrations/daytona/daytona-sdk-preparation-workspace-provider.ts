import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  secrets?: Record<string, string>;
  snapshot?: string;
  submittedCodeSnapshot?: string;
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
    this.previewUrlTimeoutMs =
      options.previewUrlTimeoutMs ?? defaultPreviewUrlTimeoutMs;
    this.ptyConnectionTimeoutMs =
      options.ptyConnectionTimeoutMs ?? defaultPtyConnectionTimeoutMs;
    this.sandboxLogSinks = options.sandboxLogSinks ?? [];
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const sandbox = await this.client.create({
      disk: this.diskGB,
      ...(this.secrets === undefined ? {} : { secrets: this.secrets }),
      ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
    });
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    const submittedCodeSandbox =
      this.submittedCodeSnapshot === undefined
        ? undefined
        : await this.client.create({
            autoDeleteInterval: 0,
            ephemeral: true,
            linkedSandbox: id,
            networkBlockAll: true,
            snapshot: this.submittedCodeSnapshot,
          });

    return createPreparationWorkspaceHandle({
      client: this.client,
      commandTimeoutMs: this.commandTimeoutMs,
      id,
      logWriteTimeoutMs: this.logWriteTimeoutMs,
      previewUrlTimeoutMs: this.previewUrlTimeoutMs,
      ptyConnectionTimeoutMs: this.ptyConnectionTimeoutMs,
      sandboxLogSinks: this.sandboxLogSinks,
      sandbox,
      ...(submittedCodeSandbox === undefined ? {} : { submittedCodeSandbox }),
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
  submittedCodeSandbox?: DaytonaSdkSandbox;
}): PreparationWorkspaceHandle {
  const workspace = new DaytonaSdkPreparationWorkspace(
    input.sandbox,
    input.submittedCodeSandbox,
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
      if (input.submittedCodeSandbox !== undefined) {
        await input.client.delete(input.submittedCodeSandbox);
      }
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
    private readonly submittedCodeSandbox: DaytonaSdkSandbox | undefined,
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
        `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} && printf '%s' ${shellQuote(line)} >> ${shellQuote(sandboxAuditLogPath)}`,
      ),
      this.logWriteTimeoutMs,
      `Daytona sandbox log write did not finish within ${this.logWriteTimeoutMs}ms.`,
    );

    if ((response.exitCode ?? 0) !== 0) {
      throw new Error("Failed to write Daytona sandbox audit log.");
    }

    void withTimeout(
      this.sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(workspaceMakeADemoDirectory)} && cp ${shellQuote(sandboxAuditLogPath)} ${shellQuote(workspaceSandboxAuditLogPath)}`,
      ),
      this.logWriteTimeoutMs,
      `Daytona sandbox log mirror did not finish within ${this.logWriteTimeoutMs}ms.`,
    ).catch(() => {});
  }

  async executeSubmittedCode(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
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

    const response = await this.submittedCodeSandbox.process.executeCommand(
      command,
      undefined,
      options.env,
    );

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    await this.setSandboxNetworkAccess(this.sandbox, enabled);
  }

  async setSubmittedCodeNetworkAccess(enabled: boolean): Promise<void> {
    if (this.submittedCodeSandbox === undefined) {
      throw new Error("Submitted-code Daytona sandbox is not configured.");
    }

    await this.setSandboxNetworkAccess(this.submittedCodeSandbox, enabled);
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
          ),
          this.commandTimeoutMs,
          `Daytona prepared workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        withTimeout(
          this.submittedCodeSandbox.process.executeCommand(
            `rm -f ${shellQuote(remoteArchivePath)}`,
          ),
          this.commandTimeoutMs,
          `Daytona submitted-code workspace archive cleanup did not finish within ${this.commandTimeoutMs}ms.`,
        ),
        rm(localDirectory, { force: true, recursive: true }),
      ]);
    }
  }

  private async setSandboxNetworkAccess(
    sandbox: DaytonaSdkSandbox,
    enabled: boolean,
  ): Promise<void> {
    try {
      await sandbox.updateNetworkSettings({ networkBlockAll: !enabled });
    } catch (error) {
      if (isRestrictedNetworkPolicyError(error)) {
        return;
      }

      throw error;
    }
  }

  async getPreviewUrl(port: number): Promise<string> {
    const previewSandbox = this.submittedCodeSandbox ?? this.sandbox;
    const preview = await withTimeout(
      previewSandbox.getSignedPreviewUrl(port, 60 * 60),
      this.previewUrlTimeoutMs,
      `Daytona preview URL creation did not finish within ${this.previewUrlTimeoutMs}ms.`,
    );
    if (preview.url === undefined || preview.url.trim().length === 0) {
      throw new Error("Daytona did not return a preview URL.");
    }

    return preview.url;
  }

  async uploadFiles(files: PreparationWorkspaceUploadFile[]): Promise<void> {
    const uploadedFiles = files.map((file) => ({
      destination: file.destinationPath,
      source: file.sourcePath,
    }));
    await this.sandbox.fs.uploadFiles(uploadedFiles);
    await this.submittedCodeSandbox?.fs.uploadFiles(uploadedFiles);
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

  private async executeStreamingInSandbox(
    sandbox: DaytonaSdkSandbox,
    command: string,
    options: PreparationWorkspaceExecuteOptions,
  ): Promise<PreparationWorkspaceCommandResult> {
    const output: string[] = [];
    const decoder = new TextDecoder();
    const rawPty = await sandbox.process.createPty({
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
        `stty -echo\n${command}\nprintf '\n__MAKEADEMO_EXIT__:%s\n' $?\nexit\n`,
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
    "-name .vite",
    "-name .turbo",
    "-name .npm",
    "-name .pnpm-store",
    "-path '*/.yarn/cache'",
    "-path '*/.next/cache'",
    "-name .bun",
    "-name .cache",
  ].join(" -o ");

  return `sh -lc ${shellQuote(
    [
      "preserved=$(mktemp -d)",
      "preserved_paths=$(mktemp)",
      'cleanup() { rm -f -- "$preserved_paths"; rm -rf -- "$preserved"; }',
      "trap cleanup EXIT",
      `find /workspace -mindepth 1 \\( ${preservedWorkspacePaths} \\) -prune -print > "$preserved_paths"`,
      `while IFS= read -r path; do relative="\${path#/workspace/}"; mkdir -p -- "\$preserved/\$(dirname -- "\$relative")" || exit 1; mv -- "\$path" "\$preserved/\$relative" || exit 1; done < "$preserved_paths"`,
      "rm -rf -- /workspace/* /workspace/.[!.]* /workspace/..?*",
      '{ cp -a "$preserved"/. /workspace/ 2>/dev/null || true; }',
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

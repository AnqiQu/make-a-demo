import { randomUUID } from "node:crypto";

import { Daytona } from "@daytona/sdk";

import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceExecuteOptions,
  PreparationWorkspaceUploadFile,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

type DaytonaSdkClient = {
  create(input?: unknown): Promise<DaytonaSdkSandbox>;
  delete(sandbox: DaytonaSdkSandbox): Promise<void>;
};

type DaytonaSdkSandbox = {
  fs: {
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
  snapshot?: string;
};

export class DaytonaSdkPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly client: DaytonaSdkClient;
  private readonly snapshot: string | undefined;

  constructor(options: DaytonaSdkPreparationWorkspaceProviderOptions = {}) {
    this.client =
      options.client ??
      (new Daytona(
        options.apiKey === undefined ? undefined : { apiKey: options.apiKey },
      ) as DaytonaSdkClient);
    this.snapshot = options.snapshot;
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const sandbox = await this.client.create({
      ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
    });
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    const client = this.client;

    const workspace = new DaytonaSdkPreparationWorkspace(sandbox);

    return {
      async destroy() {
        await workspace.cancelActiveCommands();
        await client.delete(sandbox);
      },
      id,
      workspace,
    };
  }
}

class DaytonaSdkPreparationWorkspace implements PreparationWorkspace {
  private readonly activePtys = new Set<ManagedPty>();

  constructor(private readonly sandbox: DaytonaSdkSandbox) {}

  async execute(
    command: string,
    options: PreparationWorkspaceExecuteOptions = {},
  ): Promise<PreparationWorkspaceCommandResult> {
    if (options.onStdout !== undefined || options.onStderr !== undefined) {
      return this.executeStreaming(command, options);
    }

    const response = await this.sandbox.process.executeCommand(
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
      await pty.waitForConnection();
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
    const preview = await this.sandbox.getSignedPreviewUrl(port, 60 * 60);
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

function isRestrictedNetworkPolicyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "Network access is restricted and cannot be overridden at the sandbox level",
    )
  );
}

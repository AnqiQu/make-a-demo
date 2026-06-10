import { Daytona } from "@daytona/sdk";

import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
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
  id?: string;
  name?: string;
  process: {
    executeCommand(command: string): Promise<{
      exitCode?: number;
      result?: string;
      stderr?: string;
      stdout?: string;
    }>;
  };
  updateNetworkSettings(settings: { networkBlockAll: boolean }): Promise<void>;
};

export type DaytonaSdkPreparationWorkspaceProviderOptions = {
  client?: DaytonaSdkClient;
  snapshot?: string;
};

export class DaytonaSdkPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly client: DaytonaSdkClient;
  private readonly snapshot: string | undefined;

  constructor(options: DaytonaSdkPreparationWorkspaceProviderOptions = {}) {
    this.client = options.client ?? (new Daytona() as DaytonaSdkClient);
    this.snapshot = options.snapshot;
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const sandbox = await this.client.create({
      networkBlockAll: true,
      ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
    });
    const id = sandbox.id ?? sandbox.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    const client = this.client;

    return {
      async destroy() {
        await client.delete(sandbox);
      },
      id,
      workspace: new DaytonaSdkPreparationWorkspace(sandbox),
    };
  }
}

class DaytonaSdkPreparationWorkspace implements PreparationWorkspace {
  constructor(private readonly sandbox: DaytonaSdkSandbox) {}

  async execute(command: string): Promise<PreparationWorkspaceCommandResult> {
    const response = await this.sandbox.process.executeCommand(command);

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    await this.sandbox.updateNetworkSettings({ networkBlockAll: !enabled });
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

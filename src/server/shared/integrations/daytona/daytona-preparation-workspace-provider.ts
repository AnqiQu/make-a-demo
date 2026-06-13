import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
  PreparationWorkspaceUploadFile,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

type DaytonaFetch = typeof fetch;

export type DaytonaPreparationWorkspaceProviderOptions = {
  apiBaseUrl?: string;
  apiKey: string;
  fetch?: DaytonaFetch;
  snapshot?: string;
  toolboxBaseUrl?: string;
};

export class DaytonaPreparationWorkspaceProvider
  implements PreparationWorkspaceProvider
{
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: DaytonaFetch;
  private readonly snapshot: string | undefined;
  private readonly toolboxBaseUrl: string;

  constructor(options: DaytonaPreparationWorkspaceProviderOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://app.daytona.io/api";
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? fetch;
    this.snapshot = options.snapshot;
    this.toolboxBaseUrl =
      options.toolboxBaseUrl ?? "https://proxy.app.daytona.io/toolbox";
  }

  async create(): Promise<PreparationWorkspaceHandle> {
    const response = await this.request<{ id?: string; name?: string }>(
      `${this.apiBaseUrl}/sandbox`,
      {
        body: JSON.stringify({
          networkBlockAll: true,
          ...(this.snapshot === undefined ? {} : { snapshot: this.snapshot }),
        }),
        method: "POST",
      },
    );
    const id = response.id ?? response.name;
    if (id === undefined || id.trim() === "") {
      throw new Error("Daytona did not return a sandbox id.");
    }

    const thisProvider = this;

    return {
      async destroy() {
        await thisProvider.request(`${thisProvider.apiBaseUrl}/sandbox/${id}`, {
          method: "DELETE",
        });
      },
      id,
      workspace: new DaytonaPreparationWorkspace({
        apiBaseUrl: this.apiBaseUrl,
        request: this.request.bind(this),
        sandboxId: id,
        toolboxBaseUrl: this.toolboxBaseUrl,
      }),
    };
  }

  private async request<T = unknown>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Daytona request failed with ${response.status} ${response.statusText}`,
      );
    }

    const text = await response.text();
    return (text.trim() === "" ? {} : JSON.parse(text)) as T;
  }
}

class DaytonaPreparationWorkspace implements PreparationWorkspace {
  private readonly apiBaseUrl: string;
  private readonly request: <T = unknown>(
    url: string,
    init: RequestInit,
  ) => Promise<T>;
  private readonly sandboxId: string;
  private readonly toolboxBaseUrl: string;

  constructor(options: {
    apiBaseUrl: string;
    request: <T = unknown>(url: string, init: RequestInit) => Promise<T>;
    sandboxId: string;
    toolboxBaseUrl: string;
  }) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.request = options.request;
    this.sandboxId = options.sandboxId;
    this.toolboxBaseUrl = options.toolboxBaseUrl;
  }

  async execute(command: string): Promise<PreparationWorkspaceCommandResult> {
    const response = await this.request<{
      exitCode?: number;
      result?: string;
      stderr?: string;
      stdout?: string;
    }>(`${this.toolboxBaseUrl}/${this.sandboxId}/process/execute`, {
      body: JSON.stringify({ command }),
      method: "POST",
    });

    return {
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? "",
      stdout: response.stdout ?? response.result ?? "",
    };
  }

  async setOutboundNetworkAccess(enabled: boolean): Promise<void> {
    await this.request(
      `${this.apiBaseUrl}/sandbox/${this.sandboxId}/network-settings`,
      {
        body: JSON.stringify({ networkBlockAll: !enabled }),
        method: "POST",
      },
    );
  }

  async getPreviewUrl(_port: number): Promise<string> {
    throw new Error("Daytona preview URLs require the SDK-backed adapter.");
  }

  async uploadFiles(_files: PreparationWorkspaceUploadFile[]): Promise<void> {
    throw new Error("Daytona file upload requires the SDK-backed adapter.");
  }
}

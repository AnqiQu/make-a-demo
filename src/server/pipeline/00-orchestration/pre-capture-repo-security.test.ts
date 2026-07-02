import { describe, expect, it } from "vitest";

import { createPipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import type {
  PreparationWorkspaceHandle,
  PreparationWorkspaceProvider,
} from "../03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../03-repo-preparation/preparation-workspace.interface";
import { readRepoSecurityInput } from "./pre-capture-repo-security";

describe("readRepoSecurityInput", () => {
  it("retries transient Daytona clone failures before reading repo security input", async () => {
    const workspace = new FakePreparationWorkspace({
      cloneResults: [
        {
          exitCode: 128,
          stderr:
            "fatal: unable to access 'https://github.com/example/app/': Could not resolve host: github.com",
          stdout: "",
        },
        { exitCode: 0, stderr: "", stdout: "" },
      ],
    });

    const result = await readRepoSecurityInput(
      new FakePreparationWorkspaceProvider(workspace),
      "https://github.com/example/app",
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(workspace.cloneAttempts).toBe(2);
  });

  it("does not retry deterministic git clone failures", async () => {
    const workspace = new FakePreparationWorkspace({
      cloneResults: [
        {
          exitCode: 128,
          stderr:
            "remote: Repository not found.\nfatal: repository 'https://github.com/example/missing/' not found",
          stdout: "",
        },
      ],
    });

    await expect(
      readRepoSecurityInput(
        new FakePreparationWorkspaceProvider(workspace),
        "https://github.com/example/missing",
      ),
    ).rejects.toThrow("Repository not found");
    expect(workspace.cloneAttempts).toBe(1);
  });

  it("logs Daytona clone progress through Pino JSON", async () => {
    const lines: string[] = [];
    const commands: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "repo-security-screen" },
      sinks: [{ write: (line) => void lines.push(line) }],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const result = await readRepoSecurityInput(
      new FakePreparationWorkspaceProvider(commands),
      "https://github.com/example/app",
      { logger },
    );

    expect(result.repoStats).toEqual({ fileCount: 1, sizeBytes: 17 });
    expect(commands[0]).toContain("sudo mkdir -p '/workspace'");
    expect(commands[0]).toContain("sudo chown -R");
    expect(commands[0]).toContain(
      "git clone --depth 1 'https://github.com/example/app' '/workspace'",
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        component: "repo-security-screen",
        event: "repo-security-screen.clone.started",
        externalCall: "daytona.git_clone",
        level: "info",
        message: "Daytona clone started.",
        repoUrl: "https://github.com/example/app",
        service: "makeademo",
        stage: "repo-security-screen",
        time: "2026-06-17T00:00:00.000Z",
      },
      {
        component: "repo-security-screen",
        event: "repo-security-screen.clone.succeeded",
        externalCall: "daytona.git_clone",
        level: "info",
        message: "Daytona clone succeeded.",
        repoUrl: "https://github.com/example/app",
        service: "makeademo",
        stage: "repo-security-screen",
        time: "2026-06-17T00:00:00.000Z",
      },
    ]);
  });
});

class FakePreparationWorkspaceProvider implements PreparationWorkspaceProvider {
  constructor(
    private readonly input:
      | PreparationWorkspace
      | string[] = new FakePreparationWorkspace(),
  ) {}

  async create(): Promise<PreparationWorkspaceHandle> {
    const workspace = Array.isArray(this.input)
      ? new FakePreparationWorkspace({ commands: this.input })
      : this.input;

    return {
      async destroy() {},
      id: "workspace-1",
      workspace,
    };
  }
}

class FakePreparationWorkspace implements PreparationWorkspace {
  cloneAttempts = 0;

  constructor(
    private readonly input: {
      cloneResults?: PreparationWorkspaceCommandResult[];
      commands?: string[];
    } = {},
  ) {}

  async execute(command: string): Promise<PreparationWorkspaceCommandResult> {
    this.input.commands?.push(command);
    if (command.includes("git clone")) {
      const result = this.input.cloneResults?.[this.cloneAttempts] ?? {
        exitCode: 0,
        stderr: "",
        stdout: "",
      };
      this.cloneAttempts += 1;
      return result;
    }

    if (command.includes("-printf '%P\\t%s\\n'")) {
      return { exitCode: 0, stderr: "", stdout: "package.json\t17\n" };
    }

    if (command.startsWith("cat ")) {
      return { exitCode: 0, stderr: "", stdout: '{"name":"app"}' };
    }

    throw new Error(`Unexpected command: ${command}`);
  }

  async getPreviewUrl(): Promise<string> {
    throw new Error("getPreviewUrl should not be called");
  }

  async setOutboundNetworkAccess(): Promise<void> {}

  async uploadFiles(): Promise<void> {
    throw new Error("uploadFiles should not be called");
  }
}

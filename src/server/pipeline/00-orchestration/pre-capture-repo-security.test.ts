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
  constructor(private readonly commands: string[]) {}

  async create(): Promise<PreparationWorkspaceHandle> {
    return {
      async destroy() {},
      id: "workspace-1",
      workspace: new FakePreparationWorkspace(this.commands),
    };
  }
}

class FakePreparationWorkspace implements PreparationWorkspace {
  constructor(private readonly commands: string[]) {}

  async execute(command: string): Promise<PreparationWorkspaceCommandResult> {
    this.commands.push(command);
    if (command.includes("git clone")) {
      return { exitCode: 0, stderr: "", stdout: "" };
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

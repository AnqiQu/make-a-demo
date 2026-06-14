import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { DaytonaSandboxRunner } from "./daytona-sandbox-runner";

describe("DaytonaSandboxRunner", () => {
  it("validates the retained prepared Daytona workspace", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.commands).toEqual([
      "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort",
      "npm ci",
      "sh -lc 'cd /workspace && nohup npm run demo > /tmp/makeademo-demo.log 2>&1 & echo $!'",
      "node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' 'http://localhost:3000'",
    ]);
    expect(workspace.networkAccess).toEqual([true, false]);
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test:3000/",
      blockedNetworkAttempts: [],
      logs: [
        "package-lock.json\npackage.json\n",
        "ran npm ci",
        "ran sh -lc 'cd /workspace && nohup npm run demo > /tmp/makeademo-demo.log 2>&1 & echo $!'",
      ],
      repoFiles: ["package-lock.json", "package.json"],
      runtimeExitCode: 0,
    });

    await result.cleanup?.();

    expect(workspace.destroyed).toBe(true);
  });

  it("requires the retained Repo Preparation workspace", async () => {
    const runner = new DaytonaSandboxRunner();

    await expect(
      runner.runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("Daytona validation requires the prepared workspace");
  });

  it("destroys the Daytona workspace when dependency installation fails", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["npm ci", 1]]),
    );
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.runtimeExitCode).toBe(1);
    expect(workspace.commands).toEqual([
      "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort",
      "npm ci",
    ]);
    expect(workspace.destroyed).toBe(true);
  });

  it("closes outbound network and destroys the workspace when install execution throws", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), "npm ci");
    const runner = new DaytonaSandboxRunner();

    await expect(
      runner.runValidation({
        demoCommand: "npm run demo",
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrow("npm ci exploded");

    expect(workspace.networkAccess).toEqual([true, false]);
    expect(workspace.destroyed).toBe(true);
  });

  it("starts long-running demo commands without waiting for the server to exit", async () => {
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([["npm run demo", 124]]),
    );
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.commands).not.toContain("npm run demo");
    expect(workspace.commands).toContain(
      "sh -lc 'cd /workspace && nohup npm run demo > /tmp/makeademo-demo.log 2>&1 & echo $!'",
    );
    expect(result.runtimeExitCode).toBe(0);
  });

  it("waits for the prepared demo URL before browser validation can run", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1, 0];
    const runner = new DaytonaSandboxRunner({ readinessPollIntervalMs: 0 });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(
      workspace.commands.filter((command) => command.includes("fetch")),
    ).toHaveLength(2);
    expect(result.runtimeExitCode).toBe(0);
  });

  it("returns demo logs when the prepared demo URL never becomes ready", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1, 1, 1];
    const runner = new DaytonaSandboxRunner({
      readinessPollIntervalMs: 0,
      readinessTimeoutMs: 3,
    });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.runtimeExitCode).toBe(1);
    expect(result.logs).toContain("demo server failed");
  });

  it("uses the manifest URL port when resolving a browser preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:4173",
    });

    expect(workspace.previewPorts).toEqual([4173]);
    expect(result.browserUrl).toBe("https://preview.example.test:4173/");
  });

  it("preserves the manifest URL path, query, and hash on browser preview URLs", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:4173/articles?tab=global#/feed",
    });

    expect(result.browserUrl).toBe(
      "https://preview.example.test:4173/articles?tab=global#/feed",
    );
  });
});

class FakePreparationWorkspaceHandle implements PreparationWorkspaceHandle {
  commands: string[] = [];
  destroyed = false;
  id = "daytona_workspace";
  networkAccess: boolean[] = [];
  previewPorts: number[] = [];
  readinessResults: number[] = [];

  constructor(
    private readonly exitCodesByCommand = new Map<string, number>(),
    private readonly commandToThrow?: string,
  ) {}

  workspace = {
    execute: async (command: string) => {
      this.commands.push(command);
      if (command === this.commandToThrow) {
        throw new Error(`${command} exploded`);
      }

      if (command.includes("fetch")) {
        return {
          exitCode: this.readinessResults.shift() ?? 0,
          stderr: "",
          stdout: "",
        };
      }

      if (command.includes("/tmp/makeademo-demo.log")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: command.startsWith("if test -f")
            ? "demo server failed"
            : `ran ${command}`,
        };
      }

      return {
        exitCode: this.exitCodesByCommand.get(command) ?? 0,
        stderr: "",
        stdout: command.startsWith("find /workspace")
          ? "package-lock.json\npackage.json\n"
          : `ran ${command}`,
      };
    },
    setOutboundNetworkAccess: async (enabled: boolean) => {
      this.networkAccess.push(enabled);
    },
    getPreviewUrl: async (port: number) => {
      this.previewPorts.push(port);
      return `https://preview.example.test:${port}`;
    },
    uploadFiles: async () => {
      throw new Error("Project Validation should use the retained workspace.");
    },
  };

  async destroy() {
    this.destroyed = true;
  }
}

function manifest(workspaceId: string) {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId,
  };
}

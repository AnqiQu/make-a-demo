import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import {
  DaytonaSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "./daytona-sandbox-runner";

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

    expect(workspace.commands).toEqual([]);
    expect(workspace.submittedCommands[0]).toContain("find /workspace");
    expect(workspace.submittedCommands[1]).toBe("npm ci");
    expect(workspace.submittedCommands[2]).toBe(STOP_DEMO_COMMAND);
    expect(workspace.submittedCommands[3]).toContain("exec npm run demo");
    expect(workspace.submittedCommands[4]).toContain("fetch");
    expect(workspace.submittedCommands[5]).toContain(
      "fresh-capture-baseline.tgz",
    );
    expect(workspace.submittedCommands[6]).toBe(
      "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
    );
    expect(workspace.submittedNetworkAccess).toEqual([true, false]);
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test:3000/",
      blockedNetworkAttempts: [],
      logs: [
        "package-lock.json\npackage.json\n",
        "ran npm ci",
        expect.stringContaining("exec npm run demo"),
      ],
      repoFiles: ["package-lock.json", "package.json"],
      runtimeExitCode: 0,
    });

    await result.cleanup?.();

    expect(workspace.destroyed).toBe(false);
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
    expect(workspace.submittedCommands[0]).toContain("find /workspace");
    expect(workspace.submittedCommands[1]).toBe("npm ci");
    expect(workspace.destroyed).toBe(false);
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

    expect(workspace.submittedNetworkAccess).toEqual([true, false]);
    expect(workspace.destroyed).toBe(false);
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

    expect(workspace.submittedCommands).not.toContain("npm run demo");
    expect(workspace.submittedCommands).toEqual(
      expect.arrayContaining([expect.stringContaining("exec npm run demo")]),
    );
    expect(result.runtimeExitCode).toBe(0);
  });

  it("stops the previous MakeADemo demo process before launching validation", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.submittedCommands).toContain(STOP_DEMO_COMMAND);
    expect(workspace.submittedCommands.indexOf(STOP_DEMO_COMMAND)).toBeLessThan(
      workspace.submittedCommands.findIndex((command) =>
        command.includes("exec npm run demo"),
      ),
    );
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
      workspace.submittedCommands.filter((command) =>
        command.includes("fetch"),
      ),
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

  it("returns a Daytona preview URL for the submitted-code browser URL", async () => {
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

  it("preserves the manifest URL path, query, and hash on submitted-code browser URLs", async () => {
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

  it("restores the prepared baseline before Footage Capture and returns a fresh preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();

    const result = await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(workspace.submittedCommands[0]).toBe(STOP_DEMO_COMMAND);
    expect(workspace.submittedCommands[1]).toContain(
      "fresh-capture-baseline.tgz && find",
    );
    expect(workspace.submittedCommands[2]).toEqual(
      expect.stringContaining("exec npm run demo:makeademo"),
    );
    expect(workspace.submittedCommands[3]).toBe(
      "node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' 'http://localhost:3000'",
    );
    expect(result.browserUrl).toBe("https://preview.example.test:3000/");
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restart.started",
          stage: "footage-capture",
        }),
        expect.objectContaining({
          event: "footage-capture.fresh-state.restore.succeeded",
          stage: "footage-capture",
        }),
        expect.objectContaining({
          browserUrl: "https://preview.example.test:3000/",
          event: "footage-capture.fresh-state.restart.succeeded",
          stage: "footage-capture",
        }),
      ]),
    );
  });

  it("fails the fresh capture boundary when the restarted demo never becomes ready", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    workspace.readinessResults = [1];

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
        readinessTimeoutMs: 1,
      }),
    ).rejects.toThrow("Fresh Footage Capture state did not become ready");
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restart.failed",
          stage: "footage-capture",
        }),
      ]),
    );
  });

  it("fails the fresh capture boundary when the prepared baseline cannot be restored", async () => {
    const workspace = new FakePreparationWorkspaceHandle(new Map(), undefined, {
      failFreshCaptureRestore: true,
    });

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).rejects.toThrow("Fresh Footage Capture baseline could not be restored");
    expect(workspace.submittedCommands[0]).toBe(STOP_DEMO_COMMAND);
    expect(workspace.submittedCommands[1]).toContain(
      "fresh-capture-baseline.tgz && find",
    );
    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "footage-capture.fresh-state.restore.failed",
          stage: "footage-capture",
        }),
      ]),
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
  sandboxLogs: Record<string, unknown>[] = [];
  submittedCommands: string[] = [];
  submittedNetworkAccess: boolean[] = [];

  constructor(
    private readonly exitCodesByCommand = new Map<string, number>(),
    private readonly commandToThrow?: string,
    private readonly options: { failFreshCaptureRestore?: boolean } = {},
  ) {}

  workspace = {
    execute: async (command: string) => {
      this.commands.push(command);
      return { exitCode: 0, stderr: "", stdout: `outer ${command}` };
    },
    executeSubmittedCode: async (command: string) => {
      this.submittedCommands.push(command);
      return this.runCommand(command);
    },
    getPreviewUrl: async (port: number) => {
      this.previewPorts.push(port);
      return `https://preview.example.test:${port}`;
    },
    setOutboundNetworkAccess: async (enabled: boolean) => {
      this.networkAccess.push(enabled);
    },
    setSubmittedCodeNetworkAccess: async (enabled: boolean) => {
      this.submittedNetworkAccess.push(enabled);
    },
    uploadFiles: async () => {
      throw new Error("Project Validation should use the retained workspace.");
    },
    writeSandboxLog: async (entry: Record<string, unknown>) => {
      this.sandboxLogs.push(entry);
    },
  };

  async destroy() {
    this.destroyed = true;
  }

  private runCommand(command: string) {
    if (command === this.commandToThrow) {
      throw new Error(`${command} exploded`);
    }

    if (
      this.options.failFreshCaptureRestore === true &&
      command.includes("fresh-capture-baseline.tgz && find")
    ) {
      return { exitCode: 1, stderr: "restore failed", stdout: "" };
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
  }
}

const STOP_DEMO_COMMAND =
  "sh -lc 'if test -f /tmp/makeademo-demo.pid; then kill -- -$(cat /tmp/makeademo-demo.pid) >/dev/null 2>&1 || true; rm -f /tmp/makeademo-demo.pid; fi'";

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

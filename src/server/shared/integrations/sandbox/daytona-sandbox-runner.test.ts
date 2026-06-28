import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import {
  DaytonaSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "./daytona-sandbox-runner";

const STOP_DEMO_COMMAND =
  "sh -lc 'if test -f /tmp/makeademo-demo.pid; then kill -- -$(cat /tmp/makeademo-demo.pid) >/dev/null 2>&1 || true; rm -f /tmp/makeademo-demo.pid; fi'";
const START_DEMO_COMMAND =
  "sh -lc 'cd /workspace && nohup setsid sh -c '\\''exec npm run demo'\\'' > /tmp/makeademo-demo.log 2>&1 & echo $! > /tmp/makeademo-demo.pid && echo $!'";
const FRESH_CAPTURE_BASELINE_COMMAND =
  "sh -lc 'mkdir -p /workspace/.makeademo && tar --exclude='\\''./.makeademo'\\'' --exclude='\\''./node_modules'\\'' -czf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace .'";
const FRESH_CAPTURE_RESTORE_COMMAND =
  "sh -lc 'test -f /workspace/.makeademo/fresh-capture-baseline.tgz && find /workspace -mindepth 1 ! -path '\\''/workspace/.makeademo'\\'' ! -path '\\''/workspace/.makeademo/*'\\'' ! -path '\\''/workspace/node_modules'\\'' ! -path '\\''/workspace/node_modules/*'\\'' -exec rm -rf {} + && tar -xzf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace'";

describe("DaytonaSandboxRunner", () => {
  it("validates the retained prepared Daytona workspace", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner({
      destroyWorkspaceOnCleanup: true,
    });

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
      STOP_DEMO_COMMAND,
      START_DEMO_COMMAND,
      "node -e 'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' 'http://localhost:3000'",
      FRESH_CAPTURE_BASELINE_COMMAND,
      "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
    ]);
    expect(workspace.networkAccess).toEqual([true, false]);
    expect(result).toMatchObject({
      browserUrl: "https://preview.example.test:3000/",
      blockedNetworkAttempts: [],
      logs: [
        "package-lock.json\npackage.json\n",
        "ran npm ci",
        `ran ${START_DEMO_COMMAND}`,
      ],
      repoFiles: ["package-lock.json", "package.json"],
      runtimeExitCode: 0,
    });

    await result.cleanup?.();

    expect(workspace.destroyed).toBe(true);
  });

  it("preserves the prepared Daytona workspace by default after validation", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner();

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    await result.cleanup?.();

    expect(workspace.destroyed).toBe(false);
  });

  it("writes Project Validation progress and demo server output to sandbox logs", async () => {
    const workspace = new FakePreparationWorkspaceHandle();
    const runner = new DaytonaSandboxRunner({
      destroyWorkspaceOnCleanup: true,
    });

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(workspace.sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "project-validation.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.repo-files.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.repo-files.succeeded",
          repoFileCount: 2,
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.dependency-install.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.dependency-install.succeeded",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-readiness.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-readiness.succeeded",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.fresh-capture-baseline.started",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.fresh-capture-baseline.created",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.browser-preview.started",
          port: 3000,
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.browser-preview.created",
          stage: "project-validation",
        }),
        expect.objectContaining({
          event: "project-validation.demo-server-log",
          log: "demo server ready",
          stage: "project-validation",
        }),
      ]),
    );
  });

  it("requires the retained Repo Preparation workspace", async () => {
    const runner = new DaytonaSandboxRunner({
      destroyWorkspaceOnCleanup: true,
    });

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
    const runner = new DaytonaSandboxRunner({
      destroyWorkspaceOnCleanup: true,
    });

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
    const runner = new DaytonaSandboxRunner({
      destroyWorkspaceOnCleanup: true,
    });

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
    expect(workspace.commands).toContain(START_DEMO_COMMAND);
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

    expect(workspace.commands).toContain(STOP_DEMO_COMMAND);
    expect(workspace.commands.indexOf(STOP_DEMO_COMMAND)).toBeLessThan(
      workspace.commands.indexOf(START_DEMO_COMMAND),
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

  it("restores the prepared baseline before Footage Capture and returns a fresh preview URL", async () => {
    const workspace = new FakePreparationWorkspaceHandle();

    const result = await restartPreparedDemoForFreshCapture({
      preparationManifest: manifest("workspace_123"),
      preparationWorkspace: workspace,
      readinessPollIntervalMs: 0,
    });

    expect(workspace.commands[0]).toBe(STOP_DEMO_COMMAND);
    expect(workspace.commands[1]).toBe(FRESH_CAPTURE_RESTORE_COMMAND);
    expect(workspace.commands[2]).toContain("exec npm run demo:makeademo");
    expect(workspace.commands[3]).toBe(
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
    const workspace = new FakePreparationWorkspaceHandle(
      new Map([[FRESH_CAPTURE_RESTORE_COMMAND, 1]]),
    );

    await expect(
      restartPreparedDemoForFreshCapture({
        preparationManifest: manifest("workspace_123"),
        preparationWorkspace: workspace,
        readinessPollIntervalMs: 0,
      }),
    ).rejects.toThrow("Fresh Footage Capture baseline could not be restored");
    expect(workspace.commands).not.toContain(START_DEMO_COMMAND);
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
  private lastReadinessExitCode = 0;

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
        this.lastReadinessExitCode = this.readinessResults.shift() ?? 0;
        return {
          exitCode: this.lastReadinessExitCode,
          stderr: "",
          stdout: "",
        };
      }

      if (command.startsWith("if test -f /tmp/makeademo-demo.log")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            this.lastReadinessExitCode === 0
              ? "demo server ready"
              : "demo server failed",
        };
      }

      if (command.includes("/tmp/makeademo-demo.log")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `ran ${command}`,
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
    writeSandboxLog: async (entry: Record<string, unknown>) => {
      this.sandboxLogs.push(entry);
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

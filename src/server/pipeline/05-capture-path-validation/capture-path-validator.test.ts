import { describe, expect, it } from "vitest";

import { validateCapturePath } from "./capture-path-validator";

describe("validateCapturePath", () => {
  it("runs project-level checks before generated capture actions", async () => {
    const calls: string[] = [];
    const sandboxLogs: Array<Record<string, unknown>> = [];

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle(sandboxLogs),
        videoScriptPackage: demoScript(),
      },
      {
        async validateProject() {
          calls.push("project-checks");
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene(input) {
            calls.push(
              `scene:${input.scene.id}:${input.baseUrl}:${input.demoPlaywrightScript}`,
            );
            return {
              logs: [
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
                "scene dry run passed",
              ],
              runDirectory: ".makeademo-capture-path-validation-runs/run_123",
              scriptPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
              status: "succeeded",
            };
          },
        },
      },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test/",
      diagnosticsLogPath:
        "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
      logs: [
        "project checks passed",
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
        "scene dry run passed",
      ],
      status: "succeeded",
      warnings: [],
    });
    expect(calls).toEqual([
      "project-checks",
      "scene:scene_validation:https://preview.example.test/:await scene('scene_validation', async () => {});",
    ]);
    expect(sandboxLogs).toEqual([
      expect.objectContaining({
        event: "capture-path-validation.runtime-preflight.started",
        stage: "capture-path-validation",
        workspaceId: "workspace_123",
      }),
      expect.objectContaining({
        event: "capture-path-validation.runtime-preflight.succeeded",
        stage: "capture-path-validation",
        workspaceId: "workspace_123",
      }),
      expect.objectContaining({
        event: "capture-path-validation.demo-script.started",
        sceneCount: 1,
        stage: "capture-path-validation",
        workspaceId: "workspace_123",
      }),
      expect.objectContaining({
        event: "capture-path-validation.scene.succeeded",
        runDirectory: ".makeademo-capture-path-validation-runs/run_123",
        sceneId: "scene_validation",
        scriptPath:
          ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
        sectionId: "demo-script",
        stage: "capture-path-validation",
        workspaceId: "workspace_123",
      }),
    ]);
  });

  it("writes verbose failure diagnostics to sandbox logs and a workspace-visible log for agent repair", async () => {
    const sandboxLogs: Array<Record<string, unknown>> = [];
    const executedCommands: string[] = [];

    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle(sandboxLogs, executedCommands),
        videoScriptPackage: demoScript(),
      },
      {
        async validateProject() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["project checks passed"],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return {
              failureReason:
                "Scene scene_validation failed during Capture Path Validation.",
              logs: [
                "stdout: loading page",
                "stderr: expect(locator('.article-preview')).toBeVisible timed out",
              ],
              runDirectory: ".makeademo-capture-path-validation-runs/run_123",
              scriptPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.ts",
              status: "failed",
              stderrPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.stderr.log",
              stdoutPath:
                ".makeademo-capture-path-validation-runs/run_123/scene_validation.stdout.log",
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      diagnosticsLogPath:
        "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
      failedSceneId: "scene_validation",
      failureReason:
        "Scene scene_validation failed during Capture Path Validation.",
      status: "failed",
    });
    expect(sandboxLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticsLogPath:
            "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
          event: "capture-path-validation.scene.failed",
          failureLogExcerpt: expect.stringContaining("article-preview"),
          sceneId: "scene_validation",
        }),
      ]),
    );
    expect(executedCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
        ),
      ]),
    );
    expect(executedCommands.join("\n")).toContain("article-preview");
  });
});

function manifest() {
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
    workspaceId: "workspace_123",
  };
}

function demoScript() {
  return {
    assumptions: [],
    demoPlan: {
      featureOrder: ["validation"],
      narrative: "Demo it",
      risks: [],
    },
    demoPlaywrightScript: "await scene('scene_validation', async () => {});",
    exploration: { assumptions: [], productSurfaces: [], summary: "" },
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Validation is visible.",
        humanReadableDescription: "Show validation.",
        id: "scene_validation",
      },
    ],
    scriptId: "script_test",
    title: "Demo",
    version: 1,
  };
}

function workspaceHandle(
  logs: Array<Record<string, unknown>>,
  executedCommands: string[] = [],
) {
  return {
    async destroy() {},
    id: "workspace_handle_123",
    workspace: {
      async execute(command: string) {
        executedCommands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
      async writeSandboxLog(entry: Record<string, unknown>) {
        logs.push(entry);
      },
    },
  };
}

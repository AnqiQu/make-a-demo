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
              logs: ["scene dry run passed"],
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
      logs: ["project checks passed", "scene dry run passed"],
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
        event: "capture-path-validation.scene.started",
        sceneId: "scene_validation",
        sectionId: "demo-script",
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

function workspaceHandle(logs: Array<Record<string, unknown>>) {
  return {
    async destroy() {},
    id: "workspace_handle_123",
    workspace: {
      async execute() {
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

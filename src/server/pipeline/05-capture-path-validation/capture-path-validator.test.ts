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
      "scene:scene_validation:https://preview.example.test/:import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => {\n  await page.goto(baseUrl);\n  await expect(page.locator('body')).toBeVisible();\n});\nawait scene('scene_validation', async ({ page, expect }) => {\n  await expect(page.locator('body')).toBeVisible();\n});",
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

  it("rejects Demo Scripts that bypass the generated Capture SDK contract", async () => {
    await expect(
      validateCapturePath(
        {
          preparationManifest: manifest(),
          preparationWorkspace: workspaceHandle([]),
          videoScriptPackage: demoScript({
            demoPlaywrightScript:
              "import { setup, scene } from './makeademo-capture-sdk';\nawait scene('scene_validation', async ({ page, expect }) => {\n  await page.context().newPage({ recordVideo: { dir: 'videos' } });\n  console.log('[makeademo:scene]', '{}');\n  await expect(page.locator('body')).toBeVisible();\n});",
          }),
        },
        {
          async validateProject() {
            return {
              blockedNetworkAttempts: [],
              browserUrl: "https://preview.example.test/",
              logs: [],
              status: "succeeded",
              warnings: [],
            };
          },
          sceneValidator: {
            async validateScene() {
              throw new Error("scene validator should not run");
            },
          },
        },
      ),
    ).rejects.toThrow("Playwright recordVideo is owned by MakeADemo");
  });

  it("rejects declared Scenes without visible assertions", async () => {
    await expect(
      validateCapturePath(
        {
          preparationManifest: manifest(),
          preparationWorkspace: workspaceHandle([]),
          videoScriptPackage: demoScript({
            demoPlaywrightScript:
              "import { setup, scene } from './makeademo-capture-sdk';\nawait scene('scene_validation', async ({ page }) => {\n  await page.getByRole('button', { name: 'Save' }).click();\n});",
          }),
        },
        {
          async validateProject() {
            return {
              blockedNetworkAttempts: [],
              browserUrl: "https://preview.example.test/",
              logs: [],
              status: "succeeded",
              warnings: [],
            };
          },
          sceneValidator: {
            async validateScene() {
              throw new Error("scene validator should not run");
            },
          },
        },
      ),
    ).rejects.toThrow(
      "Scene scene_validation must include a visible Playwright assertion",
    );
  });

  it.each([
    {
      expectedReason: "Capture Path emitted malformed Scene marker",
      logs: ['[makeademo:scene] {"event":"started"}'],
      name: "malformed marker",
    },
    {
      expectedReason:
        "Capture Path emitted undeclared Scene marker scene_extra.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_extra"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_extra"}',
      ],
      name: "undeclared marker",
    },
    {
      expectedReason: "Capture Path emitted nested Scene markers.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":11,"event":"started","sceneId":"scene_second"}',
      ],
      name: "nested markers",
    },
    {
      expectedReason:
        "Capture Path emitted duplicate Scene marker scene_validation.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":30,"event":"started","sceneId":"scene_validation"}',
      ],
      name: "duplicate markers",
    },
    {
      expectedReason:
        "Capture Path emitted succeeded marker before start for Scene scene_validation.",
      logs: [
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
      ],
      name: "out-of-order markers",
    },
    {
      expectedReason:
        "Scene scene_second did not emit complete Capture Path markers.",
      logs: [
        '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene_validation"}',
        '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene_validation"}',
      ],
      name: "uncovered declared scene",
    },
  ])("rejects $name", async ({ expectedReason, logs }) => {
    const result = await validateCapturePath(
      {
        preparationManifest: manifest(),
        preparationWorkspace: workspaceHandle([]),
        videoScriptPackage: demoScript({
          demoPlaywrightScript: validTwoSceneDemoPlaywrightScript(),
          scenes: [
            {
              expectedVisibleOutcome: "Validation is visible.",
              humanReadableDescription: "Show validation.",
              id: "scene_validation",
            },
            {
              expectedVisibleOutcome: "Second scene is visible.",
              humanReadableDescription: "Show second scene.",
              id: "scene_second",
            },
          ],
        }),
      },
      {
        async validateProject() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: [],
            status: "succeeded",
            warnings: [],
          };
        },
        sceneValidator: {
          async validateScene() {
            return { logs, status: "succeeded" };
          },
        },
      },
    );

    expect(result).toMatchObject({
      failureReason: expect.stringContaining(expectedReason),
      status: "failed",
    });
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

function demoScript(
  overrides: {
    demoPlaywrightScript?: string;
    scenes?: Array<{
      expectedVisibleOutcome: string;
      humanReadableDescription: string;
      id: string;
    }>;
  } = {},
) {
  return {
    assumptions: [],
    demoPlan: {
      featureOrder: ["validation"],
      narrative: "Demo it",
      risks: [],
    },
    demoPlaywrightScript:
      overrides.demoPlaywrightScript ??
      "import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => {\n  await page.goto(baseUrl);\n  await expect(page.locator('body')).toBeVisible();\n});\nawait scene('scene_validation', async ({ page, expect }) => {\n  await expect(page.locator('body')).toBeVisible();\n});",
    exploration: { assumptions: [], productSurfaces: [], summary: "" },
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: overrides.scenes ?? [
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

function validTwoSceneDemoPlaywrightScript() {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });",
    "await scene('scene_validation', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
    "await scene('scene_second', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
  ].join("\n");
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

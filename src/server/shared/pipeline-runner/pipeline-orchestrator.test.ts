import { describe, expect, it } from "vitest";

import { createRecordingPipelineObserver } from "./pipeline-observer";
import type { ProjectValidationResult } from "../../pipeline/04-project-validation/validation-result";
import { runPipelineJob } from "./pipeline-orchestrator";

describe("runPipelineJob", () => {
  it("runs security screen, repo preparation, validation, and script generation in order", async () => {
    const calls: string[] = [];

    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateScriptPackage({ preparationManifest, validation }) {
          calls.push("script-generation");
          return scriptPackage({
            assumptions: preparationManifest.assumptions,
            validation,
          });
        },
        async prepareRepo() {
          calls.push("repo-preparation");
          return {
            manifest: manifest(),
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          calls.push("repo-security-screen");
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateProject(input) {
          calls.push("project-validation");
          expect(input.preparationWorkspace?.id).toBe("daytona_workspace");
          return {
            blockedNetworkAttempts: [],
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "repo-security-screen",
      "repo-preparation",
      "project-validation",
      "script-generation",
    ]);
  });

  it("reports stage progress in order", async () => {
    const progress: string[] = [];

    await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateScriptPackage({ preparationManifest, validation }) {
          return scriptPackage({
            assumptions: preparationManifest.assumptions,
            validation,
          });
        },
        async prepareRepo() {
          return {
            manifest: manifest(),
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateProject() {
          return {
            blockedNetworkAttempts: [],
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
      {
        onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
      },
    );

    expect(progress).toEqual([
      "repo-security-screen:started",
      "repo-security-screen:succeeded",
      "repo-preparation:started",
      "repo-preparation:succeeded",
      "project-validation:started",
      "project-validation:succeeded",
      "script-generation:started",
      "script-generation:succeeded",
    ]);
  });

  it("reports structured stage observability events with durations and safe summary counts", async () => {
    const observer = createRecordingPipelineObserver();
    let now = 1_000;

    await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateScriptPackage({ preparationManifest, validation }) {
          now += 40;
          return {
            assumptions: preparationManifest.assumptions,
            demoPlan: {
              featureOrder: ["validation"],
              narrative: "Demo it",
              risks: ["copy risk"],
            },
            exploration: { assumptions: [], productSurfaces: [], summary: "" },
            validation,
            videoScript: {
              sections: [
                {
                  id: "section-main",
                  scenes: [
                    {
                      browserActions: ["Click primary action"],
                      id: "scene-main",
                      summary: "Show the primary action.",
                    },
                  ],
                  title: "Main flow",
                },
              ],
              title: "Demo",
            },
          };
        },
        async prepareRepo() {
          now += 20;
          return {
            manifest: {
              ...manifest(),
              assumptions: ["Uses seeded demo data."],
              createdFiles: ["makeademo.config.json"],
              mockedServices: ["billing"],
              risks: ["Needs deterministic auth fixture."],
            },
            status: "succeeded",
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          now += 5;
          return {
            rejections: [],
            status: "passed",
            warnings: ["Uses postinstall script."],
          };
        },
        async validateProject() {
          now += 30;
          return {
            blockedNetworkAttempts: [
              {
                direction: "outbound",
                host: "api.example.com",
                phase: "runtime",
              },
            ],
            logs: ["validated"],
            status: "succeeded",
            warnings: ["Viewport fallback used."],
          };
        },
      },
      {
        context: {
          demoRequestId: "demo-request-1",
          projectId: "project-1",
        },
        now: () => now,
        observer,
      },
    );

    expect(
      observer.events.map((event) => ({
        blockedNetworkAttemptCount: event.blockedNetworkAttemptCount,
        createdFileCount: event.createdFileCount,
        demoRequestId: event.demoRequestId,
        durationMs: event.durationMs,
        event: event.event,
        mockedServiceCount: event.mockedServiceCount,
        projectId: event.projectId,
        riskCount: event.riskCount,
        sceneCount: event.sceneCount,
        stage: event.stage,
        status: event.status,
        warningCount: event.warningCount,
        workspaceId: event.workspaceId,
      })),
    ).toEqual([
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-security-screen",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 5,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-security-screen",
        status: "succeeded",
        warningCount: 1,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "repo-preparation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: 1,
        demoRequestId: "demo-request-1",
        durationMs: 20,
        event: "stage.succeeded",
        mockedServiceCount: 1,
        projectId: "project-1",
        riskCount: 1,
        sceneCount: undefined,
        stage: "repo-preparation",
        status: "succeeded",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "project-validation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: 1,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 30,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "project-validation",
        status: "succeeded",
        warningCount: 1,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: undefined,
        event: "stage.started",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: undefined,
        sceneCount: undefined,
        stage: "script-generation",
        status: "started",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
      {
        blockedNetworkAttemptCount: undefined,
        createdFileCount: undefined,
        demoRequestId: "demo-request-1",
        durationMs: 40,
        event: "stage.succeeded",
        mockedServiceCount: undefined,
        projectId: "project-1",
        riskCount: 1,
        sceneCount: 1,
        stage: "script-generation",
        status: "succeeded",
        warningCount: undefined,
        workspaceId: "workspace_123",
      },
    ]);
  });

  it("uses validation produced during repo preparation without rerunning project validation", async () => {
    const calls: string[] = [];

    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateScriptPackage({ validation }) {
          calls.push("script-generation");
          expect(validation.logs).toEqual(["validated during preparation"]);
          return scriptPackage({ assumptions: [], validation });
        },
        async prepareRepo() {
          calls.push("repo-preparation");
          return {
            manifest: manifest(),
            status: "succeeded",
            validation: {
              blockedNetworkAttempts: [],
              logs: ["validated during preparation"],
              status: "succeeded",
              warnings: [],
            },
            workspace: fakeWorkspaceHandle(),
          };
        },
        screenRepoSecurity() {
          calls.push("repo-security-screen");
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateProject() {
          throw new Error("validation should not rerun after tool validation");
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "repo-security-screen",
      "repo-preparation",
      "script-generation",
    ]);
  });

  it("returns a fallback prompt and stops when Repo Preparation fails", async () => {
    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      {
        async generateScriptPackage() {
          throw new Error(
            "script generation should not run after preparation fails",
          );
        },
        async prepareRepo() {
          return {
            fallbackPrompt: "Prepare local dashboard fixtures.",
            status: "failed",
          };
        },
        screenRepoSecurity() {
          return { rejections: [], status: "passed", warnings: [] };
        },
        async validateProject() {
          throw new Error("validation should not run after preparation fails");
        },
      },
    );

    expect(result).toEqual({
      fallbackPrompt: "Prepare local dashboard fixtures.",
      status: "preparation-failed",
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

function scriptPackage(input: {
  assumptions: string[];
  validation: ProjectValidationResult;
}) {
  return {
    assumptions: input.assumptions,
    demoPlan: {
      featureOrder: ["validation"],
      narrative: "Demo it",
      risks: [],
    },
    estimatedDurationSeconds: 5,
    exploration: { assumptions: [], productSurfaces: [], summary: "" },
    format: "16:9",
    scriptId: "script_test",
    sections: [
      {
        id: "section_test",
        scenes: [
          {
            description: "Show validation.",
            durationSeconds: 5,
            events: ["Open app"],
            id: "scene_validation",
            playwrightSceneId: "scene_validation",
            playwrightScript: "await page.goto(baseUrl);",
            type: "playwright-recording" as const,
          },
        ],
        title: "Validation",
      },
    ],
    title: "Demo",
    validation: input.validation,
    version: 1,
  };
}

function fakeWorkspaceHandle() {
  return {
    async destroy() {},
    id: "daytona_workspace",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl(port: number) {
        return `https://preview.example.test:${port}`;
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

import { describe, expect, it } from "vitest";

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
          return {
            assumptions: preparationManifest.assumptions,
            demoPlan: {
              featureOrder: ["validation"],
              narrative: "Demo it",
              risks: [],
            },
            exploration: { assumptions: [], productSurfaces: [], summary: "" },
            validation,
            videoScript: { sections: [], title: "Demo" },
          };
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
          return {
            assumptions: preparationManifest.assumptions,
            demoPlan: {
              featureOrder: ["validation"],
              narrative: "Demo it",
              risks: [],
            },
            exploration: { assumptions: [], productSurfaces: [], summary: "" },
            validation,
            videoScript: { sections: [], title: "Demo" },
          };
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

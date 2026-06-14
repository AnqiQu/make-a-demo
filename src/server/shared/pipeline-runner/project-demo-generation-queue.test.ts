import { describe, expect, it } from "vitest";

import type { PipelineJobResult } from "./pipeline-job";
import { processNextProjectDemoGenerationJob } from "./project-demo-generation-queue";

describe("processNextProjectDemoGenerationJob", () => {
  it("claims one queued Project and completes it only after script and video generation finish", async () => {
    const calls: string[] = [];
    const store = {
      async claimNextQueuedProject() {
        calls.push("claim");
        return queuedProjectJob();
      },
      async markProjectCompleted(input: {
        generatedDemoUrl: string;
        projectId: string;
      }) {
        calls.push("complete");
        expect(input).toEqual({
          generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
          projectId: "project-1",
        });
      },
      async markProjectFailed() {
        throw new Error("project should not fail");
      },
    };

    const result = await processNextProjectDemoGenerationJob(store, {
      async generateFinalVideo(input) {
        calls.push("video-generation");
        expect(input.demoRequestId).toBe("demo-request-1");
        expect(input.pipelineResult.status).toBe("succeeded");
        return {
          generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
        };
      },
      async runPipeline(input) {
        calls.push("script-generation");
        expect(input.repoUrl).toBe("https://github.com/example/app");
        expect(input.demoBrief.keyProductFeatures).toEqual([
          "script generation",
        ]);
        return successfulPipelineResult();
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      status: "completed",
    });
    expect(calls).toEqual([
      "claim",
      "script-generation",
      "video-generation",
      "complete",
    ]);
  });

  it("marks the claimed Project failed when downstream generation fails", async () => {
    const calls: string[] = [];
    const store = {
      async claimNextQueuedProject() {
        calls.push("claim");
        return queuedProjectJob();
      },
      async markProjectCompleted() {
        throw new Error("project should not complete");
      },
      async markProjectFailed(input: { error: string; projectId: string }) {
        calls.push("fail");
        expect(input).toEqual({
          error: "renderer failed",
          projectId: "project-1",
        });
      },
    };

    const result = await processNextProjectDemoGenerationJob(store, {
      async generateFinalVideo() {
        calls.push("video-generation");
        throw new Error("renderer failed");
      },
      async runPipeline() {
        calls.push("script-generation");
        return successfulPipelineResult();
      },
    });

    expect(result).toEqual({
      projectId: "project-1",
      status: "failed",
    });
    expect(calls).toEqual([
      "claim",
      "script-generation",
      "video-generation",
      "fail",
    ]);
  });

  it("stays idle when no Project is queued", async () => {
    const result = await processNextProjectDemoGenerationJob(
      {
        async claimNextQueuedProject() {
          return undefined;
        },
        async markProjectCompleted() {
          throw new Error("project should not complete");
        },
        async markProjectFailed() {
          throw new Error("project should not fail");
        },
      },
      {
        async generateFinalVideo() {
          throw new Error("video generation should not run");
        },
        async runPipeline() {
          throw new Error("pipeline should not run");
        },
      },
    );

    expect(result).toEqual({ status: "idle" });
  });
});

function queuedProjectJob() {
  return {
    demoBrief: {
      audience: "Founders",
      keyProductFeatures: ["script generation"],
    },
    demoRequestId: "demo-request-1",
    normalizedSupportingDocuments: [],
    projectId: "project-1",
    repoUrl: "https://github.com/example/app",
    workspaceId: "project-1",
  };
}

function successfulPipelineResult(): PipelineJobResult {
  return {
    preparationManifest: {
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
      status: "created-new-demo",
      url: "http://localhost:3000",
      workspaceId: "project-1",
    },
    status: "succeeded",
    videoScriptPackage: {
      assumptions: [],
      demoPlan: {
        featureOrder: ["script generation"],
        narrative: "Demo script generation.",
        risks: [],
      },
      estimatedDurationSeconds: 3,
      exploration: {
        assumptions: [],
        productSurfaces: [],
        summary: "A demo generator.",
      },
      format: "16:9",
      scriptId: "script-project-1",
      sections: [
        {
          id: "section-main",
          scenes: [
            {
              description: "Demonstrate script generation.",
              durationSeconds: 3,
              events: ["Open app"],
              id: "scene-script-generation",
              playwrightSceneId: "scene-script-generation",
              playwrightScript: "await page.goto(baseUrl);",
              type: "playwright-recording",
            },
          ],
          title: "Main flow",
        },
      ],
      title: "Demo",
      validation: {
        blockedNetworkAttempts: [],
        logs: ["validated"],
        status: "succeeded",
        warnings: [],
      },
      version: 1,
    },
  };
}

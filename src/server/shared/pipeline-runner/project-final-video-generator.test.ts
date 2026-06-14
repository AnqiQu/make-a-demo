import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DemoRequestFinalVideoStore } from "../../pipeline/07-compositing/final-video-storage.interface";
import type { VideoRenderer } from "../../pipeline/07-compositing/video-renderer.interface";
import type { PipelineJobResult } from "./pipeline-job";
import {
  CompositeProjectFinalVideoGenerator,
  type CompositeProjectFinalVideoGeneratorOptions,
} from "./project-final-video-generator";

describe("CompositeProjectFinalVideoGenerator", () => {
  it("renders, stores, and links a final video from the generated script", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-queue-video-"));
    const linkedVideos: Array<{
      demoRequestId: string;
      generatedDemoUrl: string;
    }> = [];
    const demoRequestStore: DemoRequestFinalVideoStore = {
      async linkFinalVideo(input) {
        linkedVideos.push(input);
        return {
          finalVideoEmailSentAt: null,
          makerEmail: "maker@example.com",
        };
      },
      async markFinalVideoEmailSent() {
        throw new Error("email should not be marked without notifier");
      },
    };
    const renderer: VideoRenderer = {
      async renderVideo(input) {
        await writeFile(input.outputPath, "rendered mp4");
      },
    };

    const generator = new CompositeProjectFinalVideoGenerator({
      demoRequestStore,
      finalVideoStorage: {
        async storeFinalVideo(input) {
          return {
            key: `demo-videos/${input.demoRequestId}/${input.runId}/final-video.mp4`,
            r2Url: `r2://owlet/demo-videos/${input.demoRequestId}/${input.runId}/final-video.mp4`,
          };
        },
      },
      outputRoot: join(workspace, "renders"),
      renderer,
      tempRoot: workspace,
    } satisfies CompositeProjectFinalVideoGeneratorOptions);

    await expect(
      generator.generateFinalVideo({
        demoRequestId: "demo-request-1",
        pipelineResult: successfulPipelineResult(),
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      generatedDemoUrl:
        "r2://owlet/demo-videos/demo-request-1/composite-project-1/final-video.mp4",
    });
    expect(linkedVideos).toEqual([
      {
        demoRequestId: "demo-request-1",
        generatedDemoUrl:
          "r2://owlet/demo-videos/demo-request-1/composite-project-1/final-video.mp4",
      },
    ]);
  });
});

function successfulPipelineResult(): Extract<
  PipelineJobResult,
  { status: "succeeded" }
> {
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
              events: ["Show script generation"],
              id: "scene-script-generation",
              playwrightSceneId: "scene-script-generation",
              playwrightScript: "await page.goto(baseUrl);",
              type: "playwright-recording",
            },
          ],
          title: "Main flow",
        },
      ],
      title: "Generated Demo",
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

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CompositeVideoFromScriptInput,
  compositeVideoFromScript,
} from "../../pipeline/07-compositing/composite-video";
import type { FinalVideoEmailNotifier } from "../../pipeline/final-output/final-video-email-notifier.interface";
import type { PipelineJobResult } from "./pipeline-job";
import {
  type PipelineObserver,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "./pipeline-observer";
import type { ProjectFinalVideoGenerator } from "./project-demo-generation-queue";

export type CompositeProjectFinalVideoGeneratorOptions = Pick<
  CompositeVideoFromScriptInput,
  | "demoRequestStore"
  | "finalVideoStorage"
  | "outputRoot"
  | "projectRoot"
  | "publicAppBaseUrl"
  | "renderer"
> & {
  finalVideoEmailNotifier?: FinalVideoEmailNotifier;
  now?: () => number;
  observer?: PipelineObserver;
  tempRoot?: string;
};

export class CompositeProjectFinalVideoGenerator
  implements ProjectFinalVideoGenerator
{
  private readonly options: CompositeProjectFinalVideoGeneratorOptions;

  constructor(options: CompositeProjectFinalVideoGeneratorOptions) {
    this.options = options;
  }

  async generateFinalVideo(input: {
    demoRequestId: string;
    pipelineResult: Extract<PipelineJobResult, { status: "succeeded" }>;
    projectId: string;
  }) {
    const runId = `composite-${input.projectId}`;
    const observer = this.options.observer ?? noopPipelineObserver;
    const now = this.options.now ?? Date.now;
    const context = {
      demoRequestId: input.demoRequestId,
      projectId: input.projectId,
      runId,
      workspaceId: input.pipelineResult.preparationManifest.workspaceId,
    };
    observer.record({
      ...context,
      event: "stage.started",
      stage: "compositing",
      status: "started",
    });
    const startedAt = now();
    const workspace = join(this.options.tempRoot ?? tmpdir(), runId);
    await mkdir(workspace, { recursive: true });

    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const scriptPackage = input.pipelineResult.videoScriptPackage;
    const capturedScenes = await writeQueueGeneratedSceneClips({
      scriptPackage,
      workspace,
    });
    await writeFile(scriptPath, `${JSON.stringify(scriptPackage, null, 2)}\n`);
    await writeFile(
      captureManifestPath,
      `${JSON.stringify(
        {
          baseUrl: input.pipelineResult.preparationManifest.url,
          createdAt: new Date().toISOString(),
          keepTemp: false,
          manifestPath: captureManifestPath,
          qualityFindings: [],
          runDirectory: workspace,
          runId: `capture-${input.projectId}`,
          scenes: capturedScenes,
          scriptId: scriptPackage.scriptId,
          temporary: true,
          title: scriptPackage.title,
        },
        null,
        2,
      )}\n`,
    );

    let manifest: Awaited<ReturnType<typeof compositeVideoFromScript>>;
    try {
      manifest = await compositeVideoFromScript({
        captureManifestPath,
        demoRequestId: input.demoRequestId,
        ...(this.options.demoRequestStore === undefined
          ? {}
          : { demoRequestStore: this.options.demoRequestStore }),
        ...(this.options.finalVideoEmailNotifier === undefined
          ? {}
          : { finalVideoEmailNotifier: this.options.finalVideoEmailNotifier }),
        ...(this.options.finalVideoStorage === undefined
          ? {}
          : { finalVideoStorage: this.options.finalVideoStorage }),
        ...(this.options.outputRoot === undefined
          ? {}
          : { outputRoot: this.options.outputRoot }),
        ...(this.options.projectRoot === undefined
          ? {}
          : { projectRoot: this.options.projectRoot }),
        ...(this.options.publicAppBaseUrl === undefined
          ? {}
          : { publicAppBaseUrl: this.options.publicAppBaseUrl }),
        ...(this.options.renderer === undefined
          ? {}
          : { renderer: this.options.renderer }),
        runId,
        scriptPath,
      });
    } catch (error) {
      observer.record({
        ...context,
        ...sanitizeObservabilityError(error),
        durationMs: now() - startedAt,
        event: "stage.failed",
        sceneCount: countScenes(scriptPackage),
        stage: "compositing",
        status: "failed",
      });
      throw error;
    }

    if (!manifest.finalVideo) {
      const error = new Error("Final video was not stored");
      observer.record({
        ...context,
        ...sanitizeObservabilityError(error),
        durationMs: now() - startedAt,
        event: "stage.failed",
        sceneCount: countScenes(scriptPackage),
        stage: "compositing",
        status: "failed",
      });
      throw error;
    }

    observer.record({
      ...context,
      durationMs: now() - startedAt,
      event: "stage.succeeded",
      sceneCount: countScenes(scriptPackage),
      stage: "compositing",
      status: "succeeded",
    });

    return { generatedDemoUrl: manifest.finalVideo.r2Url };
  }
}

async function writeQueueGeneratedSceneClips(input: {
  scriptPackage: Extract<
    PipelineJobResult,
    { status: "succeeded" }
  >["videoScriptPackage"];
  workspace: string;
}) {
  const sceneDirectory = join(input.workspace, "scene-clips");
  await mkdir(sceneDirectory, { recursive: true });

  return await Promise.all(
    input.scriptPackage.scenes.map(async (scene) => {
      const videoPath = join(sceneDirectory, `${scene.id}.webm`);
      await writeFile(videoPath, `placeholder clip for ${scene.id}`);
      return {
        durationSeconds: 3,
        sceneId: scene.id,
        sectionId: "demo-script",
        videoPath,
      };
    }),
  );
}

function countScenes(
  scriptPackage: Extract<
    PipelineJobResult,
    { status: "succeeded" }
  >["videoScriptPackage"],
) {
  return scriptPackage.scenes.length;
}

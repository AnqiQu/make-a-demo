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

    const scriptPath = join(workspace, "video-script-package.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const scriptPackage = buildCompositingScriptPackage(input.pipelineResult);
    await writeFile(scriptPath, `${JSON.stringify(scriptPackage, null, 2)}\n`);
    await writeFile(
      captureManifestPath,
      `${JSON.stringify(
        {
          baseUrl: input.pipelineResult.preparationManifest.url,
          createdAt: new Date().toISOString(),
          keepTemp: false,
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          runId: `capture-${input.projectId}`,
          scenes: [],
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

function buildCompositingScriptPackage(
  pipelineResult: Extract<PipelineJobResult, { status: "succeeded" }>,
) {
  const sections = pipelineResult.videoScriptPackage.videoScript.sections.map(
    (section) => ({
      id: section.id,
      scenes: section.scenes.map((scene) => ({
        background: {
          colour: "#111827",
          type: "solid",
        },
        description: scene.summary,
        durationSeconds: 3,
        id: scene.id,
        text: {
          content: scene.summary,
          font: "Inter",
          "text-position": "center",
          "text-size": "large",
          "text-colour": "#f9fafb",
        },
        type: "full-screen-text",
      })),
      title: section.title,
    }),
  );

  return {
    estimatedDurationSeconds: sections.reduce(
      (total, section) => total + section.scenes.length * 3,
      0,
    ),
    format: "16:9",
    scriptId: `script-${pipelineResult.preparationManifest.workspaceId}`,
    sections,
    title: pipelineResult.videoScriptPackage.videoScript.title,
    version: 1,
  };
}

function countScenes(
  scriptPackage: ReturnType<typeof buildCompositingScriptPackage>,
) {
  return scriptPackage.sections.reduce(
    (total, section) => total + section.scenes.length,
    0,
  );
}

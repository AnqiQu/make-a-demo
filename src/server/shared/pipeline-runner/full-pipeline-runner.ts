import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../../pipeline/06-capture/capture-scenes";
import { captureScenesFromScript } from "../../pipeline/06-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../../pipeline/07-compositing/composite-video";
import { compositeVideoFromScript } from "../../pipeline/07-compositing/composite-video";
import type { PipelineJobInput } from "./pipeline-job";
import { runPipelineJob } from "./pipeline-orchestrator";
import type {
  PipelineOrchestratorDependencies,
  PipelineOrchestratorOptions,
} from "./pipeline-orchestrator";

export type FullPipelineResult = {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  scriptPath: string;
  stage1: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
  status: "succeeded";
};

export type FullPipelineRunnerOptions = PipelineOrchestratorOptions & {
  captureScenes?: (
    input: CaptureScenesFromScriptInput,
  ) => Promise<CaptureManifest>;
  compositeVideo?: (
    input: CompositeVideoFromScriptInput,
  ) => Promise<CompositedVideoManifest>;
  outputRoot?: string;
  runId?: string;
};

export async function runFullPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: FullPipelineRunnerOptions = {},
): Promise<FullPipelineResult> {
  const stage1 = await runPipelineJob(input, dependencies, options);
  if (stage1.status !== "succeeded") {
    throw new Error(`Stage 1 failed with status ${stage1.status}`);
  }

  const browserUrl = stage1.validation.browserUrl;
  if (browserUrl === undefined || browserUrl.trim().length === 0) {
    throw new Error("Stage 1 did not return a validated browser URL.");
  }

  const outputRoot = options.outputRoot ?? ".makeademo-full-pipeline-runs";
  const runId = options.runId ?? createRunId();
  const runDirectory = join(outputRoot, runId);
  await mkdir(runDirectory, { recursive: true });

  const scriptPath = join(runDirectory, "video-script-package.json");
  await writeFile(
    scriptPath,
    `${JSON.stringify(stage1.videoScriptPackage, null, 2)}\n`,
  );

  const captureManifest = await (
    options.captureScenes ?? captureScenesFromScript
  )({
    baseUrl: browserUrl,
    keepTemp: true,
    runId: "capture",
    scriptPath,
    tempRoot: join(runDirectory, "capture"),
  });
  const finalVideo = await (options.compositeVideo ?? compositeVideoFromScript)(
    {
      captureManifestPath: captureManifest.manifestPath,
      outputRoot: join(runDirectory, "composite"),
      runId: "composite",
      scriptPath,
    },
  );

  return {
    captureManifest,
    finalVideo,
    scriptPath,
    stage1,
    status: "succeeded",
  };
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

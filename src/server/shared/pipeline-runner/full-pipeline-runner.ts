import { appendFile, mkdir, writeFile } from "node:fs/promises";
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
  logPath: string;
  resultPath: string;
  scriptPath: string;
  stage1: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
  status: "succeeded";
};

type FullPipelineArtifactSummary = {
  artifacts: {
    captureManifestPath: string;
    compositeManifestPath: string;
    finalVideoPath: string;
    generatedScriptPath: string;
    logPath: string;
    renderPlanPath: string;
    viewUrl: string;
  };
  runDirectory: string;
  runId: string;
  script: {
    estimatedDurationSeconds: number;
    sceneCount: number;
    scriptId: string;
    sectionCount: number;
    title: string;
  };
  status: "succeeded";
};

type FullPipelineLogEntry = {
  event: string;
  message: string;
  timestamp: string;
} & Record<string, unknown>;

type FullPipelineLogInput = {
  event: string;
  message: string;
} & Record<string, unknown>;

export type FullPipelineRunnerOptions = PipelineOrchestratorOptions & {
  captureScenes?: (
    input: CaptureScenesFromScriptInput,
  ) => Promise<CaptureManifest>;
  compositeVideo?: (
    input: CompositeVideoFromScriptInput,
  ) => Promise<CompositedVideoManifest>;
  onLog?: (entry: FullPipelineLogEntry) => void;
  outputRoot?: string;
  runId?: string;
};

export async function runFullPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: FullPipelineRunnerOptions = {},
): Promise<FullPipelineResult> {
  const outputRoot = options.outputRoot ?? ".makeademo-full-pipeline-runs";
  const runId = options.runId ?? createRunId();
  const runDirectory = join(outputRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  const logPath = join(runDirectory, "pipeline-log.jsonl");
  const log = createPipelineLogger(logPath, options.onLog);

  await log({
    event: "pipeline-started",
    message: "Full pipeline started.",
    outputRoot,
    repoUrl: input.repoUrl,
    runDirectory,
    runId,
    workspaceId: input.workspaceId,
  });

  const stage1 = await runPipelineJob(input, dependencies, {
    ...options,
    onProgress: async (event) => {
      options.onProgress?.(event);
      await log({
        event: "stage-progress",
        message: `${event.stage} ${event.status}.`,
        stage: event.stage,
        status: event.status,
      });
    },
  });
  if (stage1.status !== "succeeded") {
    await log({
      event: "pipeline-failed",
      message: `Stage 1 failed with status ${stage1.status}.`,
      status: stage1.status,
    });
    throw new Error(`Stage 1 failed with status ${stage1.status}`);
  }

  const browserUrl = stage1.validation.browserUrl;
  if (browserUrl === undefined || browserUrl.trim().length === 0) {
    await log({
      event: "pipeline-failed",
      message: "Stage 1 did not return a validated browser URL.",
    });
    throw new Error("Stage 1 did not return a validated browser URL.");
  }

  const scriptPath = join(runDirectory, "video-script-package.json");
  await writeFile(
    scriptPath,
    `${JSON.stringify(stage1.videoScriptPackage, null, 2)}\n`,
  );
  const scriptSummary = summarizeScriptPackage(stage1.videoScriptPackage);
  await log({
    event: "script-package-written",
    message: `Script package generated: ${scriptSummary.sectionCount} section(s), ${scriptSummary.sceneCount} scene(s), ${scriptSummary.estimatedDurationSeconds}s estimated.`,
    estimatedDurationSeconds: scriptSummary.estimatedDurationSeconds,
    sceneCount: scriptSummary.sceneCount,
    scriptId: stage1.videoScriptPackage.scriptId,
    scriptPath,
    sectionCount: scriptSummary.sectionCount,
    title: stage1.videoScriptPackage.title,
  });

  await log({
    baseUrl: browserUrl,
    event: "capture-started",
    message: "Footage Capture started.",
    scriptPath,
  });
  const captureManifest = await (
    options.captureScenes ?? captureScenesFromScript
  )({
    baseUrl: browserUrl,
    keepTemp: true,
    runId: "capture",
    scriptPath,
    tempRoot: join(runDirectory, "capture"),
  });
  await log({
    event: "capture-succeeded",
    manifestPath: captureManifest.manifestPath,
    message: `Footage Capture succeeded: ${captureManifest.scenes.length} scene video(s).`,
    runDirectory: captureManifest.runDirectory,
    sceneCount: captureManifest.scenes.length,
  });

  await log({
    captureManifestPath: captureManifest.manifestPath,
    event: "compositing-started",
    message: "Compositing started.",
    scriptPath,
  });
  const finalVideo = await (options.compositeVideo ?? compositeVideoFromScript)(
    {
      captureManifestPath: captureManifest.manifestPath,
      outputRoot: join(runDirectory, "composite"),
      runId: "composite",
      scriptPath,
    },
  );
  await log({
    event: "compositing-succeeded",
    manifestPath: finalVideo.manifestPath,
    message: "Compositing succeeded.",
    outputVideoPath: finalVideo.outputVideoPath,
    renderPlanPath: finalVideo.renderPlanPath,
    viewUrl: finalVideo.viewUrl,
  });
  await log({
    event: "pipeline-succeeded",
    message: "Full pipeline succeeded.",
    viewUrl: finalVideo.viewUrl,
  });
  const resultPath = join(runDirectory, "full-pipeline-result.json");
  const artifactSummary: FullPipelineArtifactSummary = {
    artifacts: {
      captureManifestPath: captureManifest.manifestPath,
      compositeManifestPath: finalVideo.manifestPath,
      finalVideoPath: finalVideo.outputVideoPath ?? finalVideo.viewUrl,
      generatedScriptPath: scriptPath,
      logPath,
      renderPlanPath: finalVideo.renderPlanPath,
      viewUrl: finalVideo.viewUrl,
    },
    runDirectory,
    runId,
    script: {
      estimatedDurationSeconds: scriptSummary.estimatedDurationSeconds,
      sceneCount: scriptSummary.sceneCount,
      scriptId: stage1.videoScriptPackage.scriptId,
      sectionCount: scriptSummary.sectionCount,
      title: stage1.videoScriptPackage.title,
    },
    status: "succeeded",
  };
  await writeFile(resultPath, `${JSON.stringify(artifactSummary, null, 2)}\n`);
  await log({
    event: "result-written",
    message: "Full pipeline result written.",
    resultPath,
  });

  return {
    captureManifest,
    finalVideo,
    logPath,
    resultPath,
    scriptPath,
    stage1,
    status: "succeeded",
  };
}

function createPipelineLogger(
  logPath: string,
  onLog: ((entry: FullPipelineLogEntry) => void) | undefined,
) {
  return async (entry: FullPipelineLogInput) => {
    const logEntry: FullPipelineLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    onLog?.(logEntry);
    await appendFile(logPath, `${JSON.stringify(logEntry)}\n`);
  };
}

function summarizeScriptPackage(
  scriptPackage: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["videoScriptPackage"],
) {
  return {
    estimatedDurationSeconds: scriptPackage.estimatedDurationSeconds,
    sceneCount: scriptPackage.sections.reduce(
      (total, section) => total + section.scenes.length,
      0,
    ),
    sectionCount: scriptPackage.sections.length,
  };
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../06-footage-capture/capture-scenes";
import { captureScenesFromScript } from "../06-footage-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../07-compositing/composite-video";
import { compositeVideoFromScript } from "../07-compositing/composite-video";
import type { PipelineJobInput } from "./pipeline-job";
import { runPipelineJob } from "./pipeline-orchestrator";
import type {
  PipelineOrchestratorDependencies,
  PipelineOrchestratorOptions,
  ScriptGenerationReadyEvent,
} from "./pipeline-orchestrator";

export type FullPipelineResult = {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  logPath: string;
  resultPath: string;
  scriptPath: string;
  preCapture: Extract<
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
    scriptGenerationResumePath?: string;
    scriptGenerationRawOpenCodeLogPath?: string;
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
  rawOpenCodeLogPath?: string;
  runId?: string;
  scriptGenerationRawOpenCodeLogPath?: string;
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

  let scriptGenerationResumePath: string | undefined;
  const preCapture = await runPipelineJob(input, dependencies, {
    ...options,
    onScriptGenerationReady: async (event) => {
      await options.onScriptGenerationReady?.(event);
      scriptGenerationResumePath = await writeScriptGenerationResumeFile({
        event,
        input,
        runDirectory,
      });
      if (scriptGenerationResumePath !== undefined) {
        await log({
          event: "script-generation-resume-written",
          message: "Script Generation resume artifact written.",
          resumePath: scriptGenerationResumePath,
        });
      }
    },
    onProgress: async (event) => {
      await options.onProgress?.(event);
      await log({
        event: "stage-progress",
        message: `${event.stage} ${event.status}.`,
        stage: event.stage,
        status: event.status,
      });
    },
  });
  if (preCapture.status !== "succeeded") {
    const resultPath = join(runDirectory, "full-pipeline-result.json");
    await log({
      event: "pipeline-failed",
      message: `pre-capture failed with status ${preCapture.status}.`,
      status: preCapture.status,
    });
    await writeFile(
      resultPath,
      `${JSON.stringify(
        createFailureSummary({
          logPath,
          rawOpenCodeLogPath: options.rawOpenCodeLogPath,
          runDirectory,
          runId,
          scriptGenerationRawOpenCodeLogPath:
            options.scriptGenerationRawOpenCodeLogPath,
          preCapture,
        }),
        null,
        2,
      )}\n`,
    );
    await log({
      event: "result-written",
      message: "Full pipeline failure result written.",
      resultPath,
    });
    throw new Error(`pre-capture failed with status ${preCapture.status}`);
  }

  const browserUrl = preCapture.validation.browserUrl;
  if (browserUrl === undefined || browserUrl.trim().length === 0) {
    await log({
      event: "pipeline-failed",
      message: "pre-capture did not return a validated browser URL.",
    });
    throw new Error("pre-capture did not return a validated browser URL.");
  }

  const scriptPath = join(runDirectory, "video-script-package.json");
  await writeFile(
    scriptPath,
    `${JSON.stringify(preCapture.videoScriptPackage, null, 2)}\n`,
  );
  const scriptSummary = summarizeScriptPackage(preCapture.videoScriptPackage);
  await log({
    event: "script-package-written",
    message: `Script package generated: ${scriptSummary.sectionCount} section(s), ${scriptSummary.sceneCount} scene(s), ${scriptSummary.estimatedDurationSeconds}s estimated.`,
    estimatedDurationSeconds: scriptSummary.estimatedDurationSeconds,
    sceneCount: scriptSummary.sceneCount,
    scriptId: preCapture.videoScriptPackage.scriptId,
    scriptPath,
    sectionCount: scriptSummary.sectionCount,
    title: preCapture.videoScriptPackage.title,
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
      ...(options.rawOpenCodeLogPath === undefined
        ? {}
        : { rawOpenCodeLogPath: options.rawOpenCodeLogPath }),
      renderPlanPath: finalVideo.renderPlanPath,
      ...(scriptGenerationResumePath === undefined
        ? {}
        : { scriptGenerationResumePath }),
      ...(options.scriptGenerationRawOpenCodeLogPath === undefined
        ? {}
        : {
            scriptGenerationRawOpenCodeLogPath:
              options.scriptGenerationRawOpenCodeLogPath,
          }),
      viewUrl: finalVideo.viewUrl,
    },
    runDirectory,
    runId,
    script: {
      estimatedDurationSeconds: scriptSummary.estimatedDurationSeconds,
      sceneCount: scriptSummary.sceneCount,
      scriptId: preCapture.videoScriptPackage.scriptId,
      sectionCount: scriptSummary.sectionCount,
      title: preCapture.videoScriptPackage.title,
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
    preCapture,
    status: "succeeded",
  };
}

async function writeScriptGenerationResumeFile(input: {
  event: ScriptGenerationReadyEvent;
  input: PipelineJobInput;
  runDirectory: string;
}): Promise<string | undefined> {
  if (
    input.event.opencodeSessionID === undefined ||
    input.event.preparationWorkspace === undefined
  ) {
    return undefined;
  }

  const resumePath = join(input.runDirectory, "script-generation-resume.json");
  await writeFile(
    resumePath,
    `${JSON.stringify(
      {
        demoBrief: input.input.demoBrief,
        normalizedSupportingDocuments:
          input.input.normalizedSupportingDocuments,
        opencodeSessionID: input.event.opencodeSessionID,
        preparationManifest: input.event.preparationManifest,
        preparationWorkspaceId: input.event.preparationWorkspace.id,
        repoUrl: input.input.repoUrl,
        runDirectory: input.runDirectory,
        validation: input.event.validation,
      },
      null,
      2,
    )}\n`,
  );

  return resumePath;
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
  const sceneCount = scriptPackage.scenes.length;
  return {
    estimatedDurationSeconds: sceneCount * 3,
    sceneCount,
    sectionCount: sceneCount === 0 ? 0 : 1,
  };
}

function createFailureSummary(input: {
  logPath: string;
  rawOpenCodeLogPath: string | undefined;
  runDirectory: string;
  runId: string;
  scriptGenerationRawOpenCodeLogPath: string | undefined;
  preCapture: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
}) {
  return {
    artifacts: {
      logPath: input.logPath,
      ...(input.rawOpenCodeLogPath === undefined
        ? {}
        : { rawOpenCodeLogPath: input.rawOpenCodeLogPath }),
      ...(input.scriptGenerationRawOpenCodeLogPath === undefined
        ? {}
        : {
            scriptGenerationRawOpenCodeLogPath:
              input.scriptGenerationRawOpenCodeLogPath,
          }),
    },
    failure: readPreCaptureFailure(input.preCapture),
    runDirectory: input.runDirectory,
    runId: input.runId,
    status: input.preCapture.status,
  };
}

function readPreCaptureFailure(
  preCapture: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >,
) {
  if (preCapture.status === "preparation-failed") {
    return {
      blockers: [preCapture.fallbackPrompt],
      suggestedChanges: [],
    };
  }

  if (preCapture.status === "validation-failed") {
    return {
      blockers: [
        preCapture.validation.failureReason ?? "Project validation failed.",
      ],
      suggestedChanges: preCapture.validation.warnings,
    };
  }

  return {
    blockers: preCapture.security.rejections,
    suggestedChanges: preCapture.security.warnings,
  };
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

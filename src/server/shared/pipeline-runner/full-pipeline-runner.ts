import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DemoRequestScriptStore } from "../../pipeline/04-script-generation/demo-request-script-store.interface";
import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../../pipeline/06-footage-capture/capture-scenes";
import { captureScenesFromScript } from "../../pipeline/06-footage-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../../pipeline/07-compositing/composite-video";
import { compositeVideoFromScript } from "../../pipeline/07-compositing/composite-video";
import {
  type PipelineLogSink,
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../logging/pipeline-event-logger";
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
  scriptPath?: string;
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
    generatedScriptDemoRequestId?: string;
    generatedScriptPath?: string;
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
  time: string;
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
  demoRequestScriptStore?: DemoRequestScriptStore;
  onLog?: (entry: FullPipelineLogEntry) => void;
  logSinks?: PipelineLogSink[];
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
  const log = createPipelineLogger(logPath, {
    extraSinks: options.logSinks ?? [],
    onLog: options.onLog,
  });

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
  const stage1 = await runPipelineJob(input, dependencies, {
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
  if (stage1.status !== "succeeded") {
    const resultPath = join(runDirectory, "full-pipeline-result.json");
    await log({
      event: "pipeline-failed",
      message: `Stage 1 failed with status ${stage1.status}.`,
      status: stage1.status,
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
          stage1,
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
    throw new Error(`Stage 1 failed with status ${stage1.status}`);
  }

  const browserUrl = stage1.capturePathValidation.browserUrl;
  if (browserUrl === undefined || browserUrl.trim().length === 0) {
    await log({
      event: "pipeline-failed",
      message: "Capture Path Validation did not return a browser URL.",
    });
    throw new Error("Capture Path Validation did not return a browser URL.");
  }

  const scriptSummary = summarizeScriptPackage(stage1.videoScriptPackage);
  const scriptPersistence = await persistGeneratedScript({
    demoRequestId: options.context?.demoRequestId,
    log,
    runDirectory,
    scriptPackage: stage1.videoScriptPackage,
    scriptStore: options.demoRequestScriptStore,
    scriptSummary,
  });

  await log({
    baseUrl: browserUrl,
    event: "capture-started",
    message: "Footage Capture started.",
    ...(scriptPersistence.scriptPath === undefined
      ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
      : { scriptPath: scriptPersistence.scriptPath }),
  });
  const captureManifest = await (
    options.captureScenes ?? captureScenesFromScript
  )({
    baseUrl: browserUrl,
    keepTemp: true,
    runId: "capture",
    scriptPackage: stage1.videoScriptPackage,
    ...(scriptPersistence.scriptPath === undefined
      ? {}
      : { scriptPath: scriptPersistence.scriptPath }),
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
    ...(scriptPersistence.scriptPath === undefined
      ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
      : { scriptPath: scriptPersistence.scriptPath }),
  });
  const finalVideo = await (options.compositeVideo ?? compositeVideoFromScript)(
    {
      captureManifestPath: captureManifest.manifestPath,
      outputRoot: join(runDirectory, "composite"),
      runId: "composite",
      scriptDirectory: runDirectory,
      scriptPackage: stage1.videoScriptPackage,
      ...(scriptPersistence.scriptPath === undefined
        ? {}
        : { scriptPath: scriptPersistence.scriptPath }),
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
      ...(scriptPersistence.demoRequestId === undefined
        ? {}
        : { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }),
      ...(scriptPersistence.scriptPath === undefined
        ? {}
        : { generatedScriptPath: scriptPersistence.scriptPath }),
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
    ...(scriptPersistence.scriptPath === undefined
      ? {}
      : { scriptPath: scriptPersistence.scriptPath }),
    stage1,
    status: "succeeded",
  };
}

async function persistGeneratedScript(input: {
  demoRequestId: string | undefined;
  log: (entry: FullPipelineLogInput) => Promise<void>;
  runDirectory: string;
  scriptPackage: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["videoScriptPackage"];
  scriptStore: DemoRequestScriptStore | undefined;
  scriptSummary: ReturnType<typeof summarizeScriptPackage>;
}): Promise<{ demoRequestId?: string; scriptPath?: string }> {
  if (input.scriptStore === undefined) {
    const scriptPath = join(input.runDirectory, "video-script-package.json");
    await writeFile(
      scriptPath,
      `${JSON.stringify(input.scriptPackage, null, 2)}\n`,
    );
    await input.log({
      event: "script-package-written",
      message: scriptGeneratedMessage(input.scriptSummary),
      estimatedDurationSeconds: input.scriptSummary.estimatedDurationSeconds,
      sceneCount: input.scriptSummary.sceneCount,
      scriptId: input.scriptPackage.scriptId,
      scriptPath,
      sectionCount: input.scriptSummary.sectionCount,
      title: input.scriptPackage.title,
    });

    return { scriptPath };
  }

  if (input.demoRequestId === undefined) {
    throw new Error(
      "context.demoRequestId is required to save the generated script to the database.",
    );
  }

  await input.scriptStore.saveGeneratedScript({
    demoRequestId: input.demoRequestId,
    script: input.scriptPackage,
  });
  await input.log({
    demoRequestId: input.demoRequestId,
    event: "script-package-saved",
    message: scriptGeneratedMessage(input.scriptSummary),
    estimatedDurationSeconds: input.scriptSummary.estimatedDurationSeconds,
    sceneCount: input.scriptSummary.sceneCount,
    scriptId: input.scriptPackage.scriptId,
    sectionCount: input.scriptSummary.sectionCount,
    title: input.scriptPackage.title,
  });

  return { demoRequestId: input.demoRequestId };
}

function scriptGeneratedMessage(
  scriptSummary: ReturnType<typeof summarizeScriptPackage>,
) {
  return `Script package generated: ${scriptSummary.sectionCount} section(s), ${scriptSummary.sceneCount} scene(s), ${scriptSummary.estimatedDurationSeconds}s estimated.`;
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
      },
      null,
      2,
    )}\n`,
  );

  return resumePath;
}

function createPipelineLogger(
  logPath: string,
  options: {
    extraSinks: PipelineLogSink[];
    onLog: ((entry: FullPipelineLogEntry) => void) | undefined;
  },
) {
  const sinks: PipelineLogSink[] = [
    createFilePipelineLogSink(logPath),
    ...options.extraSinks,
  ];
  if (options.onLog !== undefined) {
    sinks.push({
      write(line) {
        options.onLog?.(JSON.parse(line) as FullPipelineLogEntry);
      },
    });
  }

  const logger = createPipelineEventLogger({
    base: { component: "full-pipeline" },
    sinks,
  });

  return async (entry: FullPipelineLogInput) => {
    await logger.info(entry, entry.message);
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

function createFailureSummary(input: {
  logPath: string;
  rawOpenCodeLogPath: string | undefined;
  runDirectory: string;
  runId: string;
  scriptGenerationRawOpenCodeLogPath: string | undefined;
  stage1: Exclude<
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
    failure: readStage1Failure(input.stage1),
    runDirectory: input.runDirectory,
    runId: input.runId,
    status: input.stage1.status,
  };
}

function readStage1Failure(
  stage1: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >,
) {
  if (stage1.status === "preparation-failed") {
    return {
      blockers: [stage1.fallbackPrompt],
      suggestedChanges: [],
    };
  }

  if (stage1.status === "capture-path-validation-failed") {
    return {
      blockers: [
        "Capture Path Validation failed. Please report this issue to MakeADemo.",
      ],
      suggestedChanges: stage1.capturePathValidation.warnings,
    };
  }

  return {
    blockers: stage1.security.rejections,
    suggestedChanges: stage1.security.warnings,
  };
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

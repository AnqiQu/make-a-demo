import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type PipelineLogSink,
  createFilePipelineLogSink,
  createPipelineEventLogger,
} from "../../shared/logging/pipeline-event-logger";
import type { DemoRequestScriptStore } from "../04-script-generation/demo-request-script-store.interface";
import type {
  CaptureManifest,
  CaptureScenesFromScriptInput,
} from "../06-footage-capture/capture-scenes";
import type {
  CompositeVideoFromScriptInput,
  CompositedVideoManifest,
} from "../07-compositing/composite-video";
import type { DraftCompositeEvidence } from "../07-compositing/draft-composite-quality-review";
import type { DraftCompositeReviewer } from "../07-compositing/draft-composite-reviewer.interface";
import {
  type DraftCompositeReviewSummary,
  type ScriptPersistence,
  runDraftCompositeReviewLoop,
} from "./draft-composite-review-loop";
import type { PipelineJobInput } from "./pipeline-job";
import { runPipelineJob } from "./pipeline-orchestrator";
import type {
  PipelineOrchestratorDependencies,
  PipelineOrchestratorOptions,
  ScriptGenerationReadyEvent,
} from "./pipeline-orchestrator";

export type FullPipelineResult = {
  captureManifest: CaptureManifest;
  draftCompositeReview: DraftCompositeReviewSummary;
  finalVideo: CompositedVideoManifest;
  logPath: string;
  resultPath: string;
  sandboxLogPath?: string;
  scriptPath?: string;
  stage1: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >;
  status: "succeeded";
};

export type FullPipelineFailureContext = {
  failure: ReturnType<typeof readStage1Failure>;
  logPath: string;
  rawOpenCodeLogPath: string | undefined;
  resultPath: string;
  stage: "stage-1";
  status: Exclude<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["status"];
};

export class FullPipelineStageFailure extends Error {
  readonly failure: FullPipelineFailureContext["failure"];
  readonly logPath: string;
  readonly rawOpenCodeLogPath: string | undefined;
  readonly resultPath: string;
  readonly stage: "stage-1";
  readonly status: FullPipelineFailureContext["status"];

  constructor(context: FullPipelineFailureContext) {
    super(`Stage 1 failed with status ${context.status}`);
    this.name = "FullPipelineStageFailure";
    this.failure = context.failure;
    this.logPath = context.logPath;
    this.rawOpenCodeLogPath = context.rawOpenCodeLogPath;
    this.resultPath = context.resultPath;
    this.stage = context.stage;
    this.status = context.status;
  }
}

type SucceededStage1 = Extract<
  Awaited<ReturnType<typeof runPipelineJob>>,
  { status: "succeeded" }
>;

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
    sandboxLogPath?: string;
    viewUrl: string;
  };
  draftCompositeReview: DraftCompositeReviewSummary;
  runDirectory: string;
  runId: string;
  script: {
    sceneCount: number;
    scriptId: string;
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
  /** Maximum duration for each ffmpeg or ffprobe evidence command. */
  evidenceCommandTimeoutMs?: number;
  onLog?: (entry: FullPipelineLogEntry) => void;
  logSinks?: PipelineLogSink[];
  outputRoot?: string;
  rawOpenCodeLogPath?: string;
  reviewDraftComposite?: DraftCompositeReviewer;
  inspectDraftCompositeEvidence?: (input: {
    captureManifest: CaptureManifest;
    draftComposite: CompositedVideoManifest;
    scriptPackage: SucceededStage1["demoScriptPackage"];
  }) => Promise<DraftCompositeEvidence>;
  prepareFreshCaptureState?: (input: {
    attempt: number;
    browserUrl: string;
    stage1: SucceededStage1;
  }) => Promise<{ browserUrl?: string }>;
  runId?: string;
  sandboxLogPath?: string;
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
  const sandboxLogPath = options.sandboxLogPath;
  const log = createPipelineLogger(logPath, {
    extraSinks: options.logSinks ?? [],
    onLog: options.onLog,
  });
  const preparationWorkspaces = new Set<
    NonNullable<SucceededStage1["preparationWorkspace"]>
  >();
  const orchestratorDependencies: PipelineOrchestratorDependencies = {
    ...dependencies,
    async prepareRepo(preparationInput) {
      const result = await dependencies.prepareRepo(preparationInput);
      if (result.status === "succeeded" && result.workspace !== undefined) {
        preparationWorkspaces.add(result.workspace);
      }
      return result;
    },
  };

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
  const initialStage1 = await runPipelineJob(input, orchestratorDependencies, {
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
  if (initialStage1.status !== "succeeded") {
    const resultPath = join(runDirectory, "full-pipeline-result.json");
    const failureSummary = createFailureSummary({
      logPath,
      rawOpenCodeLogPath: options.rawOpenCodeLogPath,
      runDirectory,
      runId,
      sandboxLogPath,
      scriptGenerationRawOpenCodeLogPath:
        options.scriptGenerationRawOpenCodeLogPath,
      stage1: initialStage1,
    });
    await log({
      event: "pipeline-failed",
      message: `Stage 1 failed with status ${initialStage1.status}.`,
      status: initialStage1.status,
    });
    await writeFile(resultPath, `${JSON.stringify(failureSummary, null, 2)}\n`);
    await log({
      event: "result-written",
      message: "Full pipeline failure result written.",
      resultPath,
    });
    throw new FullPipelineStageFailure({
      failure: failureSummary.failure,
      logPath,
      rawOpenCodeLogPath: options.rawOpenCodeLogPath,
      resultPath,
      stage: "stage-1",
      status: initialStage1.status,
    });
  }

  let stage1: SucceededStage1 = initialStage1;

  const browserUrl = stage1.capturePathValidation.browserUrl;
  if (browserUrl === undefined || browserUrl.trim().length === 0) {
    await log({
      event: "pipeline-failed",
      message: "Capture Path Validation did not return a browser URL.",
    });
    throw new Error("Capture Path Validation did not return a browser URL.");
  }

  let scriptSummary = summarizeScriptPackage(stage1.demoScriptPackage);
  let scriptPersistence = await persistGeneratedScript({
    demoRequestId: options.context?.demoRequestId,
    log,
    runDirectory,
    scriptPackage: stage1.demoScriptPackage,
    scriptStore: options.demoRequestScriptStore,
    scriptSummary,
  });

  const reviewResult = await runDraftCompositeReviewLoop({
    browserUrl,
    dependencies: orchestratorDependencies,
    input,
    log,
    options,
    runDirectory,
    persistScript: (scriptPackage) =>
      persistGeneratedScript({
        demoRequestId: options.context?.demoRequestId,
        log,
        runDirectory,
        scriptPackage,
        scriptStore: options.demoRequestScriptStore,
        scriptSummary: summarizeScriptPackage(scriptPackage),
      }),
    scriptPersistence,
    stage1,
  });
  stage1 = reviewResult.stage1;
  scriptSummary = summarizeScriptPackage(stage1.demoScriptPackage);
  scriptPersistence = reviewResult.scriptPersistence;
  const { captureManifest, finalVideo, reviewSummary } = reviewResult;
  await writeDraftCompositeReviewMetadata({
    finalVideo,
    reviewSummary,
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
      ...(sandboxLogPath === undefined ? {} : { sandboxLogPath }),
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
    draftCompositeReview: reviewSummary,
    runDirectory,
    runId,
    script: {
      sceneCount: scriptSummary.sceneCount,
      scriptId: stage1.demoScriptPackage.scriptId,
      title: stage1.demoScriptPackage.title,
    },
    status: "succeeded",
  };
  await writeFile(resultPath, `${JSON.stringify(artifactSummary, null, 2)}\n`);
  await log({
    event: "result-written",
    message: "Full pipeline result written.",
    resultPath,
  });
  await cleanupPreparationWorkspaces({
    handles: preparationWorkspaces,
    log,
  });

  return {
    captureManifest,
    draftCompositeReview: reviewSummary,
    finalVideo,
    logPath,
    resultPath,
    ...(sandboxLogPath === undefined ? {} : { sandboxLogPath }),
    ...(scriptPersistence.scriptPath === undefined
      ? {}
      : { scriptPath: scriptPersistence.scriptPath }),
    stage1,
    status: "succeeded",
  };
}

async function cleanupPreparationWorkspaces(input: {
  handles: Iterable<NonNullable<SucceededStage1["preparationWorkspace"]>>;
  log: (entry: FullPipelineLogInput) => Promise<void>;
}) {
  for (const handle of input.handles) {
    await logCleanupEvent(input.log, {
      event: "preparation-workspace-cleanup.started",
      message: "Preparation workspace cleanup started.",
      workspaceId: handle.id,
    });

    const startedAt = Date.now();
    try {
      await handle.destroy();
      await logCleanupEvent(input.log, {
        durationMs: Date.now() - startedAt,
        event: "preparation-workspace-cleanup.succeeded",
        message: "Preparation workspace cleanup succeeded.",
        workspaceId: handle.id,
      });
    } catch (error) {
      await logCleanupEvent(input.log, {
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error),
        event: "preparation-workspace-cleanup.failed",
        message: "Preparation workspace cleanup failed.",
        workspaceId: handle.id,
      });
    }
  }
}

async function logCleanupEvent(
  log: (entry: FullPipelineLogInput) => Promise<void>,
  entry: FullPipelineLogInput,
) {
  try {
    await log(entry);
  } catch {
    // Cleanup observability must not hide an already durable successful result.
  }
}

async function writeDraftCompositeReviewMetadata(input: {
  finalVideo: CompositedVideoManifest;
  reviewSummary: DraftCompositeReviewSummary;
}) {
  input.finalVideo.draftCompositeReview = input.reviewSummary;
  await writeFile(
    input.finalVideo.manifestPath,
    `${JSON.stringify(input.finalVideo, null, 2)}\n`,
  );
}

async function persistGeneratedScript(input: {
  demoRequestId: string | undefined;
  log: (entry: FullPipelineLogInput) => Promise<void>;
  runDirectory: string;
  scriptPackage: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["demoScriptPackage"];
  scriptStore: DemoRequestScriptStore | undefined;
  scriptSummary: ReturnType<typeof summarizeScriptPackage>;
}): Promise<ScriptPersistence> {
  if (input.scriptStore === undefined) {
    const scriptPath = join(input.runDirectory, "demo-script.json");
    await writeFile(
      scriptPath,
      `${JSON.stringify(input.scriptPackage, null, 2)}\n`,
    );
    await input.log({
      event: "demo-script-written",
      message: scriptGeneratedMessage(input.scriptSummary),
      sceneCount: input.scriptSummary.sceneCount,
      scriptId: input.scriptPackage.scriptId,
      scriptPath,
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
    event: "demo-script-saved",
    message: scriptGeneratedMessage(input.scriptSummary),
    sceneCount: input.scriptSummary.sceneCount,
    scriptId: input.scriptPackage.scriptId,
    title: input.scriptPackage.title,
  });

  return { demoRequestId: input.demoRequestId };
}

function scriptGeneratedMessage(
  scriptSummary: ReturnType<typeof summarizeScriptPackage>,
) {
  return `Accepted Demo Script ready: ${scriptSummary.sceneCount} scene(s).`;
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
  >["demoScriptPackage"],
) {
  return {
    sceneCount: scriptPackage.scenes.length,
  };
}

function createFailureSummary(input: {
  logPath: string;
  rawOpenCodeLogPath: string | undefined;
  runDirectory: string;
  runId: string;
  sandboxLogPath: string | undefined;
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
      ...(input.sandboxLogPath === undefined
        ? {}
        : { sandboxLogPath: input.sandboxLogPath }),
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
    const capturePathValidation = stage1.capturePathValidation;
    return {
      blockers: [
        "Capture Path Validation failed. Please report this issue to MakeADemo.",
        ...(capturePathValidation.failureReason === undefined ||
        capturePathValidation.failureReason.trim().length === 0
          ? []
          : [
              `Capture Path Validation reason: ${capturePathValidation.failureReason}`,
            ]),
      ],
      capturePathValidation: removeUndefinedFields({
        diagnosticsLogPath: capturePathValidation.diagnosticsLogPath,
        failedAction: capturePathValidation.failedAction,
        failedSceneId: capturePathValidation.failedSceneId,
        failureReason: capturePathValidation.failureReason,
        runDirectory: capturePathValidation.runDirectory,
        screenshotArtifactId: capturePathValidation.screenshotArtifactId,
        scriptPath: capturePathValidation.scriptPath,
        stderrPath: capturePathValidation.stderrPath,
        stdoutPath: capturePathValidation.stdoutPath,
      }),
      suggestedChanges: stage1.capturePathValidation.warnings,
    };
  }

  return {
    blockers: stage1.security.rejections,
    suggestedChanges: stage1.security.warnings,
  };
}

function removeUndefinedFields(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

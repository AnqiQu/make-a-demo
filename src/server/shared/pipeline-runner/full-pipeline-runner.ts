import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
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
  draftCompositeReview: DraftCompositeReviewSummary;
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

export type DraftCompositeReviewInput = {
  attempt: number;
  captureManifest: CaptureManifest;
  derivedEvidence: {
    contactSheetPaths: string[];
    draftDurationSeconds: number;
    ffmpegFindings: string[];
    markerSummary: Array<{
      durationSeconds: number;
      sceneId: string;
    }>;
    qualityFindings: string[];
    rawDraftCompositePath?: string;
    rawTakePath?: string;
    sampledFramePaths: string[];
  };
  draftComposite: CompositedVideoManifest;
  opencodeSessionID?: string;
  preparationWorkspace?: PreparationWorkspaceHandle;
  scriptPackage: Extract<
    Awaited<ReturnType<typeof runPipelineJob>>,
    { status: "succeeded" }
  >["demoScriptPackage"];
};

type DraftCompositeEvidence = {
  audioProbeFailed?: boolean;
  audioPresent?: boolean;
  contactSheetPaths: string[];
  ffmpegFindings: string[];
  sampledFramePaths: string[];
  staticProbeFailedSceneIds?: string[];
  staticSceneIds: string[];
};

export type DraftCompositeReviewDecision =
  | {
      decision: "accept";
      reason?: string;
    }
  | {
      decision: "repair";
      reason: string;
      repairScope: "demo-script" | "workspace";
    };

type DraftCompositeReviewSummary = {
  attempts: number;
  findings: string[];
  status: "accepted" | "exhausted";
  warnings: string[];
};

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
  reviewDraftComposite?: (
    input: DraftCompositeReviewInput,
  ) => Promise<DraftCompositeReviewDecision>;
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
  const initialStage1 = await runPipelineJob(input, dependencies, {
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
    await log({
      event: "pipeline-failed",
      message: `Stage 1 failed with status ${initialStage1.status}.`,
      status: initialStage1.status,
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
          stage1: initialStage1,
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
    throw new Error(`Stage 1 failed with status ${initialStage1.status}`);
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

  const reviewResult = await captureCompositeAndReview({
    browserUrl,
    dependencies,
    input,
    log,
    options,
    runDirectory,
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

  return {
    captureManifest,
    draftCompositeReview: reviewSummary,
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

async function captureCompositeAndReview(input: {
  browserUrl: string;
  dependencies: PipelineOrchestratorDependencies;
  input: PipelineJobInput;
  log: (entry: FullPipelineLogInput) => Promise<void>;
  options: FullPipelineRunnerOptions;
  runDirectory: string;
  scriptPersistence: { demoRequestId?: string; scriptPath?: string };
  stage1: SucceededStage1;
}): Promise<{
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  reviewSummary: DraftCompositeReviewSummary;
  scriptPersistence: { demoRequestId?: string; scriptPath?: string };
  stage1: SucceededStage1;
}> {
  const reviewRepairLimit = readDraftCompositeReviewAttemptLimit();
  const reviewer = input.options.reviewDraftComposite ?? defaultDraftReview;
  let stage1 = input.stage1;
  let browserUrl = input.browserUrl;
  let scriptPersistence = input.scriptPersistence;
  let latestCaptureManifest: CaptureManifest | undefined;
  let latestFinalVideo: CompositedVideoManifest | undefined;
  let latestFindings: string[] = [];
  let latestRepairReason: string | undefined;

  for (let attempt = 1; attempt <= reviewRepairLimit + 1; attempt += 1) {
    const runSuffix = String(attempt);
    if (
      input.options.prepareFreshCaptureState === undefined &&
      input.options.captureScenes === undefined
    ) {
      throw new Error(
        "Footage Capture requires a fresh deterministic app-state reset before recording.",
      );
    }
    const freshState = await input.options.prepareFreshCaptureState?.({
      attempt,
      browserUrl,
      stage1,
    });
    browserUrl = freshState?.browserUrl ?? browserUrl;
    await input.log({
      attempt,
      baseUrl: browserUrl,
      event: "capture-started",
      message: "Footage Capture started.",
      ...(scriptPersistence.scriptPath === undefined
        ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
        : { scriptPath: scriptPersistence.scriptPath }),
    });
    const captureManifest = await (
      input.options.captureScenes ?? captureScenesFromScript
    )({
      baseUrl: browserUrl,
      keepTemp: true,
      runId: `capture-${runSuffix}`,
      scriptPackage: stage1.demoScriptPackage,
      ...(scriptPersistence.scriptPath === undefined
        ? {}
        : { scriptPath: scriptPersistence.scriptPath }),
      ...(stage1.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: stage1.preparationWorkspace }),
      tempRoot: join(input.runDirectory, "capture"),
    });
    latestCaptureManifest = captureManifest;
    await input.log({
      attempt,
      event: "capture-succeeded",
      manifestPath: captureManifest.manifestPath,
      message: `Footage Capture succeeded: ${captureManifest.scenes.length} scene video(s).`,
      runDirectory: captureManifest.runDirectory,
      sceneCount: captureManifest.scenes.length,
    });

    await input.log({
      attempt,
      captureManifestPath: captureManifest.manifestPath,
      event: "compositing-started",
      message: "Compositing started.",
      ...(scriptPersistence.scriptPath === undefined
        ? { generatedScriptDemoRequestId: scriptPersistence.demoRequestId }
        : { scriptPath: scriptPersistence.scriptPath }),
    });
    const finalVideo = await (
      input.options.compositeVideo ?? compositeVideoFromScript
    )({
      captureManifestPath: captureManifest.manifestPath,
      outputRoot: join(input.runDirectory, "composite"),
      runId: `composite-${runSuffix}`,
      scriptDirectory: input.runDirectory,
      scriptPackage: stage1.demoScriptPackage,
      ...(scriptPersistence.scriptPath === undefined
        ? {}
        : { scriptPath: scriptPersistence.scriptPath }),
    });
    latestFinalVideo = finalVideo;
    await input.log({
      attempt,
      event: "compositing-succeeded",
      manifestPath: finalVideo.manifestPath,
      message: "Compositing succeeded.",
      outputVideoPath: finalVideo.outputVideoPath,
      renderPlanPath: finalVideo.renderPlanPath,
      viewUrl: finalVideo.viewUrl,
    });

    const draftEvidence = await readDraftCompositeEvidence({
      captureManifest,
      finalVideo,
      options: input.options,
      scriptPackage: stage1.demoScriptPackage,
    });
    latestFindings = collectDeterministicQualityFindings({
      captureManifest,
      draftEvidence,
      finalVideo,
      scriptPackage: stage1.demoScriptPackage,
    });
    const agentDecision = await reviewer({
      attempt,
      captureManifest,
      derivedEvidence: {
        contactSheetPaths: draftEvidence.contactSheetPaths,
        draftDurationSeconds: finalVideo.durationInFrames / finalVideo.fps,
        ffmpegFindings: draftEvidence.ffmpegFindings,
        markerSummary: captureManifest.scenes.map((scene) => ({
          durationSeconds: scene.durationSeconds,
          sceneId: scene.sceneId,
        })),
        qualityFindings: latestFindings,
        ...(finalVideo.outputVideoPath === undefined
          ? {}
          : { rawDraftCompositePath: finalVideo.outputVideoPath }),
        ...(captureManifest.rawTakePath === undefined
          ? {}
          : { rawTakePath: captureManifest.rawTakePath }),
        sampledFramePaths: draftEvidence.sampledFramePaths,
      },
      draftComposite: finalVideo,
      ...(stage1.opencodeSessionID === undefined
        ? {}
        : { opencodeSessionID: stage1.opencodeSessionID }),
      ...(stage1.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: stage1.preparationWorkspace }),
      scriptPackage: stage1.demoScriptPackage,
    });
    const decision: DraftCompositeReviewDecision =
      latestFindings.length > 0
        ? {
            decision: "repair",
            reason: latestFindings.join("; "),
            repairScope: "demo-script",
          }
        : agentDecision;

    await input.log({
      attempt,
      decision: decision.decision,
      event: "draft-composite-review-completed",
      findingCount: latestFindings.length,
      message: `Draft Composite review ${decision.decision}.`,
      ...(decision.decision === "repair"
        ? { reason: decision.reason, repairScope: decision.repairScope }
        : { reason: decision.reason }),
    });

    if (decision.decision === "accept") {
      return {
        captureManifest,
        finalVideo,
        reviewSummary: {
          attempts: attempt,
          findings: latestFindings,
          status: "accepted",
          warnings: [],
        },
        scriptPersistence,
        stage1,
      };
    }

    latestRepairReason = decision.reason;
    if (attempt > reviewRepairLimit) {
      break;
    }

    if (decision.repairScope === "workspace") {
      const repairedStage1 = await runPipelineJob(
        input.input,
        input.dependencies,
        input.options,
      );
      if (repairedStage1.status !== "succeeded") {
        throw new Error(
          `Workspace repair rerun failed with status ${repairedStage1.status}`,
        );
      }
      stage1 = repairedStage1;
      browserUrl = stage1.capturePathValidation.browserUrl ?? browserUrl;
      scriptPersistence = await persistGeneratedScript({
        demoRequestId: input.options.context?.demoRequestId,
        log: input.log,
        runDirectory: input.runDirectory,
        scriptPackage: stage1.demoScriptPackage,
        scriptStore: input.options.demoRequestScriptStore,
        scriptSummary: summarizeScriptPackage(stage1.demoScriptPackage),
      });
    } else if (input.dependencies.repairCapturePathFailure !== undefined) {
      const repair = await input.dependencies.repairCapturePathFailure({
        attempt,
        failure: {
          blockedNetworkAttempts: [],
          failureReason: `Draft Composite review requested Demo Script repair: ${decision.reason}`,
          logs: [decision.reason],
          status: "failed",
          warnings: [],
        },
        ...(stage1.opencodeSessionID === undefined
          ? {}
          : { opencodeSessionID: stage1.opencodeSessionID }),
        preparationManifest: stage1.preparationManifest,
        ...(stage1.preparationWorkspace === undefined
          ? {}
          : { preparationWorkspace: stage1.preparationWorkspace }),
        repoUrl: input.input.repoUrl,
        demoScriptPackage: stage1.demoScriptPackage,
      });
      const capturePathValidation =
        await input.dependencies.validateCapturePath({
          preparationManifest: repair.preparationManifest,
          ...(stage1.preparationWorkspace === undefined
            ? {}
            : { preparationWorkspace: stage1.preparationWorkspace }),
          demoScriptPackage: repair.demoScriptPackage,
        });
      if (capturePathValidation.status !== "succeeded") {
        throw new Error(
          `Demo Script repair failed Capture Path Validation: ${capturePathValidation.failureReason ?? "unknown failure"}`,
        );
      }
      stage1 = {
        ...stage1,
        capturePathValidation,
        preparationManifest: repair.preparationManifest,
        demoScriptPackage: repair.demoScriptPackage,
      };
      browserUrl = capturePathValidation.browserUrl ?? browserUrl;
      scriptPersistence = await persistGeneratedScript({
        demoRequestId: input.options.context?.demoRequestId,
        log: input.log,
        runDirectory: input.runDirectory,
        scriptPackage: stage1.demoScriptPackage,
        scriptStore: input.options.demoRequestScriptStore,
        scriptSummary: summarizeScriptPackage(stage1.demoScriptPackage),
      });
    }
  }

  if (latestCaptureManifest === undefined || latestFinalVideo === undefined) {
    throw new Error("Draft Composite review did not produce a draft.");
  }

  const warnings = [
    "Draft Composite review retry limit exceeded; using latest draft.",
    ...(latestRepairReason === undefined
      ? []
      : [`Draft Composite review requested repair: ${latestRepairReason}`]),
    ...latestFindings.map((finding) => `Remaining quality gate: ${finding}`),
  ];
  await input.log({
    event: "draft-composite-review-exhausted",
    message: warnings[0] as string,
    warningCount: warnings.length,
    warnings,
  });

  return {
    captureManifest: latestCaptureManifest,
    finalVideo: latestFinalVideo,
    reviewSummary: {
      attempts: reviewRepairLimit + 1,
      findings: latestFindings,
      status: "exhausted",
      warnings,
    },
    scriptPersistence,
    stage1,
  };
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
}): Promise<{ demoRequestId?: string; scriptPath?: string }> {
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
  return `Demo Script generated: ${scriptSummary.sceneCount} scene(s).`;
}

async function defaultDraftReview(): Promise<DraftCompositeReviewDecision> {
  throw new Error(
    "Draft Composite review requires a configured reviewer; production runs should pass the same-session OpenCode reviewer.",
  );
}

function collectDeterministicQualityFindings(input: {
  captureManifest: CaptureManifest;
  draftEvidence: DraftCompositeEvidence;
  finalVideo: CompositedVideoManifest;
  scriptPackage: SucceededStage1["demoScriptPackage"];
}) {
  const findings: string[] = [...input.captureManifest.qualityFindings];
  const maxDraftDurationSeconds = readPositiveNumberEnv(
    "MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS",
    120,
  );
  const maxSceneDurationSeconds = readPositiveNumberEnv(
    "MAKEADEMO_MAX_SCENE_CLIP_SECONDS",
    30,
  );
  const draftDurationSeconds =
    input.finalVideo.durationInFrames / input.finalVideo.fps;

  if (draftDurationSeconds > maxDraftDurationSeconds) {
    findings.push(
      `Draft Composite duration ${draftDurationSeconds.toFixed(2)}s exceeds ${maxDraftDurationSeconds}s`,
    );
  }

  for (const scene of input.captureManifest.scenes) {
    if (scene.durationSeconds > maxSceneDurationSeconds) {
      findings.push(
        `Scene ${scene.sceneId} duration ${scene.durationSeconds.toFixed(2)}s exceeds ${maxSceneDurationSeconds}s`,
      );
    }
  }

  if (
    input.scriptPackage.presentation.music.enabled &&
    input.draftEvidence.audioPresent === false
  ) {
    findings.push("Draft Composite is missing audio while music is enabled");
  }
  if (
    input.scriptPackage.presentation.music.enabled &&
    input.draftEvidence.audioPresent === undefined
  ) {
    findings.push(
      "Draft Composite audio presence could not be verified while music is enabled",
    );
  }

  for (const sceneId of input.draftEvidence.staticSceneIds) {
    findings.push(`Scene ${sceneId} contains fully static footage`);
  }
  for (const sceneId of input.draftEvidence.staticProbeFailedSceneIds ?? []) {
    findings.push(`Scene ${sceneId} static-footage gate could not be verified`);
  }

  return findings;
}

async function readDraftCompositeEvidence(input: {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
  options: FullPipelineRunnerOptions;
  scriptPackage: SucceededStage1["demoScriptPackage"];
}): Promise<DraftCompositeEvidence> {
  const evidence = await input.options.inspectDraftCompositeEvidence?.({
    captureManifest: input.captureManifest,
    draftComposite: input.finalVideo,
    scriptPackage: input.scriptPackage,
  });

  return (
    evidence ??
    (await generateDraftCompositeEvidence({
      captureManifest: input.captureManifest,
      finalVideo: input.finalVideo,
    }))
  );
}

async function generateDraftCompositeEvidence(input: {
  captureManifest: CaptureManifest;
  finalVideo: CompositedVideoManifest;
}): Promise<DraftCompositeEvidence> {
  const { captureManifest, finalVideo } = input;
  if (finalVideo.outputVideoPath === undefined) {
    return {
      audioProbeFailed: true,
      contactSheetPaths: [],
      ffmpegFindings: [
        "Draft Composite video is stored remotely; local sampled-frame evidence was not generated.",
      ],
      sampledFramePaths: [],
      staticProbeFailedSceneIds: captureManifest.scenes.map(
        (scene) => scene.sceneId,
      ),
      staticSceneIds: [],
    };
  }

  if (!(await exists(finalVideo.outputVideoPath))) {
    return {
      audioProbeFailed: true,
      contactSheetPaths: [],
      ffmpegFindings: [
        `Draft Composite video was unavailable for evidence generation: ${finalVideo.outputVideoPath}`,
      ],
      sampledFramePaths: [],
      staticProbeFailedSceneIds: captureManifest.scenes.map(
        (scene) => scene.sceneId,
      ),
      staticSceneIds: [],
    };
  }

  const evidenceDirectory = join(finalVideo.runDirectory, "review-evidence");
  await mkdir(evidenceDirectory, { recursive: true });

  const findings: string[] = [];
  const sampledFramePattern = join(evidenceDirectory, "sample-%03d.jpg");
  const contactSheetPath = join(evidenceDirectory, "contact-sheet.jpg");
  const sampledFrames = await runEvidenceCommand("ffmpeg", [
    "-y",
    "-i",
    finalVideo.outputVideoPath,
    "-vf",
    "fps=1/5",
    "-frames:v",
    "4",
    sampledFramePattern,
  ]);
  if (sampledFrames.exitCode !== 0) {
    findings.push(
      `ffmpeg sampled-frame extraction failed: ${formatCommandOutput(sampledFrames)}`,
    );
  }

  const contactSheet = await runEvidenceCommand("ffmpeg", [
    "-y",
    "-i",
    finalVideo.outputVideoPath,
    "-vf",
    "fps=1/5,scale=320:-1,tile=2x2",
    "-frames:v",
    "1",
    contactSheetPath,
  ]);
  if (contactSheet.exitCode !== 0) {
    findings.push(
      `ffmpeg contact-sheet generation failed: ${formatCommandOutput(contactSheet)}`,
    );
  }

  const audioProbe = await runEvidenceCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    finalVideo.outputVideoPath,
  ]);
  if (audioProbe.exitCode !== 0) {
    findings.push(
      `ffprobe audio probe failed: ${formatCommandOutput(audioProbe)}`,
    );
  }
  const staticFootageProbe = await detectStaticScenes({
    captureManifest,
    findings,
    videoPath: finalVideo.outputVideoPath,
  });

  return {
    ...(audioProbe.exitCode === 0 ? {} : { audioProbeFailed: true }),
    ...(audioProbe.exitCode === 0
      ? { audioPresent: audioProbe.stdout.trim().length > 0 }
      : {}),
    contactSheetPaths: contactSheet.exitCode === 0 ? [contactSheetPath] : [],
    ffmpegFindings: findings,
    sampledFramePaths:
      sampledFrames.exitCode === 0
        ? [1, 2, 3, 4].map((index) =>
            join(
              evidenceDirectory,
              `sample-${String(index).padStart(3, "0")}.jpg`,
            ),
          )
        : [],
    staticProbeFailedSceneIds: staticFootageProbe.failedSceneIds,
    staticSceneIds: staticFootageProbe.staticSceneIds,
  };
}

async function detectStaticScenes(input: {
  captureManifest: CaptureManifest;
  findings: string[];
  videoPath: string;
}) {
  const failedSceneIds: string[] = [];
  const staticSceneIds: string[] = [];
  let sceneStartSeconds = 0;

  for (const scene of input.captureManifest.scenes) {
    const durationSeconds = scene.durationSeconds;
    if (durationSeconds < 1) {
      sceneStartSeconds += durationSeconds;
      continue;
    }

    const freezeDurationSeconds = Math.min(
      2,
      Math.max(0.5, durationSeconds * 0.75),
    );
    const probe = await runEvidenceCommand("ffmpeg", [
      "-v",
      "info",
      "-ss",
      sceneStartSeconds.toFixed(3),
      "-t",
      durationSeconds.toFixed(3),
      "-i",
      input.videoPath,
      "-vf",
      `freezedetect=n=-60dB:d=${freezeDurationSeconds.toFixed(3)}`,
      "-an",
      "-f",
      "null",
      "-",
    ]);

    if (probe.exitCode !== 0) {
      failedSceneIds.push(scene.sceneId);
      input.findings.push(
        `ffmpeg static-footage probe failed for Scene ${scene.sceneId}: ${formatCommandOutput(probe)}`,
      );
    } else if (isStaticSceneProbe(probe.stderr, freezeDurationSeconds)) {
      staticSceneIds.push(scene.sceneId);
    }

    sceneStartSeconds += durationSeconds;
  }

  return { failedSceneIds, staticSceneIds };
}

function isStaticSceneProbe(
  stderr: string,
  minimumFreezeDurationSeconds: number,
) {
  if (
    /freezedetect.*freeze_start/.test(stderr) &&
    !/freezedetect.*freeze_end/.test(stderr)
  ) {
    return true;
  }

  return [...stderr.matchAll(/freeze_duration:\s*([0-9.]+)/g)].some((match) => {
    const durationSeconds = Number(match[1]);
    return (
      Number.isFinite(durationSeconds) &&
      durationSeconds >= minimumFreezeDurationSeconds
    );
  });
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runEvidenceCommand(command: string, args: string[]) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ exitCode: 127, stderr: error.message, stdout });
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function formatCommandOutput(result: { stderr: string; stdout: string }) {
  return [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n");
}

function readDraftCompositeReviewAttemptLimit() {
  const rawValue = process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return 2;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return 2;
  }

  return parsedValue;
}

function readPositiveNumberEnv(name: string, defaultValue: number) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
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

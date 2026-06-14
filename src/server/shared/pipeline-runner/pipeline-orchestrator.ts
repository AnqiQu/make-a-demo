import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type {
  RepoPreparationInput,
  RepoPreparationResult,
} from "../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { ProjectValidationInput } from "../../pipeline/04-project-validation/project-validator";
import type { ProjectValidationResult } from "../../pipeline/04-project-validation/validation-result";
import type { ScriptGenerationInput } from "../../pipeline/05-script-generation/script-generation-orchestrator";
import type { VideoScriptPackage } from "../../pipeline/05-script-generation/video-script-package";
import type { PipelineJobInput, PipelineJobResult } from "./pipeline-job";
import {
  type PipelineObservabilityEvent,
  type PipelineObservationContext,
  type PipelineObserver,
  type PipelineStage,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "./pipeline-observer";

export type PipelineOrchestratorDependencies = {
  generateScriptPackage(
    input: ScriptGenerationInput,
  ): Promise<VideoScriptPackage>;
  prepareRepo(input: RepoPreparationInput): Promise<RepoPreparationResult>;
  screenRepoSecurity(input: RepoSecurityInput): RepoSecurityResult;
  validateProject(
    input: ProjectValidationInput,
  ): Promise<ProjectValidationResult>;
};

type PipelineProgressEvent = {
  stage: PipelineStage;
  status: "failed" | "started" | "succeeded";
};

export type PipelineOrchestratorOptions = {
  context?: Omit<PipelineObservationContext, "workspaceId">;
  now?: () => number;
  observer?: PipelineObserver;
  onProgress?: (event: PipelineProgressEvent) => void;
  onProgress?: (event: PipelineProgressEvent) => Promise<unknown> | unknown;
};

export async function runPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: PipelineOrchestratorOptions = {},
): Promise<PipelineJobResult> {
  const context = {
    ...options.context,
    workspaceId: input.workspaceId,
  };
  const observer = options.observer ?? noopPipelineObserver;
  const now = options.now ?? Date.now;

  const securityStartedAt = reportStageStarted("repo-security-screen", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  });
  let security: RepoSecurityResult;
  try {
    security = dependencies.screenRepoSecurity(input.repoSecurity);
  } catch (error) {
    reportStageFinished("repo-security-screen", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: securityStartedAt,
    });
    throw error;
  }
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "started",
  });
  const security = dependencies.screenRepoSecurity(input.repoSecurity);
  if (security.status === "rejected") {
    reportStageFinished("repo-security-screen", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: securityStartedAt,
      warningCount: security.warnings.length,
    });
    await emitProgress(options, {
      stage: "repo-security-screen",
      status: "failed",
    });
    return { security, status: "security-rejected" };
  }
  reportStageFinished("repo-security-screen", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    startedAt: securityStartedAt,
    warningCount: security.warnings.length,
  });
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "succeeded",
  });

  const preparationStartedAt = reportStageStarted("repo-preparation", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  await emitProgress(options, { stage: "repo-preparation", status: "started" });
  const preparation = await dependencies.prepareRepo({
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    repoUrl: input.repoUrl,
    structuredDemoIntent: input.demoBrief,
    workspaceId: input.workspaceId,
  });
  let preparation: RepoPreparationResult;
  try {
    preparation = await dependencies.prepareRepo({
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      repoUrl: input.repoUrl,
      structuredDemoIntent: input.demoBrief,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    reportStageFinished("repo-preparation", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: preparationStartedAt,
    });
    throw error;
  }

  if (preparation.status === "failed") {
    reportStageFinished("repo-preparation", "failed", {
      context,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: preparationStartedAt,
    });
    await emitProgress(options, {
      stage: "repo-preparation",
      status: "failed",
    });
    return {
      fallbackPrompt: preparation.fallbackPrompt,
      status: "preparation-failed",
    };
  }
  reportStageFinished("repo-preparation", "succeeded", {
    context,
    createdFileCount: preparation.manifest.createdFiles.length,
    diffArtifactId: preparation.manifest.diffArtifactId,
    mockedServiceCount: preparation.manifest.mockedServices.length,
    now,
    observer,
    onProgress: options.onProgress,
    riskCount: preparation.manifest.risks.length,
    startedAt: preparationStartedAt,
  });

  const validationStartedAt = reportStageStarted("project-validation", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  await emitProgress(options, {
    stage: "repo-preparation",
    status: "succeeded",
  });
  let validation: ProjectValidationResult;
  try {
    validation = await dependencies.validateProject({
      preparationManifest: preparation.manifest,
      ...(preparation.workspace === undefined
        ? {}
        : { preparationWorkspace: preparation.workspace }),
    });
  } catch (error) {
    reportStageFinished("project-validation", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: validationStartedAt,
    });
    throw error;
  }

  const validation =
    preparation.validation ??
    (await validatePreparedProject({
      dependencies,
      options,
      preparation,
    }));

  if (validation.status === "failed") {
    reportStageFinished("project-validation", "failed", {
      blockedNetworkAttemptCount: validation.blockedNetworkAttempts.length,
      context,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: validationStartedAt,
      warningCount: validation.warnings.length,
    });
    await emitProgress(options, {
      stage: "project-validation",
      status: "failed",
    });
    return { status: "validation-failed", validation };
  }
  reportStageFinished("project-validation", "succeeded", {
    blockedNetworkAttemptCount: validation.blockedNetworkAttempts.length,
    context,
    now,
    observer,
    onProgress: options.onProgress,
    startedAt: validationStartedAt,
    warningCount: validation.warnings.length,
  });
  if (preparation.validation === undefined) {
    await emitProgress(options, {
      stage: "project-validation",
      status: "succeeded",
    });
  }

  const scriptStartedAt = reportStageStarted("script-generation", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
  await emitProgress(options, {
    stage: "script-generation",
    status: "started",
  });
  const videoScriptPackage = await dependencies.generateScriptPackage({
    demoBrief: input.demoBrief,
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    preparationManifest: preparation.manifest,
    repoUrl: input.repoUrl,
    validation,
  });
  let videoScriptPackage: VideoScriptPackage;
  try {
    videoScriptPackage = await dependencies.generateScriptPackage({
      demoBrief: input.demoBrief,
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      preparationManifest: preparation.manifest,
      repoUrl: input.repoUrl,
      validation,
    });
  } catch (error) {
    reportStageFinished("script-generation", "failed", {
      context,
      error,
      now,
      observer,
      onProgress: options.onProgress,
      startedAt: scriptStartedAt,
    });
    throw error;
  }
  reportStageFinished("script-generation", "succeeded", {
    context,
    now,
    observer,
    onProgress: options.onProgress,
    riskCount: videoScriptPackage.demoPlan.risks.length,
    sceneCount: countScenes(videoScriptPackage),
    startedAt: scriptStartedAt,
  });
  await emitProgress(options, {
    stage: "script-generation",
    status: "succeeded",
  });

  return {
    preparationManifest: preparation.manifest,
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    status: "succeeded",
    validation,
    videoScriptPackage,
  };
}

function reportStageStarted(
  stage: PipelineStage,
  input: {
    context: PipelineObservationContext;
    now: () => number;
    observer: PipelineObserver;
    onProgress: ((event: PipelineProgressEvent) => void) | undefined;
  },
) {
  input.onProgress?.({ stage, status: "started" });
  input.observer.record({
    ...input.context,
    event: "stage.started",
    stage,
    status: "started",
  });

  return input.now();
}

function reportStageFinished(
  stage: PipelineStage,
  status: "failed" | "succeeded",
  input: Omit<PipelineObservabilityEvent, "durationMs" | "event" | "stage"> & {
    context: PipelineObservationContext;
    error?: unknown;
    now: () => number;
    observer: PipelineObserver;
    onProgress: ((event: PipelineProgressEvent) => void) | undefined;
    startedAt: number;
  },
) {
  input.onProgress?.({ stage, status });
  const { context, error, now, observer, onProgress, startedAt, ...fields } =
    input;
  const errorFields =
    error === undefined ? {} : sanitizeObservabilityError(error);

  observer.record({
    ...context,
    ...fields,
    ...errorFields,
    durationMs: now() - startedAt,
    event: status === "succeeded" ? "stage.succeeded" : "stage.failed",
    stage,
    status,
  });
}

function countScenes(videoScriptPackage: VideoScriptPackage) {
  return videoScriptPackage.videoScript.sections.reduce(
    (total, section) => total + section.scenes.length,
    0,
  );
}

async function validatePreparedProject(input: {
  dependencies: PipelineOrchestratorDependencies;
  options: PipelineOrchestratorOptions;
  preparation: Extract<
    Awaited<ReturnType<PipelineOrchestratorDependencies["prepareRepo"]>>,
    { status: "succeeded" }
  >;
}) {
  await emitProgress(input.options, {
    stage: "project-validation",
    status: "started",
  });
  const validation = await input.dependencies.validateProject({
    preparationManifest: input.preparation.manifest,
    ...(input.preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: input.preparation.workspace }),
  });

  return validation;
}

async function emitProgress(
  options: PipelineOrchestratorOptions,
  event: PipelineProgressEvent,
) {
  await options.onProgress?.(event);
}

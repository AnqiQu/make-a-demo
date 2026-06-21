import {
  type SceneDescription,
  parseVideoScriptPackage,
} from "../06-footage-capture/video-script-package.schema";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "./capture-path-validator.interface";
import type { ProjectValidationInput } from "./project-runtime-preflight/project-validator";
import type { ProjectValidationResult } from "./project-runtime-preflight/validation-result";

export type CapturePathSceneValidationInput = {
  baseUrl: string;
  scene: SceneDescription;
  sectionId: string;
};

export type CapturePathSceneValidationResult =
  | {
      logs: string[];
      runDirectory?: string;
      scriptPath?: string;
      status: "succeeded";
      stderrPath?: string;
      stdoutPath?: string;
    }
  | {
      blockedNetworkAttempts?: CapturePathValidationResult["blockedNetworkAttempts"];
      failedAction?: string;
      failureReason: string;
      logs: string[];
      runDirectory?: string;
      screenshotArtifactId?: string;
      scriptPath?: string;
      status: "failed";
      stderrPath?: string;
      stdoutPath?: string;
    };

/**
 * Dry-runs one Scene Description without recording final Scene footage.
 * Implementations must execute generated Browser Actions quickly, report failed
 * actions where possible, and must not apply recording-only cursor or typing effects.
 */
export interface CapturePathSceneValidator {
  validateScene(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult>;
}

export type CapturePathValidationDependencies = {
  sceneValidator: CapturePathSceneValidator;
  validateProject(
    input: ProjectValidationInput,
  ): Promise<ProjectValidationResult>;
};

export async function validateCapturePath(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
): Promise<CapturePathValidationResult> {
  await writeCapturePathSandboxLog(input, {
    event: "capture-path-validation.runtime-preflight.started",
  });
  const projectValidation = await dependencies.validateProject({
    preparationManifest: input.preparationManifest,
    ...(input.preparationWorkspace === undefined
      ? {}
      : { preparationWorkspace: input.preparationWorkspace }),
  });

  if (projectValidation.status === "failed") {
    await writeCapturePathSandboxLog(input, {
      blockedNetworkAttemptCount:
        projectValidation.blockedNetworkAttempts.length,
      event: "capture-path-validation.runtime-preflight.failed",
      failureReason: projectValidation.failureReason,
      warningCount: projectValidation.warnings.length,
    });
    return projectValidation;
  }

  await writeCapturePathSandboxLog(input, {
    blockedNetworkAttemptCount: projectValidation.blockedNetworkAttempts.length,
    browserUrl: projectValidation.browserUrl,
    event: "capture-path-validation.runtime-preflight.succeeded",
    warningCount: projectValidation.warnings.length,
  });

  const scriptPackage = parseVideoScriptPackage(input.videoScriptPackage);
  const logs = [...projectValidation.logs];
  const browserUrl =
    projectValidation.browserUrl ?? input.preparationManifest.url;

  for (const section of scriptPackage.sections) {
    for (const scene of section.scenes) {
      await writeCapturePathSandboxLog(input, {
        event: "capture-path-validation.scene.started",
        sceneId: scene.id,
        sectionId: section.id,
      });
      const sceneResult = await dependencies.sceneValidator.validateScene({
        baseUrl: browserUrl,
        scene,
        sectionId: section.id,
      });
      logs.push(...sceneResult.logs);

      if (sceneResult.status === "failed") {
        await writeCapturePathSandboxLog(input, {
          blockedNetworkAttemptCount:
            sceneResult.blockedNetworkAttempts?.length ?? 0,
          event: "capture-path-validation.scene.failed",
          failedAction: sceneResult.failedAction,
          failureReason: sceneResult.failureReason,
          runDirectory: sceneResult.runDirectory,
          sceneId: scene.id,
          scriptPath: sceneResult.scriptPath,
          stderrPath: sceneResult.stderrPath,
          stdoutPath: sceneResult.stdoutPath,
          screenshotArtifactId: sceneResult.screenshotArtifactId,
          sectionId: section.id,
        });
        return {
          blockedNetworkAttempts: sceneResult.blockedNetworkAttempts ?? [],
          browserUrl,
          failedSceneId: scene.id,
          failureReason: sceneResult.failureReason,
          logs,
          ...(sceneResult.failedAction === undefined
            ? {}
            : { failedAction: sceneResult.failedAction }),
          ...(sceneResult.screenshotArtifactId === undefined
            ? {}
            : { screenshotArtifactId: sceneResult.screenshotArtifactId }),
          ...(sceneResult.runDirectory === undefined
            ? {}
            : { runDirectory: sceneResult.runDirectory }),
          ...(sceneResult.scriptPath === undefined
            ? {}
            : { scriptPath: sceneResult.scriptPath }),
          ...(sceneResult.stderrPath === undefined
            ? {}
            : { stderrPath: sceneResult.stderrPath }),
          ...(sceneResult.stdoutPath === undefined
            ? {}
            : { stdoutPath: sceneResult.stdoutPath }),
          status: "failed",
          warnings: projectValidation.warnings,
        };
      }

      await writeCapturePathSandboxLog(input, {
        event: "capture-path-validation.scene.succeeded",
        runDirectory: sceneResult.runDirectory,
        sceneId: scene.id,
        scriptPath: sceneResult.scriptPath,
        stderrPath: sceneResult.stderrPath,
        stdoutPath: sceneResult.stdoutPath,
        sectionId: section.id,
      });
    }
  }

  return {
    blockedNetworkAttempts: [],
    browserUrl,
    logs,
    ...(projectValidation.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: projectValidation.screenshotArtifactId }),
    status: "succeeded",
    warnings: projectValidation.warnings,
  };
}

async function writeCapturePathSandboxLog(
  input: CapturePathValidationInput,
  entry: Record<string, unknown>,
) {
  await input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...removeUndefinedValues(entry),
    repoUrl: input.preparationManifest.repoUrl,
    scriptId: input.videoScriptPackage.scriptId,
    stage: "capture-path-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
}

function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

import type { ProjectValidationInput } from "../04-project-validation/project-validator";
import type { ProjectValidationResult } from "../04-project-validation/validation-result";
import {
  type SceneDescription,
  parseVideoScriptPackage,
} from "../06-capture/video-script-package.schema";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "./capture-path-validator.interface";

export type CapturePathSceneValidationInput = {
  baseUrl: string;
  scene: SceneDescription;
  sectionId: string;
};

export type CapturePathSceneValidationResult =
  | {
      logs: string[];
      status: "succeeded";
    }
  | {
      blockedNetworkAttempts?: CapturePathValidationResult["blockedNetworkAttempts"];
      failedAction?: string;
      failureReason: string;
      logs: string[];
      screenshotArtifactId?: string;
      status: "failed";
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
  const projectValidation = await dependencies.validateProject({
    preparationManifest: input.preparationManifest,
    ...(input.preparationWorkspace === undefined
      ? {}
      : { preparationWorkspace: input.preparationWorkspace }),
  });

  if (projectValidation.status === "failed") {
    return projectValidation;
  }

  const scriptPackage = parseVideoScriptPackage(input.videoScriptPackage);
  const logs = [...projectValidation.logs];
  const browserUrl =
    projectValidation.browserUrl ?? input.preparationManifest.url;

  for (const section of scriptPackage.sections) {
    for (const scene of section.scenes) {
      const sceneResult = await dependencies.sceneValidator.validateScene({
        baseUrl: browserUrl,
        scene,
        sectionId: section.id,
      });
      logs.push(...sceneResult.logs);

      if (sceneResult.status === "failed") {
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
          status: "failed",
          warnings: projectValidation.warnings,
        };
      }
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

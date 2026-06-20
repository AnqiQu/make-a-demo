import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { NetworkAttempt } from "../04-project-validation/network-isolation-policy";
import type { VideoScriptPackage } from "../05-script-generation/video-script-package";

export type CapturePathValidationInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  videoScriptPackage: VideoScriptPackage;
};

export type CapturePathValidationResult = {
  blockedNetworkAttempts: NetworkAttempt[];
  browserUrl?: string;
  failedAction?: string;
  failedSceneId?: string;
  failureReason?: string;
  logs: string[];
  runDirectory?: string;
  screenshotArtifactId?: string;
  scriptPath?: string;
  status: "failed" | "succeeded";
  stderrPath?: string;
  stdoutPath?: string;
  warnings: string[];
};

/**
 * Validates that a Video Script Package's generated capture path can run against
 * the prepared app under Runtime Network Lockdown. Implementations must run
 * project-level checks before generated Browser Actions, produce structured
 * failure evidence, and must not produce final Scene footage.
 */
export interface CapturePathValidator {
  validate(
    input: CapturePathValidationInput,
  ): Promise<CapturePathValidationResult>;
}

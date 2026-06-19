import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { VideoScriptPackage } from "../05-script-generation/video-script-package";
import type { CapturePathValidationResult } from "./capture-path-validator.interface";

type CapturePathRepairInput = {
  attempt: number;
  failure: CapturePathValidationResult;
  opencodeSessionID?: string;
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  repoUrl: string;
  videoScriptPackage: VideoScriptPackage;
};

type CapturePathRepairResult = {
  preparationManifest: PreparationManifest;
  videoScriptPackage: VideoScriptPackage;
};

/**
 * Repairs a prepared workspace, Video Script Package, or both after Capture Path
 * Validation fails. Implementations may use the existing agent session, but the
 * returned artifacts remain untrusted until full Capture Path Validation reruns.
 */
export interface CapturePathRepairer {
  repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult>;
}

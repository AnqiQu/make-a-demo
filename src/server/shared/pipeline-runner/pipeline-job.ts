import type { DemoBrief } from "../../pipeline/01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { PreparationManifest } from "../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { VideoScriptPackage } from "../../pipeline/04-script-generation/video-script-package";
import type { CapturePathValidationResult } from "../../pipeline/05-capture-path-validation/capture-path-validator.interface";

export type PipelineJobInput = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoSecurity: RepoSecurityInput;
  repoUrl: string;
  workspaceId: string;
};

export type PipelineJobResult =
  | {
      security: RepoSecurityResult;
      status: "security-rejected";
    }
  | {
      fallbackPrompt: string;
      status: "preparation-failed";
    }
  | {
      capturePathValidation: CapturePathValidationResult;
      status: "capture-path-validation-failed";
    }
  | {
      preparationManifest: PreparationManifest;
      opencodeSessionID?: string;
      preparationWorkspace?: PreparationWorkspaceHandle;
      capturePathValidation: CapturePathValidationResult;
      status: "succeeded";
      videoScriptPackage: VideoScriptPackage;
    };

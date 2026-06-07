import type { DemoBrief } from "../../pipeline/01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { PreparationManifest } from "../../pipeline/03-repo-preparation/preparation-manifest";
import type { ProjectValidationResult } from "../../pipeline/04-project-validation/validation-result";
import type { VideoScriptPackage } from "../../pipeline/05-script-generation/video-script-package";

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
      status: "validation-failed";
      validation: ProjectValidationResult;
    }
  | {
      preparationManifest: PreparationManifest;
      status: "succeeded";
      videoScriptPackage: VideoScriptPackage;
    };

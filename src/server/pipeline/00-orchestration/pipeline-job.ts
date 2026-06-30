import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../02-repo-security-screen/repo-security-screen";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScriptPackage } from "../04-script-generation/demo-script-package";
import type { ProjectValidationResult } from "../05-capture-path-validation/project-runtime-preflight/validation-result";

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
      opencodeSessionID?: string;
      preparationWorkspace?: PreparationWorkspaceHandle;
      status: "succeeded";
      validation: ProjectValidationResult;
      videoScriptPackage: DemoScriptPackage;
    };

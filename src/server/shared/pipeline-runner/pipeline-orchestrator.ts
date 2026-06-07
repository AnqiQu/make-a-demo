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

export async function runPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
): Promise<PipelineJobResult> {
  const security = dependencies.screenRepoSecurity(input.repoSecurity);
  if (security.status === "rejected") {
    return { security, status: "security-rejected" };
  }

  const preparation = await dependencies.prepareRepo({
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    repoUrl: input.repoUrl,
    structuredDemoIntent: input.demoBrief,
    workspaceId: input.workspaceId,
  });

  if (preparation.status === "failed") {
    return {
      fallbackPrompt: preparation.fallbackPrompt,
      status: "preparation-failed",
    };
  }

  const validation = await dependencies.validateProject({
    preparationManifest: preparation.manifest,
  });

  if (validation.status === "failed") {
    return { status: "validation-failed", validation };
  }

  const videoScriptPackage = await dependencies.generateScriptPackage({
    demoBrief: input.demoBrief,
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    preparationManifest: preparation.manifest,
    repoUrl: input.repoUrl,
    validation,
  });

  return {
    preparationManifest: preparation.manifest,
    status: "succeeded",
    videoScriptPackage,
  };
}

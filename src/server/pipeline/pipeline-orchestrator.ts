import type { ProjectValidationResult } from "../project-validation/validation-result";
import type { ScriptGenerationInput } from "../script-generation/script-generation-orchestrator";
import type { VideoScriptPackage } from "../script-generation/video-script-package";
import type { PipelineJobInput, PipelineJobResult } from "./pipeline-job";

export type PipelineOrchestratorDependencies = {
  generateScriptPackage(
    input: ScriptGenerationInput,
  ): Promise<VideoScriptPackage>;
  validateProject(input: PipelineJobInput): Promise<ProjectValidationResult>;
};

export async function runPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
): Promise<PipelineJobResult> {
  const validation = await dependencies.validateProject(input);

  if (validation.status === "failed") {
    return { status: "failed", validation };
  }

  const videoScriptPackage = await dependencies.generateScriptPackage({
    demoBrief: input.demoBrief,
    repoUrl: input.repoUrl,
    validation,
  });

  return { status: "succeeded", videoScriptPackage };
}

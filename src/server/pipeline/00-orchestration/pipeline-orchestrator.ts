import type {
  RepoSecurityInput,
  RepoSecurityResult,
} from "../02-repo-security-screen/repo-security-screen";
import type {
  RepoPreparationInput,
  RepoPreparationResult,
} from "../03-repo-preparation/repo-preparation-agent.interface";
import type { DemoScriptPackage } from "../04-script-generation/demo-script-package";
import type { ScriptGenerationInput } from "../04-script-generation/script-generation-orchestrator";
import type { ProjectValidationInput } from "../05-capture-path-validation/project-runtime-preflight/project-validator";
import type { ProjectValidationResult } from "../05-capture-path-validation/project-runtime-preflight/validation-result";
import type { PipelineJobInput, PipelineJobResult } from "./pipeline-job";

export type PipelineOrchestratorDependencies = {
  generateScriptPackage(
    input: PipelineScriptGenerationInput,
  ): Promise<DemoScriptPackage>;
  prepareRepo(input: RepoPreparationInput): Promise<RepoPreparationResult>;
  screenRepoSecurity(input: RepoSecurityInput): RepoSecurityResult;
  validateProject(
    input: ProjectValidationInput,
  ): Promise<ProjectValidationResult>;
};

type PipelineStage =
  | "project-validation"
  | "repo-preparation"
  | "repo-security-screen"
  | "script-generation";

type PipelineProgressEvent = {
  stage: PipelineStage;
  status: "failed" | "started" | "succeeded";
};

type PipelineScriptGenerationInput = ScriptGenerationInput & {
  validation: ProjectValidationResult;
};

export type ScriptGenerationReadyEvent = PipelineScriptGenerationInput;

export type PipelineOrchestratorOptions = {
  onScriptGenerationReady?: (
    event: ScriptGenerationReadyEvent,
  ) => Promise<unknown> | unknown;
  onProgress?: (event: PipelineProgressEvent) => Promise<unknown> | unknown;
};

export async function runPipelineJob(
  input: PipelineJobInput,
  dependencies: PipelineOrchestratorDependencies,
  options: PipelineOrchestratorOptions = {},
): Promise<PipelineJobResult> {
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "started",
  });
  const security = dependencies.screenRepoSecurity(input.repoSecurity);
  if (security.status === "rejected") {
    await emitProgress(options, {
      stage: "repo-security-screen",
      status: "failed",
    });
    return { security, status: "security-rejected" };
  }
  await emitProgress(options, {
    stage: "repo-security-screen",
    status: "succeeded",
  });

  await emitProgress(options, { stage: "repo-preparation", status: "started" });
  const preparation = await dependencies.prepareRepo({
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    repoUrl: input.repoUrl,
    structuredDemoIntent: input.demoBrief,
    workspaceId: input.workspaceId,
  });

  if (preparation.status === "failed") {
    await emitProgress(options, {
      stage: "repo-preparation",
      status: "failed",
    });
    return {
      fallbackPrompt: preparation.fallbackPrompt,
      status: "preparation-failed",
    };
  }
  await emitProgress(options, {
    stage: "repo-preparation",
    status: "succeeded",
  });

  const validation =
    preparation.validation ??
    (await validatePreparedProject({
      dependencies,
      options,
      preparation,
    }));

  if (validation.status === "failed") {
    await emitProgress(options, {
      stage: "project-validation",
      status: "failed",
    });
    return { status: "validation-failed", validation };
  }
  if (preparation.validation === undefined) {
    await emitProgress(options, {
      stage: "project-validation",
      status: "succeeded",
    });
  }

  const scriptGenerationInput = {
    demoBrief: input.demoBrief,
    normalizedSupportingDocuments: input.normalizedSupportingDocuments,
    ...(preparation.opencodeSessionID === undefined
      ? {}
      : { opencodeSessionID: preparation.opencodeSessionID }),
    preparationManifest: preparation.manifest,
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    repoUrl: input.repoUrl,
    validation,
  };

  await options.onScriptGenerationReady?.(scriptGenerationInput);
  await emitProgress(options, {
    stage: "script-generation",
    status: "started",
  });
  const videoScriptPackage = await dependencies.generateScriptPackage(
    scriptGenerationInput,
  );
  await emitProgress(options, {
    stage: "script-generation",
    status: "succeeded",
  });

  return {
    preparationManifest: preparation.manifest,
    ...(preparation.opencodeSessionID === undefined
      ? {}
      : { opencodeSessionID: preparation.opencodeSessionID }),
    ...(preparation.workspace === undefined
      ? {}
      : { preparationWorkspace: preparation.workspace }),
    status: "succeeded",
    validation,
    videoScriptPackage,
  };
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

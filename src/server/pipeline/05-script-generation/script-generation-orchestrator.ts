import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { ProjectValidationResult } from "../04-project-validation/validation-result";
import type { DemoPlanner } from "./demo-planning/demo-planner.interface";
import type { ProjectExplorer } from "./project-exploration/project-explorer.interface";
import type { ScriptComposer } from "./script-composition/script-composer.interface";
import type { ScriptGenerationAgent } from "./script-generation-agent.interface";
import {
  type VideoScriptPackage,
  buildVideoScriptPackage,
} from "./video-script-package";

export type ScriptGenerationInput = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  opencodeSessionID?: string;
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
  repoUrl: string;
  validation: ProjectValidationResult;
};

export type ScriptGenerationDependencies = {
  demoPlanner: DemoPlanner;
  projectExplorer: ProjectExplorer;
  scriptGenerationAgent?: ScriptGenerationAgent;
  scriptComposer: ScriptComposer;
};

export async function generateVideoScriptPackage(
  input: ScriptGenerationInput,
  dependencies: ScriptGenerationDependencies,
): Promise<VideoScriptPackage> {
  if (dependencies.scriptGenerationAgent !== undefined) {
    if (
      input.preparationWorkspace === undefined ||
      input.opencodeSessionID === undefined
    ) {
      throw new Error(
        "Agentic Script Generation requires the validated preparation workspace and OpenCode session ID.",
      );
    }

    return dependencies.scriptGenerationAgent.generateScriptPackage({
      ...input,
      opencodeSessionID: input.opencodeSessionID,
      preparationWorkspace: input.preparationWorkspace,
    });
  }

  const exploration = await dependencies.projectExplorer.exploreProject(input);
  const demoPlan = await dependencies.demoPlanner.planDemo({
    demoBrief: input.demoBrief,
    exploration,
  });
  const videoScript = await dependencies.scriptComposer.composeScript({
    demoBrief: input.demoBrief,
    demoPlan,
    exploration,
  });

  return buildVideoScriptPackage({
    demoPlan,
    exploration,
    validation: input.validation,
    videoScript,
  });
}

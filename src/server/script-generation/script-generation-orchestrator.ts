import type { DemoBrief } from "../context-gathering/intake/demo-brief.schema";
import type { ProjectValidationResult } from "../project-validation/validation-result";
import type { DemoPlanner } from "./demo-planning/demo-planner.interface";
import type { ProjectExplorer } from "./project-exploration/project-explorer.interface";
import type { ScriptComposer } from "./script-composition/script-composer.interface";
import {
  type VideoScriptPackage,
  buildVideoScriptPackage,
} from "./video-script-package";

export type ScriptGenerationInput = {
  demoBrief: DemoBrief;
  repoUrl: string;
  validation: ProjectValidationResult;
};

export type ScriptGenerationDependencies = {
  demoPlanner: DemoPlanner;
  projectExplorer: ProjectExplorer;
  scriptComposer: ScriptComposer;
};

export async function generateVideoScriptPackage(
  input: ScriptGenerationInput,
  dependencies: ScriptGenerationDependencies,
): Promise<VideoScriptPackage> {
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

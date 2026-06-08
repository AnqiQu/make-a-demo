import type { ProjectValidationResult } from "../04-project-validation/validation-result";
import type { DemoPlan } from "./demo-planning/demo-plan";
import type { ProjectExplorationResult } from "./project-exploration/project-exploration-result";
import type { VideoScript } from "./script-composition/video-script";

export type VideoScriptPackage = {
  assumptions: string[];
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
  validation: ProjectValidationResult;
  videoScript: VideoScript;
};

export function buildVideoScriptPackage(input: {
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
  validation: ProjectValidationResult;
  videoScript: VideoScript;
}): VideoScriptPackage {
  return {
    assumptions: input.exploration.assumptions,
    demoPlan: input.demoPlan,
    exploration: input.exploration,
    validation: input.validation,
    videoScript: input.videoScript,
  };
}

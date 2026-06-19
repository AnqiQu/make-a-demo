import type { CaptureReadyVideoScriptPackage } from "../06-capture/video-script-package.schema";
import type { DemoPlan } from "./demo-planning/demo-plan";
import type { ProjectExplorationResult } from "./project-exploration/project-exploration-result";
import type { VideoScript } from "./script-composition/video-script";

export type VideoScriptPackage = CaptureReadyVideoScriptPackage & {
  assumptions: string[];
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
};

export function buildVideoScriptPackage(input: {
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
  videoScript: VideoScript;
}): VideoScriptPackage {
  return {
    ...input.videoScript,
    assumptions: input.exploration.assumptions,
    demoPlan: input.demoPlan,
    exploration: input.exploration,
  };
}

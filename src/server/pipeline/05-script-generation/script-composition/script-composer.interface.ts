import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { DemoPlan } from "../demo-planning/demo-plan";
import type { ProjectExplorationResult } from "../project-exploration/project-exploration-result";
import type { VideoScript } from "./video-script";

type ScriptCompositionInput = {
  demoBrief: DemoBrief;
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
};

/**
 * Composes the read-only Video Script from the ordered demo plan.
 * Implementations must return Script Sections containing Scene Descriptions with
 * user-readable Browser Actions for the downstream handoff package.
 */
export interface ScriptComposer {
  composeScript(input: ScriptCompositionInput): Promise<VideoScript>;
}

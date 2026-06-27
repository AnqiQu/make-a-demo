import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { DemoPlan } from "../demo-planning/demo-plan";
import type { ProjectExplorationResult } from "../project-exploration/project-exploration-result";
import type { ComposedDemoScript } from "./composed-demo-script";

type ScriptCompositionInput = {
  demoBrief: DemoBrief;
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
};

/**
 * Composes the read-only Demo Script from the ordered demo plan.
 * Implementations must return declared Scenes and SDK-based Browser Actions for
 * the downstream handoff package.
 */
export interface ScriptComposer {
  composeScript(input: ScriptCompositionInput): Promise<ComposedDemoScript>;
}

import type { DemoBrief } from "../../context-gathering/intake/demo-brief.schema";
import type { ProjectExplorationResult } from "../project-exploration/project-exploration-result";
import type { DemoPlan } from "./demo-plan";

type DemoPlanningInput = {
  demoBrief: DemoBrief;
  exploration: ProjectExplorationResult;
};

/**
 * Turns explored project context and maker intent into an ordered demo plan.
 * Implementations should preserve user-requested key features while surfacing
 * capture risks instead of silently dropping uncertain flows.
 */
export interface DemoPlanner {
  planDemo(input: DemoPlanningInput): Promise<DemoPlan>;
}

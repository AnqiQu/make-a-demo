import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { ProjectValidationResult } from "../../02-project-validation/validation-result";
import type { ProjectExplorationResult } from "./project-exploration-result";

export type ProjectExplorationInput = {
  demoBrief: DemoBrief;
  repoUrl: string;
  validation: ProjectValidationResult;
};

/**
 * Explores a validated project and summarizes product surfaces for demo planning.
 * Implementations must not mutate the submitted repo and should report assumptions
 * when repo or supporting-document evidence is incomplete.
 */
export interface ProjectExplorer {
  exploreProject(
    input: ProjectExplorationInput,
  ): Promise<ProjectExplorationResult>;
}

import type { DemoBrief } from "../../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { ProjectExplorationResult } from "./project-exploration-result";

export type ProjectExplorationInput = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  preparationManifest: PreparationManifest;
  repoUrl: string;
};

/**
 * Explores a prepared project and summarizes product surfaces for demo planning.
 * Implementations must not mutate the submitted repo and should report assumptions
 * when repo or supporting-document evidence is incomplete.
 */
export interface ProjectExplorer {
  exploreProject(
    input: ProjectExplorationInput,
  ): Promise<ProjectExplorationResult>;
}

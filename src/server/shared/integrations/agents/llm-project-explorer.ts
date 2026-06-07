import type { ProjectExplorationResult } from "../../../pipeline/05-script-generation/project-exploration/project-exploration-result";
import type {
  ProjectExplorationInput,
  ProjectExplorer,
} from "../../../pipeline/05-script-generation/project-exploration/project-explorer.interface";

export class LlmProjectExplorer implements ProjectExplorer {
  async exploreProject(
    input: ProjectExplorationInput,
  ): Promise<ProjectExplorationResult> {
    const supportingContext = input.normalizedSupportingDocuments
      .map((document) => document.normalizedText)
      .join(" ")
      .trim();
    const productSurfaces = unique([
      ...input.demoBrief.keyProductFeatures,
      ...input.preparationManifest.existingDemoEvidence,
    ]);

    return {
      assumptions: input.preparationManifest.assumptions,
      productSurfaces,
      summary: supportingContext
        ? `${input.preparationManifest.setupSummary} Supporting context: ${supportingContext}`
        : input.preparationManifest.setupSummary,
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

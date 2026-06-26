import type { ProjectExplorationResult } from "./project-exploration-result";
import type {
  ProjectExplorationInput,
  ProjectExplorer,
} from "./project-explorer.interface";

export class PreparationManifestProjectExplorer implements ProjectExplorer {
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
      ...input.preparationManifest.scriptGenerationContext,
    ]);
    const scriptContext = input.preparationManifest.scriptGenerationContext
      .join(". ")
      .trim();
    const summaryParts = [
      input.preparationManifest.setupSummary,
      scriptContext.length === 0
        ? ""
        : `Script generation context: ${scriptContext}.`,
      supportingContext.length === 0
        ? ""
        : `Supporting context: ${supportingContext}`,
    ].filter((part) => part.length > 0);

    return {
      assumptions: input.preparationManifest.assumptions,
      productSurfaces,
      summary: summaryParts.join(" "),
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

import type { PreparationManifest, RunPlan } from "./artifacts";

/**
 * Produces the complete canonical shape Repo Preparation agents should copy
 * and enrich. The returned value must always satisfy PreparationManifest so a
 * model never has to infer field types from prose.
 */
export function createPreparationManifestTemplate(
  runPlan: RunPlan,
  demoBrief: { keyProductFeatures?: string[] } = {},
): PreparationManifest {
  const requestedFeatures = demoBrief.keyProductFeatures ?? [];
  return {
    appDir: runPlan.appDir,
    appExplorationHints: [],
    baseUrl: runPlan.expectedLocalUrl,
    blockedExternalServicesReplaced: [],
    ...(runPlan.buildCommand === undefined
      ? {}
      : { buildCommandUsed: runPlan.buildCommand }),
    cleanupAndReproInstructions: [],
    envUsed: runPlan.env,
    id: "replace-with-preparation-id",
    installCommandUsed: runPlan.installCommand,
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    ports: runPlan.allowedPorts,
    requiredLocalOnlyAssumptions: [],
    productContext: {
      evidencePaths: [],
      featureInventory: requestedFeatures.map((feature, index) => ({
        authStrategy: "none",
        description: `Prepare a deterministic demo for ${feature}`,
        entryPaths: [],
        fixtureNotes: [],
        id: `requested-feature-${index + 1}`,
        label: feature,
        requestedFeature: feature,
        sourcePaths: [],
      })),
      name: "replace-with-product-name",
      summary: "replace-with-product-summary",
    },
    scriptGenerationContext: [],
    startCommandUsed: runPlan.startCommand,
  };
}

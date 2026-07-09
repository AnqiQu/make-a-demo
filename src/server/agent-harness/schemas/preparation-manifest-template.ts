import type { PreparationManifest, RunPlan } from "./artifacts";

/**
 * Produces the complete canonical shape Repo Preparation agents should copy
 * and enrich. The returned value must always satisfy PreparationManifest so a
 * model never has to infer field types from prose.
 */
export function createPreparationManifestTemplate(
  runPlan: RunPlan,
): PreparationManifest {
  return {
    appDir: runPlan.appDir,
    appExplorationHints: [],
    baseUrl: runPlan.expectedLocalUrl,
    blockedExternalServicesReplaced: [],
    ...(runPlan.buildCommand === undefined
      ? {}
      : { buildCommandUsed: runPlan.buildCommand }),
    cleanupAndReproInstructions: [],
    createdFiles: [],
    envUsed: runPlan.env,
    id: "replace-with-preparation-id",
    installCommandUsed: runPlan.installCommand,
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    modifiedFiles: [],
    ports: runPlan.allowedPorts,
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: runPlan.startCommand,
    validationEvidence: [],
  };
}

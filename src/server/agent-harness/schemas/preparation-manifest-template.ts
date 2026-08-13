import { provisionableServices } from "../sandbox-services/sandbox-services";
import type {
  PreparationManifest,
  RequiredService,
  RunPlan,
} from "./artifacts";

/**
 * Produces the complete canonical shape Repo Preparation agents should copy
 * and enrich. The returned value must always satisfy PreparationManifest so a
 * model never has to infer field types from prose. When the repo profile
 * detected required data services (N122), the template pre-fills one
 * dataStrategy entry per service in ladder preference order — embedded-config
 * exactly when detection proved an embedded driver exists, provisioned-service
 * when the sandbox can boot the real service (N122(5)), else client-stub —
 * with a template detail the enforcement validator refuses until replaced.
 */
export function createPreparationManifestTemplate(
  runPlan: RunPlan,
  demoBrief: { keyProductFeatures?: string[] } = {},
  repoProfile: { servicesRequired?: RequiredService[] } = {},
): PreparationManifest {
  const requestedFeatures = demoBrief.keyProductFeatures ?? [];
  const servicesRequired = repoProfile.servicesRequired ?? [];
  return {
    appDir: runPlan.appDir,
    appExplorationHints: [],
    baseUrl: runPlan.expectedLocalUrl,
    blockedExternalServicesReplaced: [],
    ...(servicesRequired.length === 0
      ? {}
      : {
          dataStrategy: servicesRequired.map((service) => ({
            detail: `replace-with-how-${service.service}-is-served-for-the-demo`,
            rung:
              (service.embeddedAlternativeEvidencePaths?.length ?? 0) > 0
                ? ("embedded-config" as const)
                : (provisionableServices as readonly string[]).includes(
                      service.service,
                    )
                  ? ("provisioned-service" as const)
                  : ("client-stub" as const),
            service: service.service,
          })),
        }),
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
        // Data-backed features fill this with their in-code fixture wiring
        // (N100); static surfaces leave it empty.
        dataSeams: [],
        description: `Prepare a deterministic demo for ${feature}`,
        entryPaths: [],
        // N107: replace with the typed outcome that proves this feature on
        // its entry route — visible-text, element-appears, or
        // state-transition {locator, from, to} in accessible-name space.
        expectedProof: {
          kind: "visible-text",
          text: `replace-with-on-screen-text-proving ${feature}`,
        },
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

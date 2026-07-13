import type { PreparationManifest } from "./artifacts";

const stringArray = {
  items: { type: "string" },
  type: "array",
} as const;

const requiredFields = [
  "appDir",
  "appExplorationHints",
  "baseUrl",
  "blockedExternalServicesReplaced",
  "cleanupAndReproInstructions",
  "createdFiles",
  "envUsed",
  "id",
  "installCommandUsed",
  "knownLimitations",
  "localDemoModeChanges",
  "mocksAndFixturesAdded",
  "modifiedFiles",
  "ports",
  "productContext",
  "requiredLocalOnlyAssumptions",
  "scriptGenerationContext",
  "startCommandUsed",
  "validationEvidence",
] as const satisfies readonly (keyof PreparationManifest)[];

/**
 * Returns the backend-owned contract Repo Preparation must satisfy when
 * writing its durable manifest. Implementations must preserve every required
 * field and fully describe each feature inventory entry in one pass.
 */
export function createPreparationManifestContract() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    contractVersion: "2026-07-12",
    invariants: [
      "all paths must reference the screened repository and must not be absolute",
      "every maker-requested feature must appear exactly once and preserve its exact text in requestedFeature",
      "when no features were requested, featureInventory must contain at least three source-backed browser-demonstrable candidates when the product supports them",
      "every feature entry must include every required field, including empty array fields",
      "authStrategy must be exactly bypass, demo-identity, or none",
      "feature ids must be stable safe identifiers and unique within featureInventory",
    ],
    outputPath: "/workspace/.makeademo/preparation-manifest.json",
    properties: {
      appDir: { minLength: 1, type: "string" },
      appExplorationHints: stringArray,
      authBypassOrDemoIdentity: { type: "string" },
      baseUrl: { minLength: 1, type: "string" },
      blockedExternalServicesReplaced: stringArray,
      buildCommandUsed: { type: "string" },
      cleanupAndReproInstructions: stringArray,
      createdFiles: stringArray,
      envUsed: {
        additionalProperties: { type: "string" },
        type: "object",
      },
      id: { minLength: 1, type: "string" },
      installCommandUsed: { minLength: 1, type: "string" },
      knownLimitations: stringArray,
      localDemoModeChanges: stringArray,
      mocksAndFixturesAdded: stringArray,
      modifiedFiles: stringArray,
      ports: {
        items: { maximum: 65_535, minimum: 1, type: "integer" },
        type: "array",
      },
      productContext: {
        additionalProperties: false,
        properties: {
          evidencePaths: stringArray,
          featureInventory: {
            items: {
              additionalProperties: false,
              properties: {
                authStrategy: {
                  enum: ["bypass", "demo-identity", "none"],
                  type: "string",
                },
                description: { minLength: 1, type: "string" },
                entryPaths: stringArray,
                fixtureNotes: stringArray,
                id: {
                  minLength: 1,
                  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
                  type: "string",
                },
                label: { minLength: 1, type: "string" },
                requestedFeature: { minLength: 1, type: "string" },
                sourcePaths: stringArray,
              },
              required: [
                "authStrategy",
                "description",
                "entryPaths",
                "fixtureNotes",
                "id",
                "label",
                "sourcePaths",
              ],
              type: "object",
            },
            type: "array",
          },
          name: { minLength: 1, type: "string" },
          summary: { minLength: 1, type: "string" },
        },
        required: ["evidencePaths", "featureInventory", "name", "summary"],
        type: "object",
      },
      requiredLocalOnlyAssumptions: stringArray,
      scriptGenerationContext: stringArray,
      startCommandUsed: { minLength: 1, type: "string" },
      validationEvidence: stringArray,
    } satisfies Record<keyof PreparationManifest, unknown>,
    required: requiredFields,
    type: "object",
  } as const;
}

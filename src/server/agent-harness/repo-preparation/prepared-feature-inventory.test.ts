import { describe, expect, it } from "vitest";
import type { PreparationManifest } from "../schemas/artifacts";
import { assertPreparedFeatureInventory } from "./prepared-feature-inventory";

describe("assertPreparedFeatureInventory", () => {
  it("rejects a prepared runtime that omits a requested demo feature", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: {
          keyProductFeatures: ["creating an account", "posting an article"],
        },
        preparationManifest: manifestWithFeatures([
          {
            id: "create-account",
            label: "Creating an account",
            requestedFeature: "creating an account",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(
      "PreparationManifest must prepare every requested demo feature exactly once. Missing: posting an article.",
    );
  });
});

function manifestWithFeatures(
  features: Array<{ id: string; label: string; requestedFeature?: string }>,
): PreparationManifest {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    createdFiles: [],
    envUsed: {},
    id: "prepared",
    installCommandUsed: "npm ci",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    modifiedFiles: [],
    ports: [3000],
    productContext: {
      evidencePaths: ["README.md"],
      featureInventory: features.map((feature) => ({
        authStrategy: "none",
        description: `Demonstrate ${feature.label}`,
        entryPaths: ["/"],
        fixtureNotes: [],
        ...feature,
        sourcePaths: ["src/routes.tsx"],
      })),
      name: "Conduit",
      summary: "A publishing platform.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "npm start",
    validationEvidence: [],
  };
}

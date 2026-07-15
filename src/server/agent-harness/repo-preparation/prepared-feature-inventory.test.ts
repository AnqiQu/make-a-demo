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

  it("requires every prepared feature to cite original product UI source", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["posting an article"] },
        preparationManifest: manifestWithFeatures([
          {
            id: "post-article",
            label: "Posting an article",
            requestedFeature: "posting an article",
            sourcePaths: ["README.md"],
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(
      "productContext.featureInventory[0].sourcePaths must cite an original route, page, component, or browser UI module",
    );
  });

  it("accepts an original browser entry module as UI source", () => {
    const preparationManifest = manifestWithFeatures([
      {
        id: "post-article",
        label: "Posting an article",
        requestedFeature: "posting an article",
        sourcePaths: ["src/main.ts"],
      },
    ]);

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["posting an article"] },
        preparationManifest,
        repoSourcePaths: new Set(["README.md", "src/main.ts"]),
      }),
    ).not.toThrow();
  });
});

function manifestWithFeatures(
  features: Array<{
    id: string;
    label: string;
    requestedFeature?: string;
    sourcePaths?: string[];
  }>,
): PreparationManifest {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    envUsed: {},
    id: "prepared",
    installCommandUsed: "npm ci",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    ports: [3000],
    productContext: {
      evidencePaths: ["README.md"],
      featureInventory: features.map((feature) => ({
        authStrategy: "none",
        description: `Demonstrate ${feature.label}`,
        entryPaths: ["/"],
        fixtureNotes: [],
        sourcePaths: ["src/routes.tsx"],
        ...feature,
      })),
      name: "Conduit",
      summary: "A publishing platform.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "npm start",
  };
}

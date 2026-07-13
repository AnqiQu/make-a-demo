import { describe, expect, it } from "vitest";
import { readPreparationManifest } from "./artifacts";
import { createPreparationManifestTemplate } from "./preparation-manifest-template";

describe("Preparation Manifest template", () => {
  it("is a complete machine-readable manifest that satisfies the runtime contract", () => {
    const template = createPreparationManifestTemplate(
      {
        allowedPorts: [3000, 3001],
        appDir: ".",
        assumptions: [],
        env: { DEMO_MODE: "1" },
        expectedLocalUrl: "http://127.0.0.1:3000",
        installCommand: "npm ci --no-audit",
        localServices: [],
        riskFlags: [],
        runtime: "node",
        startCommand: "npm run dev",
        validationExpectations: [],
      },
      {
        keyProductFeatures: ["creating an account", "posting an article"],
      },
    );

    expect(readPreparationManifest(template)).toEqual(template);
    expect(template).toMatchObject({
      localDemoModeChanges: [],
      productContext: {
        evidencePaths: [],
        featureInventory: [
          {
            id: "requested-feature-1",
            label: "creating an account",
            requestedFeature: "creating an account",
          },
          {
            id: "requested-feature-2",
            label: "posting an article",
            requestedFeature: "posting an article",
          },
        ],
        name: "replace-with-product-name",
        summary: "replace-with-product-summary",
      },
      scriptGenerationContext: [],
    });
  });
});

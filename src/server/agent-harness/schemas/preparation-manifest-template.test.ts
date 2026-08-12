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
    // N107: maker-requested features must declare a proof; the template
    // shows the field so no agent has to infer its shape from prose.
    expect(
      template.productContext.featureInventory[0]?.expectedProof,
    ).toMatchObject({ kind: "visible-text" });
    // N122: without detected services there is nothing to answer.
    expect(template.dataStrategy).toBeUndefined();
  });

  it("pre-fills one data strategy entry per detected service", () => {
    // N122(3): the template is the steering surface — the rung defaults to
    // embedded-config exactly when detection proved an embedded driver
    // exists, and the template detail forces a real answer (enforcement
    // rejects unreplaced template values).
    const template = createPreparationManifestTemplate(
      {
        allowedPorts: [3000],
        appDir: ".",
        assumptions: [],
        env: {},
        expectedLocalUrl: "http://127.0.0.1:3000",
        installCommand: "npm ci --no-audit",
        localServices: [],
        riskFlags: [],
        runtime: "node",
        startCommand: "npm run dev",
        validationExpectations: [],
      },
      {},
      {
        servicesRequired: [
          {
            embeddedAlternativeEvidencePaths: ["package.json"],
            evidencePaths: ["docker-compose.yml", "package.json"],
            service: "postgres",
          },
          { evidencePaths: [".env.example"], service: "redis" },
        ],
      },
    );

    expect(readPreparationManifest(template)).toEqual(template);
    expect(template.dataStrategy).toEqual([
      {
        detail: "replace-with-how-postgres-is-served-for-the-demo",
        rung: "embedded-config",
        service: "postgres",
      },
      {
        detail: "replace-with-how-redis-is-served-for-the-demo",
        rung: "client-stub",
        service: "redis",
      },
    ]);
  });
});

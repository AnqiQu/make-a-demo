import { describe, expect, it } from "vitest";
import { readPreparationManifest } from "./artifacts";
import { createPreparationManifestTemplate } from "./preparation-manifest-template";

describe("Preparation Manifest template", () => {
  it("is a complete machine-readable manifest that satisfies the runtime contract", () => {
    const template = createPreparationManifestTemplate({
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
    });

    expect(readPreparationManifest(template)).toEqual(template);
    expect(template).toMatchObject({
      localDemoModeChanges: [],
      scriptGenerationContext: [],
    });
  });
});

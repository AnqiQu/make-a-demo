import { describe, expect, it } from "vitest";
import { createPreparationManifestContract } from "./preparation-manifest-contract";

describe("createPreparationManifestContract", () => {
  it("states the backend reader constraints agents must satisfy", () => {
    const contract = createPreparationManifestContract();
    const feature =
      contract.properties.productContext.properties.featureInventory.items;

    expect(feature.properties.entryPaths.items.pattern).toBeDefined();
    expect(
      new RegExp(feature.properties.entryPaths.items.pattern).test("/tracker"),
    ).toBe(true);
    expect(
      new RegExp(feature.properties.entryPaths.items.pattern).test("tracker"),
    ).toBe(false);
    expect(
      new RegExp(feature.properties.sourcePaths.items.pattern).test(
        "/etc/passwd",
      ),
    ).toBe(false);
    expect(
      new RegExp(contract.properties.baseUrl.pattern).test(
        "http://127.0.0.1:3000",
      ),
    ).toBe(true);
    expect(
      new RegExp(contract.properties.baseUrl.pattern).test(
        "https://example.com",
      ),
    ).toBe(false);
  });

  it("carries no version field that nothing reads", () => {
    expect(createPreparationManifestContract()).not.toHaveProperty(
      "contractVersion",
    );
  });
});

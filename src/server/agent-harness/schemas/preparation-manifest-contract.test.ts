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

  it("describes the optional per-feature data seams with their probe field", () => {
    // N100: agents declare where in-code fixtures live and which function
    // the UI calls; a contract with additionalProperties: false must name
    // the field or every declaring manifest becomes a contract violation.
    const contract = createPreparationManifestContract();
    const feature =
      contract.properties.productContext.properties.featureInventory.items;
    const seam = feature.properties.dataSeams.items;

    expect(seam.required).toEqual(["fixtureModule", "functionName", "path"]);
    expect(seam.properties.shapeProbe).toMatchObject({ type: "string" });
    expect(feature.required).not.toContain("dataSeams");
    expect(contract.invariants.join(" ")).toContain("dataSeams");
  });

  it("describes the declared proof obligation with its three typed kinds", () => {
    // N107: the feature says how to prove it. With additionalProperties:
    // false the contract must name the field, and its shape must force one
    // typed kind per declaration.
    const contract = createPreparationManifestContract();
    const feature =
      contract.properties.productContext.properties.featureInventory.items;
    const proof = feature.properties.expectedProof;

    expect(proof.oneOf.map((variant) => variant.properties.kind.const)).toEqual(
      ["element-appears", "state-transition", "visible-text"],
    );
    expect(feature.required).not.toContain("expectedProof");
    expect(contract.invariants.join(" ")).toContain("expectedProof");
    expect(contract.invariants.join(" ")).toContain("accessible name");
  });

  it("describes the data strategy answer to detected services", () => {
    // N122(2): with additionalProperties: false the contract must name the
    // field, its shape must force one typed rung per entry, and the
    // invariants must tie it to the repo profile's servicesRequired.
    const contract = createPreparationManifestContract();
    const entry = contract.properties.dataStrategy.items;

    expect(entry.required).toEqual(["detail", "rung", "service"]);
    expect(entry.properties.rung.enum).toEqual([
      "embedded-config",
      "provisioned-service",
      "client-stub",
      "provider-recipe",
      "declared-stub",
    ]);
    expect(contract.required).not.toContain("dataStrategy");
    expect(contract.invariants.join(" ")).toContain("servicesRequired");
    expect(contract.invariants.join(" ")).toContain("dataStrategy");
  });

  it("publishes the provisioned-service rung with its loopback connection urls", () => {
    // N122(5): the agent can wire envUsed to the harness-booted services
    // only if the contract states the exact DSNs, and the reserved-rung
    // list shrinks to provider-recipe alone.
    const contract = createPreparationManifestContract();
    const entry = contract.properties.dataStrategy.items;

    expect(entry.properties.migrationCommand).toEqual({
      minLength: 1,
      type: "string",
    });
    expect(entry.properties.seedCommand).toEqual({
      minLength: 1,
      type: "string",
    });
    const invariants = contract.invariants.join(" ");
    expect(invariants).toContain(
      "postgres://makeademo:makeademo@127.0.0.1:5432/makeademo",
    );
    expect(invariants).toContain(
      "mysql://makeademo:makeademo@127.0.0.1:3306/makeademo",
    );
    expect(invariants).toContain("redis://127.0.0.1:6379");
    expect(invariants).toContain("migrationCommand");
    expect(invariants).not.toContain(
      "provisioned-service and provider-recipe are reserved",
    );
  });

  it("carries no version field that nothing reads", () => {
    expect(createPreparationManifestContract()).not.toHaveProperty(
      "contractVersion",
    );
  });
});

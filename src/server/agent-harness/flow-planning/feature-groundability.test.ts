import { describe, expect, it } from "vitest";
import type { ActionCatalog } from "../schemas/artifacts";
import {
  isFeatureGroundable,
  readGroundableFeatureIds,
} from "./feature-groundability";

const catalog = (
  actions: Array<{
    featureIds: string[];
    kind: "assert" | "click" | "navigate";
    route: string;
  }>,
): ActionCatalog => ({
  actions: actions.map((action, index) => ({
    confidence: 1,
    evidence: "Playwright",
    expectedResult: "visible",
    featureIds: action.featureIds,
    id: `action-${index}`,
    kind: action.kind,
    preferredLocator: { name: "Text", strategy: "role", value: "heading" },
    risks: [],
    route: action.route,
  })),
  appMapId: "app_map",
  id: "actions",
});

describe("feature groundability", () => {
  it("grounds a feature only through a tagged assert outside auth walls", () => {
    const actionCatalog = catalog([
      { featureIds: ["dashboard"], kind: "assert", route: "/" },
      { featureIds: ["dark-mode"], kind: "navigate", route: "/theme" },
      { featureIds: ["billing"], kind: "assert", route: "/account" },
    ]);
    const authWallRoutes = new Set(["/account"]);

    expect(
      isFeatureGroundable("dashboard", { actionCatalog, authWallRoutes }),
    ).toBe(true);
    expect(
      isFeatureGroundable("dark-mode", { actionCatalog, authWallRoutes }),
    ).toBe(false);
    expect(
      isFeatureGroundable("billing", { actionCatalog, authWallRoutes }),
    ).toBe(false);
  });

  it("filters feature ids to the groundable ones in inventory order", () => {
    const actionCatalog = catalog([
      { featureIds: ["search"], kind: "assert", route: "/" },
      { featureIds: ["dashboard"], kind: "assert", route: "/" },
    ]);

    expect(
      readGroundableFeatureIds(["dashboard", "dark-mode", "search"], {
        actionCatalog,
        authWallRoutes: new Set(),
      }),
    ).toEqual(["dashboard", "search"]);
  });
});

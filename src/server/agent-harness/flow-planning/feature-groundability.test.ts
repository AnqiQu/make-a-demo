import { describe, expect, it } from "vitest";
import type { ActionCatalog } from "../schemas/artifacts";
import {
  isFeatureGroundable,
  readGroundableFeatureIds,
} from "./feature-groundability";

const catalog = (
  actions: Array<{
    exercised?: true;
    featureIds: string[];
    kind: "assert" | "click" | "navigate";
    navigationDestination?: string;
    route: string;
  }>,
): ActionCatalog => ({
  actions: actions.map((action, index) => ({
    confidence: 1,
    evidence: "Playwright",
    expectedResult: "visible",
    ...(action.exercised === undefined ? {} : { exercised: true as const }),
    featureIds: action.featureIds,
    id: `action-${index}`,
    kind: action.kind,
    ...(action.navigationDestination === undefined
      ? {}
      : { navigationDestination: action.navigationDestination }),
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
      { featureIds: ["dashboard"], kind: "navigate", route: "/" },
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
      { featureIds: ["search"], kind: "navigate", route: "/" },
      { featureIds: ["dashboard"], kind: "assert", route: "/" },
      { featureIds: ["dashboard"], kind: "navigate", route: "/" },
    ]);

    expect(
      readGroundableFeatureIds(["dashboard", "dark-mode", "search"], {
        actionCatalog,
        authWallRoutes: new Set(),
      }),
    ).toEqual(["dashboard", "search"]);
  });

  it("excludes a feature whose only interaction navigates to an auth-wall shape", () => {
    const actionCatalog = catalog([
      { featureIds: ["calendar"], kind: "assert", route: "/availability" },
      {
        exercised: true,
        featureIds: ["calendar"],
        kind: "click",
        navigationDestination: "/auth/login",
        route: "/availability",
      },
      { featureIds: ["safe"], kind: "assert", route: "/settings" },
      { featureIds: ["safe"], kind: "navigate", route: "/settings" },
    ]);

    expect(
      readGroundableFeatureIds(["calendar", "safe"], {
        actionCatalog,
        authWallRoutes: new Set(),
      }),
    ).toEqual(["safe"]);
    expect(
      isFeatureGroundable("calendar", {
        actionCatalog,
        allowedAuthWallFeatureIds: new Set(["calendar"]),
        authWallRoutes: new Set(),
      }),
    ).toBe(true);
  });
});

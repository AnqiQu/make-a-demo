import { describe, expect, it } from "vitest";
import {
  hasAuthWallRouteShape,
  isAuthDegradedClick,
  isAuthWallRoute,
} from "./auth-wall";

describe("auth wall evidence", () => {
  it("uses one route shape for harvested walls, click destinations, and redirects", () => {
    expect(hasAuthWallRouteShape("/auth/login?next=%2Fcalendar")).toBe(true);
    expect(
      isAuthDegradedClick({
        kind: "click",
        navigationDestination: "/auth/login?next=%2Fcalendar",
      }),
    ).toBe(true);
    expect(
      isAuthWallRoute({
        buttons: ["Continue"],
        headings: ["Welcome"],
        inputs: ["Email"],
        path: "/auth/login",
      }),
    ).toBe(true);
  });

  it("does not turn an auth-shaped marketing path into a wall without controls", () => {
    expect(
      isAuthWallRoute({
        buttons: ["Read more"],
        headings: ["Authentication guide"],
        inputs: [],
        path: "/auth/guide",
      }),
    ).toBe(false);
    expect(hasAuthWallRouteShape("/authoring")).toBe(false);
  });
});

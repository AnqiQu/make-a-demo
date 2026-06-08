import { describe, expect, it } from "vitest";

import { DefaultDemoPlanner } from "./default-demo-planner";

describe("DefaultDemoPlanner", () => {
  it("preserves requested key product features in demo order", async () => {
    const planner = new DefaultDemoPlanner();

    await expect(
      planner.planDemo({
        demoBrief: { keyProductFeatures: ["validation", "script package"] },
        exploration: {
          assumptions: [],
          productSurfaces: ["validation", "script package"],
          summary: "Prepared repo for demo.",
        },
      }),
    ).resolves.toEqual({
      featureOrder: ["validation", "script package"],
      narrative: "Prepared repo for demo.",
      risks: [],
    });
  });
});

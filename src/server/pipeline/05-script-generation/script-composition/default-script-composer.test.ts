import { describe, expect, it } from "vitest";

import { DefaultScriptComposer } from "./default-script-composer";

describe("DefaultScriptComposer", () => {
  it("creates one readable Scene Description per planned feature", async () => {
    const composer = new DefaultScriptComposer();

    await expect(
      composer.composeScript({
        demoBrief: { keyProductFeatures: ["validation", "script package"] },
        demoPlan: {
          featureOrder: ["validation", "script package"],
          narrative: "Show the prepared app.",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared app context.",
        },
      }),
    ).resolves.toEqual({
      estimatedDurationSeconds: 18,
      format: "16:9",
      sections: [
        {
          id: "section-main-demo",
          scenes: [
            {
              description: "Demonstrate validation.",
              durationSeconds: 9,
              events: [
                "Open the prepared local demo URL",
                "Navigate to the validation area if it is not already visible",
                "Show the validation workflow and its result",
              ],
              id: "scene-validation",
              playwrightSceneId: "scene-validation",
              playwrightScript: expect.stringContaining("validation"),
              transition: { durationSeconds: 0.25, in: "cut", out: "fade" },
              type: "playwright-recording",
            },
            {
              description: "Demonstrate script package.",
              durationSeconds: 9,
              events: [
                "Open the prepared local demo URL",
                "Navigate to the script package area if it is not already visible",
                "Show the script package workflow and its result",
              ],
              id: "scene-script-package",
              playwrightSceneId: "scene-script-package",
              playwrightScript: expect.stringContaining("script package"),
              transition: { durationSeconds: 0.25, in: "cut", out: "fade" },
              type: "playwright-recording",
            },
          ],
          title: "Main Demo",
        },
      ],
      scriptId: "generated-makeademo-script",
      title: "Generated MakeADemo Script",
      version: 1,
    });
  });
});

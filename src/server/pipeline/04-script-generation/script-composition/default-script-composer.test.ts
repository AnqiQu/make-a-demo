import { describe, expect, it } from "vitest";

import { DefaultScriptComposer } from "./default-script-composer";

describe("DefaultScriptComposer", () => {
  it("creates one continuous Demo Script with declared Scenes and no durations", async () => {
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
      demoPlaywrightScript: expect.stringContaining("scene-validation"),
      format: "16:9",
      presentation: {
        music: { enabled: true, trackId: "clean" },
        textOverlays: [
          {
            content: "Demonstrate validation.",
            font: "Inter",
            position: "bottom-left",
            sceneId: "scene-validation",
            size: "medium",
          },
          {
            content: "Demonstrate script package.",
            font: "Inter",
            position: "bottom-left",
            sceneId: "scene-script-package",
            size: "medium",
          },
        ],
        transitions: [
          {
            durationSeconds: 0.25,
            fromSceneId: "scene-validation",
            style: "fade",
            toSceneId: "scene-script-package",
          },
        ],
      },
      scenes: [
        {
          expectedVisibleOutcome: "The validation result is visible.",
          humanReadableDescription: "Demonstrate validation.",
          id: "scene-validation",
        },
        {
          expectedVisibleOutcome: "The script package result is visible.",
          humanReadableDescription: "Demonstrate script package.",
          id: "scene-script-package",
        },
      ],
      scriptId: "generated-makeademo-script",
      title: "Generated MakeADemo Script",
      version: 1,
    });
  });

  it("keeps scene identifiers unique when requested features normalize to the same slug", async () => {
    const composer = new DefaultScriptComposer();

    const script = await composer.composeScript({
      demoBrief: { keyProductFeatures: ["Admin dashboard", "Admin-dashboard"] },
      demoPlan: {
        featureOrder: ["Admin dashboard", "Admin-dashboard"],
        narrative: "Show admin flows.",
        risks: [],
      },
      exploration: {
        assumptions: [],
        productSurfaces: [],
        summary: "Prepared app context.",
      },
    });

    expect(script.scenes.map((scene) => scene.id)).toEqual([
      "scene-admin-dashboard",
      "scene-admin-dashboard-2",
    ]);
    expect(script.demoPlaywrightScript).toContain("scene-admin-dashboard-2");
    expect(
      script.presentation.textOverlays.map((overlay) => overlay.sceneId),
    ).toEqual(["scene-admin-dashboard", "scene-admin-dashboard-2"]);
  });
});

import type { CaptureReadyVideoScriptScene } from "../../06-footage-capture/video-script-package.schema";
import type { ScriptComposer } from "./script-composer.interface";
import type { VideoScript } from "./video-script";

export class DefaultScriptComposer implements ScriptComposer {
  async composeScript(
    input: Parameters<ScriptComposer["composeScript"]>[0],
  ): Promise<VideoScript> {
    const scenes: CaptureReadyVideoScriptScene[] =
      input.demoPlan.featureOrder.map((feature) => {
        const sceneId = `scene-${slug(feature)}`;
        const events = [
          "Open the prepared local demo URL",
          `Navigate to the ${feature} area if it is not already visible`,
          `Show the ${feature} workflow and its result`,
        ];

        return {
          description: `Demonstrate ${feature}.`,
          durationSeconds: 9,
          events,
          id: sceneId,
          playwrightSceneId: sceneId,
          playwrightScript: createPlaywrightScript(feature),
          transition: { durationSeconds: 0.25, in: "cut", out: "fade" },
          type: "playwright-recording" as const,
        };
      });

    return {
      estimatedDurationSeconds: Math.max(1, scenes.length) * 9,
      format: "16:9",
      scriptId: "generated-makeademo-script",
      sections: [
        {
          id: "section-main-demo",
          scenes,
          title: "Main Demo",
        },
      ],
      title: "Generated MakeADemo Script",
      version: 1,
    };
  }
}

function createPlaywrightScript(feature: string): string {
  return [
    "await page.goto(baseUrl);",
    "await expect(page.locator('body')).toContainText(/\\S/);",
    `await page.locator('body').evaluate(() => document.body.setAttribute('data-makeademo-feature', ${JSON.stringify(feature)}));`,
    "await page.waitForTimeout(2500);",
  ].join("\n");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

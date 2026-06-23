import type { SceneDescription } from "../../06-footage-capture/demo-script.schema";
import type { ScriptComposer } from "./script-composer.interface";
import type { VideoScript } from "./video-script";

export class DefaultScriptComposer implements ScriptComposer {
  async composeScript(
    input: Parameters<ScriptComposer["composeScript"]>[0],
  ): Promise<VideoScript> {
    const scenes: SceneDescription[] = input.demoPlan.featureOrder.map(
      (feature) => {
        const sceneId = `scene-${slug(feature)}`;

        return {
          expectedVisibleOutcome: `The ${feature} result is visible.`,
          humanReadableDescription: `Demonstrate ${feature}.`,
          id: sceneId,
        };
      },
    );

    return {
      demoPlaywrightScript: createPlaywrightScript(input.demoPlan.featureOrder),
      format: "16:9",
      presentation: {
        music: { enabled: true, trackId: "clean" },
        textOverlays: scenes.map((scene) => ({
          content: scene.humanReadableDescription,
          font: "Inter",
          position: "bottom-left",
          sceneId: scene.id,
          size: "medium",
        })),
        transitions: scenes.slice(0, -1).map((scene, sceneIndex) => ({
          durationSeconds: 0.25,
          fromSceneId: scene.id,
          style: "fade",
          toSceneId: scenes[sceneIndex + 1]?.id ?? scene.id,
        })),
      },
      scenes,
      scriptId: "generated-makeademo-script",
      title: "Generated MakeADemo Script",
      version: 1,
    };
  }
}

function createPlaywrightScript(features: string[]): string {
  const lines = [
    "import { scene, setup } from './makeademo-capture-sdk';",
    "",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('body')).toContainText(/\\S/);",
    "});",
  ];

  for (const feature of features) {
    lines.push(
      `await scene(${JSON.stringify(`scene-${slug(feature)}`)}, async ({ page, expect }) => {`,
      `  await page.locator('body').evaluate(() => document.body.setAttribute('data-makeademo-feature', ${JSON.stringify(feature)}));`,
      "  await expect(page.locator('body')).toContainText(/\\S/);",
      "});",
    );
  }

  return lines.join("\n");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

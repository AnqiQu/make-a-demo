import type { ScriptComposer } from "./script-composer.interface";
import type { VideoScript } from "./video-script";

export class DefaultScriptComposer implements ScriptComposer {
  async composeScript(
    input: Parameters<ScriptComposer["composeScript"]>[0],
  ): Promise<VideoScript> {
    return {
      sections: [
        {
          id: "section-main-demo",
          scenes: input.demoPlan.featureOrder.map((feature) => ({
            browserActions: [
              "Open the prepared local demo URL",
              `Navigate to the ${feature} area if it is not already visible`,
              `Show the ${feature} workflow and its result`,
            ],
            id: `scene-${slug(feature)}`,
            summary: `Demonstrate ${feature}.`,
          })),
          title: "Main Demo",
        },
      ],
      title: "Generated MakeADemo Script",
    };
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

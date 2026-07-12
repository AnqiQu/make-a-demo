import { describe, expect, it } from "vitest";

import { validateDemoScriptCandidate } from "./demo-script-candidate-validator";

describe("Demo Script candidate validator", () => {
  it("accepts a candidate that satisfies schema, Capture SDK, TypeScript, and quality checks", async () => {
    await expect(
      validateDemoScriptCandidate({
        demoPlaywrightScript: [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await setup(async ({ page, baseUrl }) => {",
          "  await page.goto(baseUrl + '#/');",
          "});",
          "await scene('scene_feed', async ({ page, expect }) => {",
          "  await page.getByText('Global Feed').click();",
          "  await expect(page.getByText('demo')).toBeVisible();",
          "});",
        ].join("\n"),
        format: "16:9",
        presentation: {
          music: { enabled: false },
          textOverlays: [],
          transitions: [],
        },
        scenes: [
          {
            expectedVisibleOutcome: "Filtered demo articles are visible.",
            humanReadableDescription: "Filter the global feed.",
            id: "scene_feed",
          },
        ],
        scriptId: "script_conduit",
        title: "Conduit article feed demo",
        version: 1,
      }),
    ).resolves.toMatchObject({ scriptId: "script_conduit" });
  });
});

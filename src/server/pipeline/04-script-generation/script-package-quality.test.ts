import { describe, expect, it } from "vitest";

import type { DemoScript } from "../06-footage-capture/demo-script.schema";
import { assertCaptureReadyScriptQuality } from "./script-package-quality";

describe("assertCaptureReadyScriptQuality", () => {
  it("accepts a setup body smoke check when Scenes use finite product interactions", () => {
    expect(() =>
      assertCaptureReadyScriptQuality(
        demoScript({
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl, expect }) => {",
            "  await page.goto(baseUrl);",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
            "await scene('scene_time', async ({ page, expect }) => {",
            "  await page.getByRole('button', { name: 'Log 30m' }).click();",
            "  await expect(page.locator('#billableHours')).toContainText('0.5');",
            "});",
          ].join("\n"),
        }),
      ),
    ).not.toThrow();
  });

  it("rejects Demo Scripts that only smoke-check the page body", () => {
    expect(() =>
      assertCaptureReadyScriptQuality(
        demoScript({
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl, expect }) => {",
            "  await page.goto(baseUrl);",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
            "await scene('scene_placeholder', async ({ page, expect }) => {",
            "  await expect(page.locator('body')).toBeVisible();",
            "});",
          ].join("\n"),
        }),
      ),
    ).toThrow("demoPlaywrightScript contains placeholder actions");
  });
});

function demoScript(
  overrides: Pick<DemoScript, "demoPlaywrightScript">,
): DemoScript {
  return {
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Billable time is visible.",
        humanReadableDescription: "Log billable time.",
        id: "scene_time",
      },
    ],
    scriptId: "script_time_tracking",
    title: "Time tracking demo",
    version: 1,
    ...overrides,
  };
}

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DefaultCapturePathSceneValidator } from "./playwright-capture-path-scene-validator";

describe("DefaultCapturePathSceneValidator", () => {
  it("persists stdout and stderr when a dry-run scene fails", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async () => {});",
        "await scene('scene_failure_evidence', async () => {",
        "  throw new Error('selector exploded');",
        "});",
      ].join("\n"),
      scene: {
        expectedVisibleOutcome: "The failure is visible.",
        humanReadableDescription: "Fail deterministically.",
        id: "scene_failure_evidence",
      },
      sectionId: "section_failure",
    });

    expect(result.status).toBe("failed");
    expect(result.stdoutPath).toContain("scene_failure_evidence.stdout.log");
    expect(result.stderrPath).toContain("scene_failure_evidence.stderr.log");
    expect(await readFile(result.stdoutPath as string, "utf8")).toContain(
      "[makeademo:validation] script started",
    );
    expect(await readFile(result.stderrPath as string, "utf8")).toContain(
      "selector exploded",
    );
    expect(result.logs.join("\n")).toContain("selector exploded");
  }, 20_000);

  it("rejects SDK type errors before running the dry-run browser script", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ missingThing }) => {",
        "  await missingThing();",
        "});",
        "await scene('scene_type_error', async ({ page, expect }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
      ].join("\n"),
      scene: {
        expectedVisibleOutcome: "The page is visible.",
        humanReadableDescription: "Show the page.",
        id: "scene_type_error",
      },
      sectionId: "section_type_error",
    });

    expect(result).toMatchObject({
      failureReason: "Demo Script failed Capture SDK TypeScript validation.",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("missingThing");
    expect(result.stdoutPath).toBeUndefined();
    expect(result.stderrPath).toBeUndefined();
  }, 20_000);
});

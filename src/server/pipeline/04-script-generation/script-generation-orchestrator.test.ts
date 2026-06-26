import { describe, expect, it } from "vitest";

import { parseDemoScript } from "../06-footage-capture/demo-script.schema";
import { generateDemoScriptPackage } from "./script-generation-orchestrator";

describe("generateDemoScriptPackage", () => {
  it("explores the project, plans the demo, composes the script, and returns the handoff package", async () => {
    const packageResult = await generateDemoScriptPackage(
      {
        demoBrief: { keyProductFeatures: ["repo validation"] },
        normalizedSupportingDocuments: [],
        preparationManifest: manifest(),
        repoUrl: "https://github.com/example/app",
      },
      {
        projectExplorer: {
          async exploreProject() {
            return {
              assumptions: ["single page app"],
              productSurfaces: ["validation dashboard"],
              summary: "A product for validating demo-ready repos.",
            };
          },
        },
        demoPlanner: {
          async planDemo({ demoBrief, exploration }) {
            return {
              featureOrder: demoBrief.keyProductFeatures,
              narrative: `Show ${exploration.productSurfaces[0]}`,
              risks: [],
            };
          },
        },
        scriptComposer: {
          async composeScript() {
            return {
              demoPlaywrightScript: [
                "import { setup, scene } from './makeademo-capture-sdk';",
                "await setup(async ({ page, baseUrl, expect }) => {",
                "  await page.goto(baseUrl);",
                "  await expect(page.locator('html')).toBeVisible();",
                "});",
                "await scene('scene_validation', async ({ page, expect }) => {",
                "  await page.getByRole('button', { name: 'Validate repo' }).click();",
                "  await expect(page.getByText('Validated project')).toBeVisible();",
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
                  expectedVisibleOutcome:
                    "The validated project result is visible.",
                  humanReadableDescription:
                    "Show the validated project result.",
                  id: "scene_validation",
                },
              ],
              scriptId: "script_test",
              title: "MakeADemo validation demo",
              version: 1,
            };
          },
        },
      },
    );

    expect(parseDemoScript(packageResult).scriptId).toBe("script_test");
    expect(packageResult.scenes[0]).toEqual({
      expectedVisibleOutcome: "The validated project result is visible.",
      humanReadableDescription: "Show the validated project result.",
      id: "scene_validation",
    });
    expect(packageResult.assumptions).toEqual(["single page app"]);
  });

  it("rejects placeholder non-agent Demo Scripts before returning the handoff package", async () => {
    await expect(
      generateDemoScriptPackage(
        {
          demoBrief: { keyProductFeatures: ["repo validation"] },
          normalizedSupportingDocuments: [],
          preparationManifest: manifest(),
          repoUrl: "https://github.com/example/app",
        },
        {
          projectExplorer: {
            async exploreProject() {
              return {
                assumptions: [],
                productSurfaces: ["validation dashboard"],
                summary: "A product for validating demo-ready repos.",
              };
            },
          },
          demoPlanner: {
            async planDemo({ demoBrief }) {
              return {
                featureOrder: demoBrief.keyProductFeatures,
                narrative: "Show validation.",
                risks: [],
              };
            },
          },
          scriptComposer: {
            async composeScript() {
              return {
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
                format: "16:9",
                presentation: {
                  music: { enabled: false },
                  textOverlays: [],
                  transitions: [],
                },
                scenes: [
                  {
                    expectedVisibleOutcome: "The placeholder is visible.",
                    humanReadableDescription: "Show placeholder content.",
                    id: "scene_placeholder",
                  },
                ],
                scriptId: "script_placeholder",
                title: "Placeholder demo",
                version: 1,
              };
            },
          },
        },
      ),
    ).rejects.toThrow("demoPlaywrightScript contains placeholder actions");
  });
});

function manifest() {
  return {
    assumptions: ["single page app"],
    createdFiles: [],
    demoCommand: "npm run demo:makeademo",
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId: "workspace_123",
  };
}

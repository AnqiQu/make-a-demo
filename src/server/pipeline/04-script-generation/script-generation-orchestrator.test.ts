import { describe, expect, it } from "vitest";

import { parseDemoScript } from "../06-footage-capture/demo-script.schema";
import { generateVideoScriptPackage } from "./script-generation-orchestrator";

describe("generateVideoScriptPackage", () => {
  it("explores the project, plans the demo, composes the script, and returns the handoff package", async () => {
    const packageResult = await generateVideoScriptPackage(
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
              demoPlaywrightScript:
                "await scene('scene_validation', async () => { await page.goto(baseUrl); });",
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

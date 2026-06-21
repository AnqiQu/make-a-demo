import { describe, expect, it } from "vitest";

import { parseVideoScriptPackage } from "../06-footage-capture/video-script-package.schema";
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
              estimatedDurationSeconds: 8,
              format: "16:9",
              scriptId: "script_test",
              sections: [
                {
                  id: "section_intro",
                  scenes: [
                    {
                      description: "Show the validated project result.",
                      durationSeconds: 8,
                      events: ["Open the validation dashboard"],
                      id: "scene_validation",
                      playwrightSceneId: "scene_validation",
                      playwrightScript: "await page.goto(baseUrl);",
                      type: "playwright-recording",
                    },
                  ],
                  title: "Validation",
                },
              ],
              title: "MakeADemo validation demo",
              version: 1,
            };
          },
        },
      },
    );

    expect(parseVideoScriptPackage(packageResult).scriptId).toBe("script_test");
    expect(packageResult.sections[0]?.scenes[0]).toEqual({
      description: "Show the validated project result.",
      durationSeconds: 8,
      events: ["Open the validation dashboard"],
      id: "scene_validation",
      playwrightSceneId: "scene_validation",
      playwrightScript: "await page.goto(baseUrl);",
      type: "playwright-recording",
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

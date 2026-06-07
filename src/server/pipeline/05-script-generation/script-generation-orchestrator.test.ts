import { describe, expect, it } from "vitest";

import { generateVideoScriptPackage } from "./script-generation-orchestrator";

describe("generateVideoScriptPackage", () => {
  it("explores the project, plans the demo, composes the script, and returns the handoff package", async () => {
    const packageResult = await generateVideoScriptPackage(
      {
        demoBrief: { keyProductFeatures: ["repo validation"] },
        normalizedSupportingDocuments: [],
        preparationManifest: manifest(),
        repoUrl: "https://github.com/example/app",
        validation: {
          blockedNetworkAttempts: [],
          logs: ["validated"],
          screenshotArtifactId: "artifact_screenshot",
          status: "succeeded",
          warnings: [],
        },
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
              sections: [
                {
                  id: "section_intro",
                  scenes: [
                    {
                      browserActions: ["Open the validation dashboard"],
                      id: "scene_validation",
                      summary: "Show the validated project result.",
                    },
                  ],
                  title: "Validation",
                },
              ],
              title: "MakeADemo validation demo",
            };
          },
        },
      },
    );

    expect(packageResult.videoScript.sections[0]?.scenes[0]).toEqual({
      browserActions: ["Open the validation dashboard"],
      id: "scene_validation",
      summary: "Show the validated project result.",
    });
    expect(packageResult.validation.logs).toEqual(["validated"]);
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

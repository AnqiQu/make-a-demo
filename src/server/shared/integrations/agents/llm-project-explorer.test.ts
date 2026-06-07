import { describe, expect, it } from "vitest";

import { LlmProjectExplorer } from "./llm-project-explorer";

describe("LlmProjectExplorer", () => {
  it("summarizes preparation context and supporting documents without a separate agent", async () => {
    const explorer = new LlmProjectExplorer();

    await expect(
      explorer.exploreProject({
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [
          {
            normalizedText: "The validation dashboard shows repo readiness.",
            sourceArtifactId: "artifact_doc",
            sourceFileName: "brief.md",
          },
        ],
        preparationManifest: {
          assumptions: ["uses local fixtures"],
          createdFiles: [],
          demoCommand: "npm run demo:makeademo",
          diffArtifactId: "artifact_diff",
          existingDemoEvidence: ["package script demo"],
          mockedServices: ["api.example.com"],
          modifiedFiles: [],
          repoUrl: "https://github.com/example/app",
          risks: [],
          scriptGenerationContext: ["Start on the validation dashboard"],
          setupSummary: "Prepared demo runtime.",
          status: "created-new-demo",
          url: "http://localhost:3000",
          workspaceId: "workspace_123",
        },
        repoUrl: "https://github.com/example/app",
        validation: {
          blockedNetworkAttempts: [],
          logs: ["validated"],
          status: "succeeded",
          warnings: [],
        },
      }),
    ).resolves.toEqual({
      assumptions: ["uses local fixtures"],
      productSurfaces: ["validation", "package script demo"],
      summary:
        "Prepared demo runtime. Supporting context: The validation dashboard shows repo readiness.",
    });
  });
});

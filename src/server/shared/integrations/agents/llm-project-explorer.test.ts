import { describe, expect, it } from "vitest";

import { LlmProjectExplorer } from "./llm-project-explorer";

describe("LlmProjectExplorer", () => {
  it("is an explicit stub until the Explorer agent code is imported", async () => {
    const explorer = new LlmProjectExplorer();

    await expect(
      explorer.exploreProject({
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        preparationManifest: {
          assumptions: [],
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
    ).rejects.toThrowError("LlmProjectExplorer is a stub");
  });
});

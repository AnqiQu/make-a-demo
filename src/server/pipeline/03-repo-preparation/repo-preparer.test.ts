import { describe, expect, it } from "vitest";

import type { RepoPreparationAgent } from "./repo-preparation-agent.interface";
import { prepareRepo } from "./repo-preparer";

describe("prepareRepo", () => {
  it("returns a manifest when the preparation agent prepares the workspace", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          manifest: {
            assumptions: [],
            demoCommand: "npm run demo:makeademo",
            diffArtifactId: "artifact_diff",
            repoUrl: "https://github.com/example/app",
            risks: [],
            setupSummary: "Reused an existing demo script.",
            status: "reused-existing-demo",
            url: "http://localhost:3000",
            workspaceId: "workspace_123",
          },
          status: "succeeded",
        };
      },
    };

    const result = await prepareRepo(
      {
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.manifest.demoCommand).toBe("npm run demo:makeademo");
    }
  });

  it("returns a fallback prompt when the preparation agent cannot prepare the workspace", async () => {
    const agent: RepoPreparationAgent = {
      async prepare() {
        return {
          assumptions: ["remote API shape is not inferable"],
          blockers: ["dashboard data requires a private API"],
          status: "failed",
          suggestedChanges: ["add local dashboard fixtures"],
        };
      },
    };

    const result = await prepareRepo(
      {
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["dashboard"] },
        workspaceId: "workspace_123",
      },
      { agent },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.fallbackPrompt).toContain(
        "dashboard data requires a private API",
      );
      expect(result.fallbackPrompt).toContain("add local dashboard fixtures");
    }
  });
});

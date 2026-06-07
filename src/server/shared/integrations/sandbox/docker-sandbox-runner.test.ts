import { describe, expect, it } from "vitest";

import { DockerSandboxRunner } from "./docker-sandbox-runner";

describe("DockerSandboxRunner", () => {
  it("is an explicit stub until sandbox execution is implemented", async () => {
    const runner = new DockerSandboxRunner();

    await expect(
      runner.runValidation({
        preparationManifest: {
          assumptions: [],
          createdFiles: [],
          demoCommand: "npm run demo",
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
        demoCommand: "npm run demo",
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrowError("DockerSandboxRunner is a stub");
  });
});

import { describe, expect, it } from "vitest";

import type { RepoPreparationAgent } from "../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { BrowserValidator } from "../../pipeline/04-project-validation/browser-validator.interface";
import type { SandboxRunner } from "../../pipeline/04-project-validation/sandbox-runner.interface";
import { runPipelineJob } from "./pipeline-orchestrator";
import { createStage1PipelineDependencies } from "./stage1-pipeline";

describe("createStage1PipelineDependencies", () => {
  it("wires the runnable Stage 1 flow through Script Generation", async () => {
    const repoPreparationAgent: RepoPreparationAgent = {
      async prepare() {
        return {
          manifest: {
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
          status: "succeeded",
        };
      },
    };
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          logs: ["demo running"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          interactable: true,
          logs: ["browser loaded"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await runPipelineJob(
      {
        demoBrief: { keyProductFeatures: ["validation"] },
        normalizedSupportingDocuments: [],
        repoSecurity: {
          files: [{ path: "package.json", text: "{}" }, { path: "bun.lock" }],
          repoStats: { fileCount: 2, sizeBytes: 1_000 },
        },
        repoUrl: "https://github.com/example/app",
        workspaceId: "workspace_123",
      },
      createStage1PipelineDependencies({
        browserValidator,
        repoPreparationAgent,
        sandboxRunner,
      }),
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(
        result.videoScriptPackage.videoScript.sections[0]?.scenes[0],
      ).toEqual({
        browserActions: [
          "Open the prepared local demo URL",
          "Navigate to the validation area if it is not already visible",
          "Show the validation workflow and its result",
        ],
        id: "scene-validation",
        summary: "Demonstrate validation.",
      });
    }
  });
});

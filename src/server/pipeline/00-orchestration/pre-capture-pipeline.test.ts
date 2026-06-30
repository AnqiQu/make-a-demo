import { describe, expect, it } from "vitest";

import type { RepoPreparationAgent } from "../03-repo-preparation/repo-preparation-agent.interface";
import type { BrowserValidator } from "../05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import type { SandboxRunner } from "../05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import { parseDemoScript } from "../06-footage-capture/demo-script.schema";
import { runPipelineJob } from "./pipeline-orchestrator";
import { createPreCapturePipelineDependencies } from "./pre-capture-pipeline";

describe("createPreCapturePipelineDependencies", () => {
  it("wires the runnable pre-capture flow through Script Generation", async () => {
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
      createPreCapturePipelineDependencies({
        browserValidator,
        repoPreparationAgent,
        sandboxRunner,
      }),
    );

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(parseDemoScript(result.videoScriptPackage).scriptId).toBe(
        "generated-makeademo-script",
      );
      expect(result.videoScriptPackage.scenes[0]).toMatchObject({
        humanReadableDescription: "Demonstrate validation.",
        id: "scene-validation",
      });
    }
  });
});

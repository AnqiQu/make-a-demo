import { describe, expect, it } from "vitest";

import { runPipelineJob } from "./pipeline-orchestrator";

describe("runPipelineJob", () => {
  it("validates the project before generating the Video Script Package", async () => {
    const calls: string[] = [];

    const result = await runPipelineJob(
      {
        config: {
          demoCommand: "npm run demo",
          url: "http://localhost:3000",
        },
        demoBrief: { keyProductFeatures: ["validation"] },
        repoUrl: "https://github.com/example/app",
      },
      {
        async generateScriptPackage({ validation }) {
          calls.push("script-generation");
          return {
            assumptions: [],
            demoPlan: {
              featureOrder: ["validation"],
              narrative: "Demo it",
              risks: [],
            },
            exploration: { assumptions: [], productSurfaces: [], summary: "" },
            validation,
            videoScript: { sections: [], title: "Demo" },
          };
        },
        async validateProject() {
          calls.push("validation");
          return {
            blockedNetworkAttempts: [],
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          };
        },
      },
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual(["validation", "script-generation"]);
  });

  it("stops before Script Generation when Project Validation fails", async () => {
    const result = await runPipelineJob(
      {
        config: {
          demoCommand: "npm run demo",
          url: "http://localhost:3000",
        },
        demoBrief: { keyProductFeatures: ["validation"] },
        repoUrl: "https://github.com/example/app",
      },
      {
        async generateScriptPackage() {
          throw new Error(
            "script generation should not run after validation fails",
          );
        },
        async validateProject() {
          return {
            blockedNetworkAttempts: [],
            failureReason: "Demo command failed inside the sandbox.",
            logs: ["failed"],
            status: "failed",
            warnings: [],
          };
        },
      },
    );

    expect(result).toEqual({
      status: "failed",
      validation: {
        blockedNetworkAttempts: [],
        failureReason: "Demo command failed inside the sandbox.",
        logs: ["failed"],
        status: "failed",
        warnings: [],
      },
    });
  });
});

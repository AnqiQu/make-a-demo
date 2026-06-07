import { describe, expect, it } from "vitest";

import type { BrowserValidator } from "./browser-validator.interface";
import { validateProject } from "./project-validator";
import type { SandboxRunner } from "./sandbox-runner.interface";

describe("validateProject", () => {
  it("returns validation artifacts when the prepared repo satisfies the Demo Run Contract", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          logs: ["installed", "started demo"],
          repoFiles: ["package.json", "bun.lock"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          interactable: true,
          logs: ["loaded app"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        config: {
          demoCommand: "npm run demo",
          url: "http://127.0.0.1:3000",
        },
        repoUrl: "https://github.com/example/app",
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toEqual({
      blockedNetworkAttempts: [],
      logs: ["installed", "started demo", "loaded app"],
      screenshotArtifactId: "artifact_screenshot",
      status: "succeeded",
      warnings: [],
    });
  });

  it("fails validation when runtime network attempts cross the sandbox boundary", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.example.com",
              phase: "runtime",
            },
          ],
          logs: ["started demo"],
          repoFiles: ["package.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error(
          "browser validation should not run after network failure",
        );
      },
    };

    const result = await validateProject(
      {
        config: {
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        },
        repoUrl: "https://github.com/example/app",
      },
      { browserValidator, sandboxRunner },
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe(
      "Runtime network communication across the sandbox boundary is not allowed.",
    );
    expect(result.blockedNetworkAttempts).toHaveLength(1);
    expect(result.warnings).toEqual([
      "No lockfile found; npm install may be less deterministic.",
    ]);
  });
});

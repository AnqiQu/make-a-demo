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
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://127.0.0.1:3000",
        }),
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
    let cleanedUp = false;
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
          cleanup: async () => {
            cleanedUp = true;
          },
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
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
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
    expect(cleanedUp).toBe(true);
  });

  it("preserves browser validation errors when cleanup also fails", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          cleanup: async () => {
            throw new Error("cleanup failed");
          },
          logs: ["started demo"],
          repoFiles: ["package.json", "package-lock.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        throw new Error("browser failed");
      },
    };

    await expect(
      validateProject(
        {
          preparationManifest: manifest({
            demoCommand: "npm run demo",
            url: "http://localhost:5173",
          }),
        },
        { browserValidator, sandboxRunner },
      ),
    ).rejects.toThrow("browser failed");
  });

  it("fails validation when browser runtime requests leave the local boundary", async () => {
    const sandboxRunner: SandboxRunner = {
      async runValidation() {
        return {
          blockedNetworkAttempts: [],
          logs: ["started demo"],
          repoFiles: ["package.json"],
          runtimeExitCode: 0,
        };
      },
    };
    const browserValidator: BrowserValidator = {
      async validate() {
        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.realworld.io",
              phase: "runtime",
            },
          ],
          interactable: true,
          logs: ["loaded app", "blocked https://api.realworld.io/articles"],
          screenshotArtifactId: "artifact_screenshot",
        };
      },
    };

    const result = await validateProject(
      {
        preparationManifest: manifest({
          demoCommand: "npm run demo",
          url: "http://localhost:5173",
        }),
      },
      { browserValidator, sandboxRunner },
    );

    expect(result).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.realworld.io",
          phase: "runtime",
        },
      ],
      failureReason:
        "Runtime network communication across the sandbox boundary is not allowed.",
      status: "failed",
    });
  });
});

function manifest(overrides: { demoCommand: string; url: string }) {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: overrides.demoCommand,
    diffArtifactId: "artifact_diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared demo runtime.",
    status: "created-new-demo" as const,
    url: overrides.url,
    workspaceId: "workspace_123",
  };
}

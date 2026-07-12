import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { DaytonaOpenCodeDemoScriptValidationHandler } from "./daytona-opencode-demo-script-validation";
import { demoScriptPath } from "./demo-script-validation-artifact-handoff";

describe("DaytonaOpenCodeDemoScriptValidationHandler", () => {
  it("returns direct static feedback for the completed tool handoff", async () => {
    const files = new Map([
      [demoScriptPath, JSON.stringify({ scriptId: "incomplete" })],
    ]);
    const handler = new DaytonaOpenCodeDemoScriptValidationHandler({
      validateCapturePath: async () => {
        throw new Error("runtime should not run after static rejection");
      },
    });
    const result = await handler.handle(
      {
        demoBrief: { keyProductFeatures: ["feed"] },
        preparationManifest: {
          assumptions: [],
          demoCommand: "bun run dev",
          risks: [],
          scriptGenerationContext: [],
          setupSummary: "ready",
          url: "http://localhost:3000",
          workspaceId: "workspace_1",
        } as never,
        preparationWorkspace: fakeHandle(files),
      },
      demoScriptPath,
    );
    expect(result.status).toBe("failed");
    expect(result.feedback).toContain("Demo Script static validation failed");
  });

  it("combines static checks with prepared-runtime locator diagnostics", async () => {
    const files = new Map([
      [demoScriptPath, JSON.stringify(validDemoScript())],
    ]);
    let validatedScriptId: string | undefined;
    const handler = new DaytonaOpenCodeDemoScriptValidationHandler({
      validateCapturePath: async (input) => {
        validatedScriptId = input.demoScriptCandidate.scriptId;
        return {
          blockedNetworkAttempts: [],
          errorMessage: "strict mode violation: resolved to 2 elements",
          failedAction: "locator.click(getByText(Feed))",
          failureReason:
            "Scene scene_feed failed during Capture Path Validation.",
          logs: ["strict mode violation: resolved to 2 elements"],
          status: "failed",
          warnings: [],
        };
      },
    });
    const result = await handler.handle(
      {
        demoBrief: { keyProductFeatures: ["feed"] },
        preparationManifest: {
          assumptions: [],
          demoCommand: "bun run dev",
          risks: [],
          scriptGenerationContext: [],
          setupSummary: "ready",
          url: "http://localhost:3000",
          workspaceId: "workspace_1",
        } as never,
        preparationWorkspace: fakeHandle(files),
      },
      demoScriptPath,
    );

    expect(validatedScriptId).toBe("script_feed");
    expect(result.status).toBe("failed");
    expect(result.kind).toBe("runtime");
    expect(result.feedback).toContain("locator-cardinality validation failed");
    expect(result.feedback).toContain("resolved to 2 elements");
  });
});

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
      "await scene('scene_feed', async ({ page, expect }) => {",
      "  await page.getByText('Global Feed').click();",
      "  await expect(page.getByText('demo')).toBeVisible();",
      "});",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Filtered demo articles are visible.",
        humanReadableDescription: "Filter the global feed.",
        id: "scene_feed",
      },
    ],
    scriptId: "script_feed",
    title: "Feed demo",
    version: 1,
  };
}

function fakeHandle(files: Map<string, string>): PreparationWorkspaceHandle {
  return {
    destroy: async () => {},
    id: "workspace_1",
    workspace: {
      async execute(command) {
        const path = command.match(/cat '([^']+)'/)?.[1];
        if (path === undefined) return { exitCode: 0, stderr: "", stdout: "" };
        const content = files.get(path);
        return content === undefined
          ? { exitCode: 1, stderr: "", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: content };
      },
      async getPreviewUrl() {
        return "http://localhost";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

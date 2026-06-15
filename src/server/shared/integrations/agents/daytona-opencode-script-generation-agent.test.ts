import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeScriptGenerationAgent } from "./daytona-opencode-script-generation-agent";

describe("DaytonaOpenCodeScriptGenerationAgent", () => {
  it("resumes the validated Repo Preparation OpenCode session and returns an interactive script package", async () => {
    const events: unknown[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGenerationAgent({
      modelID: "gpt-5.5",
      onStdout: (chunk) => stdout.push(chunk),
      providerApiKey: "openai_key",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(result.sections[0]?.scenes[0]).toMatchObject({
      playwrightSceneId: "scene_feed",
      type: "playwright-recording",
    });
    expect(result.demoPlan.featureOrder).toEqual(["article feed"]);
    expect(result.validation.status).toBe("succeeded");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configDir: "/workspace/.makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("--session 'session_prepare_123'");
    expect(openCodeCommand).not.toContain("OPENAI_API_KEY");
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 starting in session session_prepare_123.",
    );
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 produced a valid script package.",
    );
  });

  it("repairs static placeholder script packages in the same OpenCode session", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGenerationAgent({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [
        staticPlaceholderPackage(),
        interactivePackage(),
      ]),
    });

    expect(result.scriptId).toBe("script_conduit");
    const openCodeCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute);
    expect(openCodeCommands).toHaveLength(2);
    expect(openCodeCommands[1]).toContain("placeholder actions");
    expect(openCodeCommands[1]).toContain("--session 'session_prepare_123'");
  });
});

function workspaceHandle(events: unknown[], artifacts: unknown[]) {
  let latestArtifact: unknown;
  const workspace: PreparationWorkspace = {
    async execute(command, options) {
      events.push({
        execute: command,
        ...(options?.env?.OPENCODE_CONFIG_DIR === undefined
          ? {}
          : { configDir: options.env.OPENCODE_CONFIG_DIR }),
        ...(options?.onStdout === undefined ? {} : { streaming: true }),
      });

      if (command.includes("opencode run")) {
        latestArtifact = artifacts.shift();
        options?.onStdout?.("script generation output");
        return { exitCode: 0, stderr: "", stdout: "generated" };
      }

      if (command.startsWith("if test -f")) {
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles() {},
  };

  return {
    async destroy() {},
    id: "daytona_workspace",
    workspace,
  };
}

function scriptGenerationInput() {
  return {
    demoBrief: { keyProductFeatures: ["article feed"] },
    normalizedSupportingDocuments: [],
    preparationManifest: {
      assumptions: ["auth accepts demo credentials"],
      createdFiles: [],
      demoCommand: "npm run demo:makeademo",
      diffArtifactId: "artifact_diff",
      existingDemoEvidence: [],
      mockedServices: ["local article API"],
      modifiedFiles: [],
      repoUrl: "https://github.com/example/conduit",
      risks: [],
      scriptGenerationContext: ["Use hash routes and demo@example.com."],
      setupSummary: "Prepared Conduit with local articles.",
      status: "created-new-demo" as const,
      url: "http://localhost:3000",
      workspaceId: "workspace_123",
    },
    repoUrl: "https://github.com/example/conduit",
    validation: {
      blockedNetworkAttempts: [],
      browserUrl: "https://preview.example.test",
      logs: ["validated"],
      status: "succeeded" as const,
      warnings: [],
    },
  };
}

function interactivePackage() {
  return {
    estimatedDurationSeconds: 8,
    format: "16:9",
    scriptId: "script_conduit",
    sections: [
      {
        id: "section_feed",
        scenes: [
          {
            description: "Filter the global feed by a popular tag.",
            durationSeconds: 8,
            events: ["Open the feed", "Select a tag", "Verify articles update"],
            id: "scene_feed",
            playwrightSceneId: "scene_feed",
            playwrightScript:
              "await page.goto(baseUrl + '#/');\nawait page.getByText('Global Feed').click();\nawait page.getByText('demo').click();\nawait expect(page.getByText('demo')).toBeVisible();",
            type: "playwright-recording",
          },
        ],
        title: "Article feed",
      },
    ],
    title: "Conduit article feed demo",
    version: 1,
  };
}

function staticPlaceholderPackage() {
  return {
    ...interactivePackage(),
    sections: [
      {
        id: "section_feed",
        scenes: [
          {
            description: "Open the app.",
            durationSeconds: 8,
            events: ["Open the app"],
            id: "scene_feed",
            playwrightSceneId: "scene_feed",
            playwrightScript:
              "await page.goto(baseUrl);\nawait expect(page.locator('body')).toContainText(/\\S/);\nawait page.locator('body').evaluate(() => document.body.setAttribute('data-makeademo-feature', 'feed'));\nawait page.waitForTimeout(2500);",
            type: "playwright-recording",
          },
        ],
        title: "Article feed",
      },
    ],
  };
}

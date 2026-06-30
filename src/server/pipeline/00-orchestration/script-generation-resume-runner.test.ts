import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ScriptGenerationAgent } from "../04-script-generation/script-generation-agent.interface";
import { runScriptGenerationResume } from "./script-generation-resume-runner";

describe("runScriptGenerationResume", () => {
  it("reruns only Script Generation from a retained preparation workspace and session", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-scriptgen-"));
    const calls: unknown[] = [];
    const agent: ScriptGenerationAgent = {
      async generateScriptPackage(input) {
        calls.push({
          opencodeSessionID: input.opencodeSessionID,
          repoUrl: input.repoUrl,
          workspaceId: input.preparationWorkspace.id,
        });
        return scriptPackage();
      },
    };

    try {
      const result = await runScriptGenerationResume(
        {
          demoBrief: { keyProductFeatures: ["article feed"] },
          normalizedSupportingDocuments: [],
          opencodeSessionID: "session_prepare_123",
          preparationManifest: preparationManifest(),
          preparationWorkspaceId: "daytona_workspace",
          repoUrl: "https://github.com/example/app",
          runDirectory: outputRoot,
          validation: {
            blockedNetworkAttempts: [],
            browserUrl: "https://preview.example.test/",
            logs: ["validated"],
            status: "succeeded",
            warnings: [],
          },
        },
        {
          preparationWorkspace: fakePreparationWorkspaceHandle(),
          scriptGenerationAgent: agent,
        },
        { rawOpenCodeLogPath: join(outputRoot, "scriptgen-raw.jsonl") },
      );

      expect(calls).toEqual([
        {
          opencodeSessionID: "session_prepare_123",
          repoUrl: "https://github.com/example/app",
          workspaceId: "daytona_workspace",
        },
      ]);
      expect(result).toMatchObject({
        rawOpenCodeLogPath: join(outputRoot, "scriptgen-raw.jsonl"),
        scriptPath: join(outputRoot, "video-script-package.json"),
        status: "succeeded",
      });
      await expect(readJsonFile(result.scriptPath)).resolves.toMatchObject({
        scriptId: "script_test",
      });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function fakePreparationWorkspaceHandle() {
  return {
    async destroy() {},
    id: "daytona_workspace",
    workspace: {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async getPreviewUrl() {
        return "https://preview.example.test/";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    },
  };
}

function preparationManifest() {
  return {
    assumptions: [],
    createdFiles: [],
    demoCommand: "npm run demo",
    diffArtifactId: "diff",
    existingDemoEvidence: [],
    mockedServices: [],
    modifiedFiles: [],
    repoUrl: "https://github.com/example/app",
    risks: [],
    scriptGenerationContext: [],
    setupSummary: "Prepared app.",
    status: "adapted-existing-demo" as const,
    url: "http://localhost:3000/",
    workspaceId: "workspace_123",
  };
}

function scriptPackage() {
  return {
    assumptions: [],
    demoPlan: {
      featureOrder: ["article feed"],
      narrative: "Show the article feed.",
      risks: [],
    },
    demoPlaywrightScript:
      "await setup(async () => {}); await scene('scene_feed', async () => {});",
    exploration: {
      assumptions: [],
      productSurfaces: ["article feed"],
      summary: "Prepared app.",
    },
    format: "16:9" as const,
    presentation: {
      music: { enabled: true as const, trackId: "clean" as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Article feed is visible.",
        humanReadableDescription: "Show the article feed.",
        id: "scene_feed",
      },
    ],
    scriptId: "script_test",
    title: "Demo",
    version: 1,
  };
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

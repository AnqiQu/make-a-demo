import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeScriptGeneration } from "./daytona-opencode-script-generation";

describe("DaytonaOpenCodeScriptGeneration", () => {
  it("resumes the Repo Preparation OpenCode session and returns an interactive Demo Script", async () => {
    const events: unknown[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(result.scenes[0]).toMatchObject({
      expectedVisibleOutcome: "Filtered demo articles are visible.",
      id: "scene_feed",
    });
    expect(result.demoPlan.featureOrder).toEqual(["article feed"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
        }),
      ]),
    );
    expect(events).not.toEqual(
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
    expect(openCodeCommand).toContain("Do not use real-time network access");
    expect(openCodeCommand).toContain("fetch");
    expect(openCodeCommand).toContain("waitForResponse");
    expect(openCodeCommand).toContain("Only use the MakeADemo Capture SDK");
    expect(openCodeCommand).not.toContain("OPENAI_API_KEY");
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 starting in session session_prepare_123.",
    );
    expect(stdout.join("\n")).toContain(
      "Script Generation OpenCode attempt 1 produced a Demo Script candidate.",
    );
  });

  it("mirrors Script Generation OpenCode output into the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      onStderr: (chunk) => stderr.push(chunk),
      onStdout: (chunk) => stdout.push(chunk),
      providerID: "openai",
    });

    await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
    });

    expect(stdout).toEqual(
      expect.arrayContaining([
        expect.stringContaining("script generation output"),
      ]),
    );
    expect(stderr).toEqual(["script generation warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            channel: "stdout",
            event: "opencode.output",
            raw: "script generation output",
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            channel: "stderr",
            event: "opencode.output",
            raw: "script generation warning",
            stage: "script-generation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("opencode-activity.jsonl") },
      ]),
    );
  });

  it("repairs static placeholder Demo Scripts in the same OpenCode session", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
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
    expect(openCodeCommands[1]).toContain("--session 'session_prepare_123'");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: "demoPlaywrightScript contains placeholder actions",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("keeps Script Generation retry reasons concise after OpenCode failures", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      maxAttempts: 2,
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.generateScriptPackage({
      ...scriptGenerationInput(),
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [interactivePackage()], {
        firstOpenCodeFailure: {
          stderr: "very verbose stderr that should stay on the failed attempt",
          stdout: "very verbose stdout that should stay on the failed attempt",
        },
      }),
    });

    expect(result.scriptId).toBe("script_conduit");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.opencode-attempt.failed",
            reason: expect.stringContaining("very verbose stderr"),
            stage: "script-generation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "script-generation.retrying",
            nextAttempt: 2,
            reason: "OpenCode Script Generation exited with 1.",
            stage: "script-generation",
          }),
        },
      ]),
    );
  });

  it("sends Capture Path Validation failure evidence back to the same OpenCode session for repair", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.repairCapturePathFailure({
      attempt: 1,
      failure: {
        blockedNetworkAttempts: [],
        diagnosticsLogPath:
          "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl",
        failedSceneId: "scene_feed",
        failureReason:
          "Scene scene_feed failed during Capture Path Validation.",
        logs: ["locator failed: getByRole('button', { name: /react/i })"],
        scriptPath: ".makeademo-capture-path-validation-runs/run/scene_feed.ts",
        stderrPath:
          ".makeademo-capture-path-validation-runs/run/scene_feed.stderr.log",
        status: "failed",
        warnings: [],
      },
      opencodeSessionID: "session_prepare_123",
      preparationManifest: scriptGenerationInput().preparationManifest,
      preparationWorkspace: workspaceHandle(events, [interactivePackage()]),
      repoUrl: "https://github.com/example/conduit",
      demoScriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
    });

    expect(result.demoScriptPackage.scriptId).toBe("script_conduit");
    const openCodeCommand = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(openCodeCommand).toContain("--session 'session_prepare_123'");
    expect(openCodeCommand).toContain("Do not use real-time network access");
    expect(openCodeCommand).toContain("Only use the MakeADemo Capture SDK");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.opencode-attempt.started",
            stage: "capture-path-repair",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.demo-script.succeeded",
            stage: "capture-path-repair",
          }),
        },
      ]),
    );
  });

  it("rejects repaired Demo Scripts that still lack visible Playwright assertions", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await expect(
      agent.repairCapturePathFailure({
        attempt: 1,
        failure: {
          blockedNetworkAttempts: [],
          failedSceneId: "scene_feed",
          failureReason:
            "Scene scene_feed must include a visible Playwright assertion before it ends.",
          logs: [
            "Scene scene_feed must include a visible Playwright assertion before it ends.",
          ],
          status: "failed",
          warnings: [],
        },
        opencodeSessionID: "session_prepare_123",
        preparationManifest: scriptGenerationInput().preparationManifest,
        preparationWorkspace: workspaceHandle(events, [
          {
            ...interactivePackage(),
            demoPlaywrightScript: [
              "import { setup, scene } from './makeademo-capture-sdk';",
              "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });",
              "await scene('scene_feed', async ({ page, expect }) => {",
              "  await page.getByText('Global Feed').click();",
              "  expect(await page.getByText('demo').innerText()).toBe('demo');",
              "});",
            ].join("\n"),
          },
        ]),
        repoUrl: "https://github.com/example/conduit",
        demoScriptPackage: {
          ...interactivePackage(),
          assumptions: [],
          demoPlan: {
            featureOrder: ["article feed"],
            narrative: "Conduit article feed demo",
            risks: [],
          },
          exploration: {
            assumptions: [],
            productSurfaces: [],
            summary: "Prepared Conduit with local articles.",
          },
        },
      }),
    ).rejects.toThrow(
      "Scene scene_feed must include a visible Playwright assertion before it ends.",
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "capture-path-repair.script-package.invalid",
            reason:
              "Scene scene_feed must include a visible Playwright assertion before it ends.",
            stage: "capture-path-repair",
          }),
        },
      ]),
    );
  });

  it("reviews Draft Composites in the same OpenCode session with uploaded evidence", async () => {
    const events: unknown[] = [];
    const reviewDirectory = await mkdtemp(join(tmpdir(), "makeademo-review-"));
    const draftPath = join(reviewDirectory, "draft.mp4");
    const rawTakePath = join(reviewDirectory, "raw.webm");
    const contactSheetPath = join(reviewDirectory, "contact-sheet.jpg");
    const sampledFramePath = join(reviewDirectory, "sample-001.jpg");
    await writeFile(draftPath, "draft video");
    await writeFile(rawTakePath, "raw take");
    await writeFile(contactSheetPath, "contact sheet");
    await writeFile(sampledFramePath, "sampled frame");
    const agent = new DaytonaOpenCodeScriptGeneration({
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const decision = await agent.reviewDraftComposite({
      attempt: 1,
      captureManifest: {
        baseUrl: "https://preview.example.test/",
        createdAt: "2026-01-01T00:00:00.000Z",
        keepTemp: true,
        manifestPath: join(reviewDirectory, "capture-manifest.json"),
        qualityFindings: [],
        rawTakePath,
        runDirectory: reviewDirectory,
        runId: "capture-1",
        scenes: [
          {
            durationSeconds: 5,
            sceneId: "scene_feed",
            sectionId: "demo-script",
            videoPath: join(reviewDirectory, "scene-feed.webm"),
          },
        ],
        scriptId: "script_conduit",
        temporary: true,
        title: "Conduit article feed demo",
      },
      derivedEvidence: {
        contactSheetPaths: [contactSheetPath],
        draftDurationSeconds: 5,
        ffmpegFindings: ["ffprobe audio probe found no audio stream"],
        markerSummary: [{ durationSeconds: 5, sceneId: "scene_feed" }],
        qualityFindings: [],
        rawDraftCompositePath: draftPath,
        rawTakePath,
        sampledFramePaths: [sampledFramePath],
      },
      draftComposite: {
        createdAt: "2026-01-01T00:00:00.000Z",
        durationInFrames: 150,
        fps: 30,
        manifestPath: join(reviewDirectory, "composite-manifest.json"),
        outputVideoPath: draftPath,
        renderPlanPath: join(reviewDirectory, "render-plan.json"),
        runDirectory: reviewDirectory,
        runId: "composite-1",
        scriptId: "script_conduit",
        title: "Conduit article feed demo",
        viewUrl: "file:///tmp/draft.mp4",
      },
      opencodeSessionID: "session_prepare_123",
      preparationWorkspace: workspaceHandle(events, [
        {
          decision: "repair",
          reason: "Missing payoff.",
          repairScope: "demo-script",
        },
      ]),
      scriptPackage: {
        ...interactivePackage(),
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Conduit article feed demo",
          risks: [],
        },
        exploration: {
          assumptions: [],
          productSurfaces: [],
          summary: "Prepared Conduit with local articles.",
        },
      },
    });

    expect(decision).toEqual({
      decision: "repair",
      reason: "Missing payoff.",
      repairScope: "demo-script",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          uploadFiles: [
            {
              destinationPath: "/workspace/.makeademo/draft-review/draft.mp4",
              sourcePath: draftPath,
            },
            {
              destinationPath: "/workspace/.makeademo/draft-review/raw.webm",
              sourcePath: rawTakePath,
            },
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/contact-sheet.jpg",
              sourcePath: contactSheetPath,
            },
            {
              destinationPath:
                "/workspace/.makeademo/draft-review/sample-001.jpg",
              sourcePath: sampledFramePath,
            },
          ],
        },
        expect.objectContaining({
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
    expect(openCodeCommand).toContain("Draft Composite Review");
    expect(openCodeCommand).toContain("/workspace/.makeademo/draft-review");
    expect(openCodeCommand).toContain("ffmpeg/ffprobe");
    expect(openCodeCommand).toContain("markerSummary");
    expect(openCodeCommand).toContain("scene_feed");
    expect(openCodeCommand).toContain(
      "ffprobe audio probe found no audio stream",
    );
    expect(openCodeCommand).toContain(draftPath);
    expect(openCodeCommand).toContain(rawTakePath);
    expect(openCodeCommand).toContain(contactSheetPath);
    expect(openCodeCommand).toContain(sampledFramePath);
    expect(openCodeCommand).toContain("rawDraftCompositePath");
    expect(openCodeCommand).toContain("contactSheetPaths");
    expect(openCodeCommand).toContain("sampledFramePaths");
    expect(openCodeCommand).toContain("ffmpegFindings");
  });
});

function workspaceHandle(
  events: unknown[],
  artifacts: unknown[],
  helperOptions: {
    firstOpenCodeFailure?: { stderr: string; stdout: string };
  } = {},
) {
  let latestArtifact: unknown;
  let openCodeAttempt = 0;
  const workspace: PreparationWorkspace = {
    async execute(command, commandOptions) {
      events.push({
        execute: command,
        ...(commandOptions?.env?.OPENCODE_CONFIG_DIR === undefined
          ? {}
          : { configDir: commandOptions.env.OPENCODE_CONFIG_DIR }),
        ...(commandOptions?.onStdout === undefined ? {} : { streaming: true }),
      });

      if (command.includes("opencode run")) {
        openCodeAttempt += 1;
        if (openCodeAttempt === 1 && helperOptions.firstOpenCodeFailure) {
          return {
            exitCode: 1,
            stderr: helperOptions.firstOpenCodeFailure.stderr,
            stdout: helperOptions.firstOpenCodeFailure.stdout,
          };
        }
        latestArtifact = artifacts.shift();
        commandOptions?.onStdout?.("script generation output");
        commandOptions?.onStderr?.("script generation warning");
        return { exitCode: 0, stderr: "", stdout: "generated" };
      }

      if (command.includes("preparation-manifest.json")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(scriptGenerationInput().preparationManifest),
        };
      }

      if (command.includes("draft-composite-review.json")) {
        return latestArtifact === undefined
          ? { exitCode: 1, stderr: "missing review", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: JSON.stringify(latestArtifact) };
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
    async uploadFiles(files) {
      events.push({ uploadFiles: files });
    },
    async writeSandboxLog(entry) {
      events.push({ sandboxLog: entry });
    },
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
  };
}

function interactivePackage() {
  return {
    audio: { enabled: true, music: { id: "clean" as const } },
    demoPlaywrightScript:
      "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl }) => { await page.goto(baseUrl + '#/'); });\nawait scene('scene_feed', async ({ page, expect }) => {\n  await page.getByText('Global Feed').click();\n  await page.getByText('demo').click();\n  await expect(page.getByText('demo')).toBeVisible();\n});",
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "clean" as const },
      textOverlays: [
        {
          content: "Filter the global feed",
          font: "Inter" as const,
          position: "bottom-left" as const,
          sceneId: "scene_feed",
          size: "medium" as const,
        },
      ],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Filtered demo articles are visible.",
        humanReadableDescription: "Filter the global feed by a popular tag.",
        id: "scene_feed",
      },
    ],
    scriptId: "script_conduit",
    title: "Conduit article feed demo",
    version: 1,
  };
}

function staticPlaceholderPackage() {
  return {
    ...interactivePackage(),
    demoPlaywrightScript:
      "await page.goto(baseUrl);\nawait expect(page.locator('body')).toContainText(/\\S/);\nawait page.locator('body').evaluate(() => document.body.setAttribute('data-makeademo-feature', 'feed'));\nawait page.waitForTimeout(2500);",
  };
}

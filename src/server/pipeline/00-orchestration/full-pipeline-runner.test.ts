import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "../07-compositing/composite-video";
import { runFullPipelineJob } from "./full-pipeline-runner";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runFullPipelineJob", () => {
  it("runs pre-capture, captures scenes from the validated browser URL, and composites the final video", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const calls: string[] = [];

    try {
      const result = await runFullPipelineJob(
        {
          demoBrief: { keyProductFeatures: ["article feed"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 100 },
          },
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        preCaptureDependencies(calls),
        {
          async captureScenes(input) {
            calls.push(`capture:${input.baseUrl}`);
            const manifest: CaptureManifest = {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [],
              scriptId: "script_test",
              temporary: true,
              title: "Demo",
            };

            return manifest;
          },
          async compositeVideo(input) {
            calls.push(`composite:${input.captureManifestPath}`);
            if (input.scriptPath === undefined) {
              throw new Error("scriptPath is required");
            }
            expect(
              JSON.parse(await readFile(input.scriptPath, "utf8")),
            ).toMatchObject({ scriptId: "script_test" });
            const manifest: CompositedVideoManifest = {
              createdAt: "2026-01-01T00:00:00.000Z",
              durationInFrames: 150,
              fps: 30,
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
              runDirectory: outputRoot,
              runId: "composite",
              scriptId: "script_test",
              title: "Demo",
              viewUrl: "file:///tmp/final-video.mp4",
            };

            return manifest;
          },
          outputRoot,
          rawOpenCodeLogPath: join(
            outputRoot,
            "full-run",
            "opencode-raw-output.jsonl",
          ),
          runId: "full-run",
        },
      );

      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture:https://preview.example.test/",
        `composite:${join(outputRoot, "capture-manifest.json")}`,
      ]);
      expect(result.status).toBe("succeeded");
      expect(result.finalVideo.outputVideoPath).toBe(
        join(outputRoot, "final-video.mp4"),
      );
      expect(result.resultPath).toBe(
        join(outputRoot, "full-run", "full-pipeline-result.json"),
      );
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        artifacts: {
          captureManifestPath: join(outputRoot, "capture-manifest.json"),
          finalVideoPath: join(outputRoot, "final-video.mp4"),
          generatedScriptPath: join(
            outputRoot,
            "full-run",
            "video-script-package.json",
          ),
          logPath: join(outputRoot, "full-run", "pipeline-log.jsonl"),
          rawOpenCodeLogPath: join(
            outputRoot,
            "full-run",
            "opencode-raw-output.jsonl",
          ),
          scriptGenerationResumePath: join(
            outputRoot,
            "full-run",
            "script-generation-resume.json",
          ),
        },
        status: "succeeded",
      });
      await expect(
        readJsonFile(
          join(outputRoot, "full-run", "script-generation-resume.json"),
        ),
      ).resolves.toMatchObject({
        demoBrief: { keyProductFeatures: ["article feed"] },
        opencodeSessionID: "session_prepare_123",
        preparationWorkspaceId: "daytona_workspace",
        repoUrl: "https://github.com/example/app",
        runDirectory: join(outputRoot, "full-run"),
        validation: { browserUrl: "https://preview.example.test/" },
      });
      expect(result.logPath).toBe(
        join(outputRoot, "full-run", "pipeline-log.jsonl"),
      );
      await expect(
        stat(join(outputRoot, "full-run", "video-script-package.json")),
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("fails before capture when pre-capture did not produce a validated browser URL", async () => {
    await expect(
      runFullPipelineJob(
        {
          demoBrief: { keyProductFeatures: ["article feed"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 100 },
          },
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        preCaptureDependencies([], { includeBrowserUrl: false }),
        {
          async captureScenes() {
            throw new Error("capture should not run");
          },
          async compositeVideo() {
            throw new Error("compositing should not run");
          },
        },
      ),
    ).rejects.toThrow("pre-capture did not return a validated browser URL");
  });

  it("writes a local result file with failure details when pre-capture fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));

    try {
      await expect(
        runFullPipelineJob(
          {
            demoBrief: { keyProductFeatures: ["article feed"] },
            normalizedSupportingDocuments: [],
            repoSecurity: {
              files: [{ path: "package.json", text: "{}" }],
              repoStats: { fileCount: 1, sizeBytes: 100 },
            },
            repoUrl: "https://github.com/example/app",
            workspaceId: "workspace_123",
          },
          {
            async generateScriptPackage() {
              throw new Error("script generation should not run");
            },
            async prepareRepo() {
              return {
                fallbackPrompt:
                  "Repo Preparation agent timed out after 600000ms. Inspect the retained Daytona workspace debug log.",
                status: "failed",
              };
            },
            screenRepoSecurity() {
              return { rejections: [], status: "passed", warnings: [] };
            },
            async validateProject() {
              throw new Error("validation should not run");
            },
          },
          {
            outputRoot,
            rawOpenCodeLogPath: join(
              outputRoot,
              "failed-run",
              "opencode-raw-output.jsonl",
            ),
            runId: "failed-run",
          },
        ),
      ).rejects.toThrow("pre-capture failed with status preparation-failed");

      await expect(
        readJsonFile(
          join(outputRoot, "failed-run", "full-pipeline-result.json"),
        ),
      ).resolves.toMatchObject({
        artifacts: {
          logPath: join(outputRoot, "failed-run", "pipeline-log.jsonl"),
          rawOpenCodeLogPath: join(
            outputRoot,
            "failed-run",
            "opencode-raw-output.jsonl",
          ),
        },
        failure: {
          blockers: [
            "Repo Preparation agent timed out after 600000ms. Inspect the retained Daytona workspace debug log.",
          ],
          suggestedChanges: [],
        },
        status: "preparation-failed",
      });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("writes the Script Generation resume artifact before running Script Generation", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));

    try {
      await expect(
        runFullPipelineJob(
          {
            demoBrief: { keyProductFeatures: ["article feed"] },
            normalizedSupportingDocuments: [],
            repoSecurity: {
              files: [{ path: "package.json", text: "{}" }],
              repoStats: { fileCount: 1, sizeBytes: 100 },
            },
            repoUrl: "https://github.com/example/app",
            workspaceId: "workspace_123",
          },
          {
            async generateScriptPackage() {
              throw new Error("ScriptGen stalled before artifact output");
            },
            async prepareRepo() {
              return {
                manifest: {
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
                  status: "adapted-existing-demo",
                  url: "http://localhost:3000/",
                  workspaceId: "workspace_123",
                },
                opencodeSessionID: "session_prepare_123",
                status: "succeeded",
                validation: {
                  blockedNetworkAttempts: [],
                  browserUrl: "https://preview.example.test/",
                  logs: ["validated"],
                  status: "succeeded",
                  warnings: [],
                },
                workspace: fakePreparationWorkspaceHandle(),
              };
            },
            screenRepoSecurity() {
              return { rejections: [], status: "passed", warnings: [] };
            },
            async validateProject() {
              throw new Error("validation should not rerun");
            },
          },
          { outputRoot, runId: "scriptgen-fails" },
        ),
      ).rejects.toThrow("ScriptGen stalled before artifact output");

      await expect(
        readJsonFile(
          join(outputRoot, "scriptgen-fails", "script-generation-resume.json"),
        ),
      ).resolves.toMatchObject({
        opencodeSessionID: "session_prepare_123",
        preparationWorkspaceId: "daytona_workspace",
        validation: { browserUrl: "https://preview.example.test/" },
      });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("writes the full pipeline progress to the log callback and JSONL log file", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const messages: string[] = [];

    try {
      const result = await runFullPipelineJob(
        {
          demoBrief: { keyProductFeatures: ["article feed"] },
          normalizedSupportingDocuments: [],
          repoSecurity: {
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 100 },
          },
          repoUrl: "https://github.com/example/app",
          workspaceId: "workspace_123",
        },
        preCaptureDependencies([]),
        {
          async captureScenes(input) {
            return {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [
                {
                  durationSeconds: 5,
                  sceneId: "scene_article_feed",
                  sectionId: "section_test",
                  videoPath: join(outputRoot, "scene.webm"),
                },
              ],
              scriptId: "script_test",
              temporary: true,
              title: "Demo",
            };
          },
          async compositeVideo() {
            return {
              createdAt: "2026-01-01T00:00:00.000Z",
              durationInFrames: 150,
              fps: 30,
              manifestPath: join(outputRoot, "composite-manifest.json"),
              outputVideoPath: join(outputRoot, "final-video.mp4"),
              renderPlanPath: join(outputRoot, "render-plan.json"),
              runDirectory: outputRoot,
              runId: "composite",
              scriptId: "script_test",
              title: "Demo",
              viewUrl: "file:///tmp/final-video.mp4",
            };
          },
          onLog: (entry) => messages.push(entry.message),
          outputRoot,
          runId: "full-run",
        },
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          "Full pipeline started.",
          "repo-security-screen started.",
          "repo-preparation started.",
          "script-generation succeeded.",
          "Script package generated: 1 section(s), 1 scene(s), 3s estimated.",
          "Footage Capture started.",
          "Footage Capture succeeded: 1 scene video(s).",
          "Compositing started.",
          "Compositing succeeded.",
          "Full pipeline succeeded.",
        ]),
      );

      const logEntries = (await readFile(result.logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(logEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "script-package-written",
            message:
              "Script package generated: 1 section(s), 1 scene(s), 3s estimated.",
            scriptPath: result.scriptPath,
          }),
          expect.objectContaining({
            event: "capture-succeeded",
            manifestPath: join(outputRoot, "capture-manifest.json"),
            sceneCount: 1,
          }),
          expect.objectContaining({
            event: "compositing-succeeded",
            outputVideoPath: join(outputRoot, "final-video.mp4"),
            viewUrl: "file:///tmp/final-video.mp4",
          }),
          expect.objectContaining({
            event: "result-written",
            message: "Full pipeline result written.",
            resultPath: result.resultPath,
          }),
        ]),
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function preCaptureDependencies(
  calls: string[],
  options: { includeBrowserUrl?: boolean } = { includeBrowserUrl: true },
): PipelineOrchestratorDependencies {
  return {
    async generateScriptPackage() {
      calls.push("script-generation");
      return {
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Show the article feed.",
          risks: [],
        },
        demoPlaywrightScript:
          "await setup(async () => {}); await scene('scene_article_feed', async () => {});",
        exploration: {
          assumptions: [],
          productSurfaces: ["article feed"],
          summary: "Prepared app.",
        },
        format: "16:9",
        presentation: {
          music: { enabled: true as const, trackId: "clean" as const },
          textOverlays: [],
          transitions: [],
        },
        scenes: [
          {
            expectedVisibleOutcome: "Article feed is visible.",
            humanReadableDescription: "Show article feed.",
            id: "scene_article_feed",
          },
        ],
        scriptId: "script_test",
        title: "Demo",
        version: 1,
      };
    },
    async prepareRepo() {
      calls.push("repo-preparation");
      return {
        manifest: {
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
          status: "adapted-existing-demo",
          url: "http://localhost:3000/",
          workspaceId: "workspace_123",
        },
        opencodeSessionID: "session_prepare_123",
        status: "succeeded",
        validation: {
          blockedNetworkAttempts: [],
          ...(options.includeBrowserUrl === false
            ? {}
            : { browserUrl: "https://preview.example.test/" }),
          logs: ["validated"],
          status: "succeeded",
          warnings: [],
        },
        workspace: fakePreparationWorkspaceHandle(),
      };
    },
    screenRepoSecurity() {
      calls.push("repo-security-screen");
      return { rejections: [], status: "passed", warnings: [] };
    },
    async validateProject() {
      throw new Error("validation should not rerun");
    },
  };
}

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

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

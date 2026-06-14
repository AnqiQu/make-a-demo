import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../../pipeline/06-capture/capture-scenes";
import type { CompositedVideoManifest } from "../../pipeline/07-compositing/composite-video";
import { runFullPipelineJob } from "./full-pipeline-runner";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runFullPipelineJob", () => {
  it("runs Stage 1, captures scenes from the validated browser URL, and composites the final video", async () => {
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
        stage1Dependencies(calls),
        {
          async captureScenes(input) {
            calls.push(`capture:${input.baseUrl}`);
            const manifest: CaptureManifest = {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
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
        },
        status: "succeeded",
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

  it("fails before capture when Stage 1 did not produce a validated browser URL", async () => {
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
        stage1Dependencies([], { includeBrowserUrl: false }),
        {
          async captureScenes() {
            throw new Error("capture should not run");
          },
          async compositeVideo() {
            throw new Error("compositing should not run");
          },
        },
      ),
    ).rejects.toThrow("Stage 1 did not return a validated browser URL");
  });

  it("writes a local result file with failure details when Stage 1 fails", async () => {
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
      ).rejects.toThrow("Stage 1 failed with status preparation-failed");

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
        stage1Dependencies([]),
        {
          async captureScenes(input) {
            return {
              baseUrl: input.baseUrl,
              createdAt: "2026-01-01T00:00:00.000Z",
              keepTemp: true,
              manifestPath: join(outputRoot, "capture-manifest.json"),
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
          "Script package generated: 1 section(s), 1 scene(s), 5s estimated.",
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
              "Script package generated: 1 section(s), 1 scene(s), 5s estimated.",
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

function stage1Dependencies(
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
        estimatedDurationSeconds: 5,
        exploration: {
          assumptions: [],
          productSurfaces: ["article feed"],
          summary: "Prepared app.",
        },
        format: "16:9",
        scriptId: "script_test",
        sections: [
          {
            id: "section_test",
            scenes: [
              {
                description: "Show article feed.",
                durationSeconds: 5,
                events: ["Open app"],
                id: "scene_article_feed",
                playwrightSceneId: "scene_article_feed",
                playwrightScript: "await page.goto(baseUrl);",
                type: "playwright-recording",
              },
            ],
            title: "Article Feed",
          },
        ],
        title: "Demo",
        validation: {
          blockedNetworkAttempts: [],
          browserUrl: "https://preview.example.test/",
          logs: ["validated"],
          status: "succeeded",
          warnings: [],
        },
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

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

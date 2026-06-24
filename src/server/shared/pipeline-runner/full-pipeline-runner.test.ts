import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../../pipeline/06-footage-capture/capture-scenes";
import type { CompositedVideoManifest } from "../../pipeline/07-compositing/composite-video";
import { runFullPipelineJob } from "./full-pipeline-runner";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

describe("runFullPipelineJob", () => {
  it("runs Stage 1, captures scenes from the capture-path browser URL, and composites the final video", async () => {
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
            expect(input.scriptPath).toBeDefined();
            expect(
              JSON.parse(await readFile(input.scriptPath as string, "utf8")),
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
          async prepareFreshCaptureState(input) {
            calls.push(`fresh-capture:${input.browserUrl}`);
            return { browserUrl: "https://fresh-preview.example.test/" };
          },
          rawOpenCodeLogPath: join(
            outputRoot,
            "full-run",
            "opencode-raw-output.jsonl",
          ),
          async reviewDraftComposite(input) {
            calls.push(`review:${input.attempt}:${input.opencodeSessionID}`);
            return acceptDraftComposite();
          },
          runId: "full-run",
        },
      );

      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation",
        "fresh-capture:https://preview.example.test/",
        "capture:https://fresh-preview.example.test/",
        `composite:${join(outputRoot, "capture-manifest.json")}`,
        "review:1:session_prepare_123",
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
          generatedScriptPath: join(outputRoot, "full-run", "demo-script.json"),
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
      });
      expect(result.logPath).toBe(
        join(outputRoot, "full-run", "pipeline-log.jsonl"),
      );
      await expect(
        stat(join(outputRoot, "full-run", "demo-script.json")),
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("stores the generated script on the Demo Request when durable script persistence is configured", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const savedScripts: unknown[] = [];

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
            expect(input.scriptPath).toBeUndefined();
            expect(input.scriptPackage).toMatchObject({
              scriptId: "script_test",
            });
            return {
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
          },
          async compositeVideo(input) {
            expect(input.scriptPath).toBeUndefined();
            expect(input.scriptPackage).toMatchObject({
              scriptId: "script_test",
            });
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
          context: {
            demoRequestId: "demo-request-123",
            projectId: "project-123",
          },
          demoRequestScriptStore: {
            async saveGeneratedScript(input) {
              savedScripts.push(input);
            },
          },
          outputRoot,
          reviewDraftComposite: acceptDraftComposite,
          runId: "full-run",
        },
      );

      expect(savedScripts).toEqual([
        {
          demoRequestId: "demo-request-123",
          script: expect.objectContaining({
            scriptId: "script_test",
            title: "Demo",
          }),
        },
      ]);
      expect(result.scriptPath).toBeUndefined();
      await expect(
        stat(join(outputRoot, "full-run", "demo-script.json")),
      ).rejects.toThrow();
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        artifacts: {
          generatedScriptDemoRequestId: "demo-request-123",
        },
        status: "succeeded",
      });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("fails before capture when Capture Path Validation did not produce a browser URL", async () => {
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
    ).rejects.toThrow("Capture Path Validation did not return a browser URL");
  });

  it("fails default Footage Capture when no fresh-state reset is configured", async () => {
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
          stage1Dependencies([]),
          {
            async reviewDraftComposite() {
              return acceptDraftComposite();
            },
            outputRoot,
            runId: "full-run",
          },
        ),
      ).rejects.toThrow(
        "Footage Capture requires a fresh deterministic app-state reset before recording.",
      );
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
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
            async validateCapturePath() {
              throw new Error("capture path validation should not run");
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

  it("reports Capture Path Validation exhaustion as a MakeADemo issue instead of preparation advice", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousRepairAttempts =
      process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS;
    process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS = "0";

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
            ...stage1Dependencies([]),
            async validateCapturePath() {
              return {
                blockedNetworkAttempts: [],
                browserUrl: "https://preview.example.test/",
                failedSceneId: "scene_article_feed",
                failureReason: "Generated selector did not match.",
                logs: ["selector failed"],
                status: "failed",
                warnings: ["Retry with more seeded data."],
              };
            },
          },
          {
            async captureScenes() {
              throw new Error("capture should not run");
            },
            async compositeVideo() {
              throw new Error("compositing should not run");
            },
            outputRoot,
            runId: "capture-path-fails",
          },
        ),
      ).rejects.toThrow(
        "Stage 1 failed with status capture-path-validation-failed",
      );

      await expect(
        readJsonFile(
          join(outputRoot, "capture-path-fails", "full-pipeline-result.json"),
        ),
      ).resolves.toMatchObject({
        failure: {
          blockers: [
            "Capture Path Validation failed. Please report this issue to MakeADemo.",
          ],
        },
        status: "capture-path-validation-failed",
      });
    } finally {
      if (previousRepairAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_CAPTURE_PATH_REPAIR_ATTEMPTS =
          previousRepairAttempts;
      }
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
                workspace: fakePreparationWorkspaceHandle(),
              };
            },
            screenRepoSecurity() {
              return { rejections: [], status: "passed", warnings: [] };
            },
            async validateCapturePath() {
              throw new Error(
                "capture path validation should not run after script generation fails",
              );
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
              qualityFindings: [],
              runDirectory: outputRoot,
              runId: "capture",
              scenes: [
                {
                  durationSeconds: 5,
                  sceneId: "scene_article_feed",
                  sectionId: "demo-script",
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
          reviewDraftComposite: acceptDraftComposite,
          runId: "full-run",
        },
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          "Full pipeline started.",
          "repo-security-screen started.",
          "repo-preparation started.",
          "script-generation succeeded.",
          "capture-path-validation succeeded.",
          "Demo Script generated: 1 scene(s).",
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
            event: "demo-script-written",
            message: "Demo Script generated: 1 scene(s).",
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

  it("reviews the Draft Composite, repairs rejected drafts, and returns the accepted retry", async () => {
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
            calls.push(`capture:${input.runId}`);
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            calls.push(`composite:${input.runId}`);
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async reviewDraftComposite(input) {
            calls.push(
              `review:${input.attempt}:${input.draftComposite.viewUrl}`,
            );
            return input.attempt === 1
              ? {
                  decision: "repair",
                  reason: "First draft repeats setup.",
                  repairScope: "demo-script",
                }
              : { decision: "accept", reason: "Retry is concise." };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.finalVideo.runId).toBe("composite-2");
      expect(result.draftCompositeReview).toEqual({
        attempts: 2,
        findings: [],
        status: "accepted",
        warnings: [],
      });
      await expect(
        readJsonFile(result.finalVideo.manifestPath),
      ).resolves.toMatchObject({
        draftCompositeReview: {
          attempts: 2,
          findings: [],
          status: "accepted",
          warnings: [],
        },
      });
      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation",
        "capture:capture-1",
        "composite:composite-1",
        "review:1:file:///tmp/composite-1.mp4",
        "capture:capture-2",
        "composite:composite-2",
        "review:2:file:///tmp/composite-2.mp4",
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("repairs Demo Script scoped Draft Composite rejections before recapturing", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const calls: string[] = [];
    const dependencies = stage1Dependencies(calls);
    dependencies.repairCapturePathFailure = async (input) => {
      calls.push(
        `draft-repair:${input.attempt}:${input.demoScriptPackage.scriptId}:${input.opencodeSessionID}`,
      );
      return {
        preparationManifest: input.preparationManifest,
        demoScriptPackage: {
          ...input.demoScriptPackage,
          scriptId: "script_repaired_after_review",
        },
      };
    };

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
        dependencies,
        {
          async captureScenes(input) {
            const scriptPackage = input.scriptPackage as { scriptId: string };
            calls.push(
              `capture:${input.runId}:${scriptPackage.scriptId}:${input.baseUrl}`,
            );
            return {
              ...captureManifest(outputRoot, input.runId ?? "capture"),
              scriptId: scriptPackage.scriptId,
            };
          },
          async compositeVideo(input) {
            const scriptPackage = input.scriptPackage as { scriptId: string };
            calls.push(`composite:${input.runId}:${scriptPackage.scriptId}`);
            return {
              ...compositeManifest(outputRoot, input.runId ?? "composite"),
              scriptId: scriptPackage.scriptId,
            };
          },
          async reviewDraftComposite(input) {
            calls.push(
              `review:${input.attempt}:${input.scriptPackage.scriptId}:${input.opencodeSessionID}`,
            );
            return input.attempt === 1
              ? {
                  decision: "repair",
                  reason: "Tighten the Demo Script pacing.",
                  repairScope: "demo-script",
                }
              : { decision: "accept", reason: "Repaired script is concise." };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          async prepareFreshCaptureState(input) {
            calls.push(`fresh-capture:${input.attempt}:${input.browserUrl}`);
            return {
              browserUrl: `https://fresh-preview-${input.attempt}.example.test/`,
            };
          },
          runId: "full-run",
        },
      );

      expect(result.stage1.demoScriptPackage.scriptId).toBe(
        "script_repaired_after_review",
      );
      expect(result.finalVideo.scriptId).toBe("script_repaired_after_review");
      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation",
        "fresh-capture:1:https://preview.example.test/",
        "capture:capture-1:script_test:https://fresh-preview-1.example.test/",
        "composite:composite-1:script_test",
        "review:1:script_test:session_prepare_123",
        "draft-repair:1:script_test:session_prepare_123",
        "capture-path-validation",
        "fresh-capture:2:https://preview.example.test/",
        "capture:capture-2:script_repaired_after_review:https://fresh-preview-2.example.test/",
        "composite:composite-2:script_repaired_after_review",
        "review:2:script_repaired_after_review:session_prepare_123",
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("reruns Stage 1 for workspace-scoped Draft Composite repairs before recapturing", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const calls: string[] = [];
    const dependencies = stage1Dependencies(calls);
    let validationCount = 0;
    dependencies.validateCapturePath = async () => {
      validationCount += 1;
      calls.push(`capture-path-validation:${validationCount}`);
      return {
        blockedNetworkAttempts: [],
        browserUrl:
          validationCount === 1
            ? "https://preview.example.test/"
            : "https://repaired-preview.example.test/",
        logs: ["validated capture path"],
        status: "succeeded",
        warnings: [],
      };
    };

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
        dependencies,
        {
          async captureScenes(input) {
            calls.push(`capture:${input.runId}:${input.baseUrl}`);
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            calls.push(`composite:${input.runId}`);
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async reviewDraftComposite(input) {
            calls.push(`review:${input.attempt}:${input.opencodeSessionID}`);
            return input.attempt === 1
              ? {
                  decision: "repair",
                  reason: "Workspace state needs repair.",
                  repairScope: "workspace",
                }
              : { decision: "accept", reason: "Workspace repair worked." };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.finalVideo.runId).toBe("composite-2");
      expect(calls).toEqual([
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation:1",
        "capture:capture-1:https://preview.example.test/",
        "composite:composite-1",
        "review:1:session_prepare_123",
        "repo-security-screen",
        "repo-preparation",
        "script-generation",
        "capture-path-validation:2",
        "capture:capture-2:https://repaired-preview.example.test/",
        "composite:composite-2",
        "review:2:session_prepare_123",
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("returns the latest Draft Composite with warnings when review repair attempts are exhausted", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "1";

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
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async reviewDraftComposite() {
            return {
              decision: "repair",
              reason: "Draft still lacks visible payoff.",
              repairScope: "demo-script",
            };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.status).toBe("succeeded");
      expect(result.finalVideo.runId).toBe("composite-2");
      expect(result.draftCompositeReview).toEqual({
        attempts: 2,
        findings: [],
        status: "exhausted",
        warnings: [
          "Draft Composite review retry limit exceeded; using latest draft.",
          "Draft Composite review requested repair: Draft still lacks visible payoff.",
        ],
      });
      await expect(readJsonFile(result.resultPath)).resolves.toMatchObject({
        draftCompositeReview: {
          attempts: 2,
          status: "exhausted",
          warnings: [
            "Draft Composite review retry limit exceeded; using latest draft.",
            "Draft Composite review requested repair: Draft still lacks visible payoff.",
          ],
        },
        status: "succeeded",
      });
    } finally {
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("routes deterministic Draft Composite duration failures through the repair loop", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousMaxDuration =
      process.env.MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS;
    process.env.MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS = "4";
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
        stage1Dependencies([]),
        {
          async captureScenes(input) {
            calls.push(`capture:${input.runId}`);
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            calls.push(`composite:${input.runId}`);
            return {
              ...compositeManifest(outputRoot, input.runId ?? "composite"),
              durationInFrames: input.runId === "composite-1" ? 150 : 90,
            };
          },
          async reviewDraftComposite(input) {
            calls.push(
              `review:${input.attempt}:${input.derivedEvidence.qualityFindings.length}`,
            );
            return { decision: "accept" };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.finalVideo.runId).toBe("composite-2");
      expect(result.draftCompositeReview).toEqual({
        attempts: 2,
        findings: [],
        status: "accepted",
        warnings: [],
      });
      expect(calls).toEqual([
        "capture:capture-1",
        "composite:composite-1",
        "review:1:1",
        "capture:capture-2",
        "composite:composite-2",
        "review:2:0",
      ]);
    } finally {
      if (previousMaxDuration === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS",
        );
      } else {
        process.env.MAKEADEMO_MAX_DRAFT_COMPOSITE_SECONDS = previousMaxDuration;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("routes audio and static-footage evidence through the Draft Composite repair loop", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "0";
    const reviewEvidence: unknown[] = [];

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
        stage1Dependencies([], { musicEnabled: true }),
        {
          async captureScenes(input) {
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async inspectDraftCompositeEvidence() {
            return {
              audioPresent: false,
              contactSheetPaths: [join(outputRoot, "contact-sheet.jpg")],
              ffmpegFindings: ["no audio streams found"],
              sampledFramePaths: [join(outputRoot, "frame-001.jpg")],
              staticSceneIds: ["scene_article_feed"],
            };
          },
          async reviewDraftComposite(input) {
            reviewEvidence.push(input.derivedEvidence);
            return { decision: "accept" };
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.draftCompositeReview).toEqual({
        attempts: 1,
        findings: [
          "Draft Composite is missing audio while music is enabled",
          "Scene scene_article_feed contains fully static footage",
        ],
        status: "exhausted",
        warnings: [
          "Draft Composite review retry limit exceeded; using latest draft.",
          "Draft Composite review requested repair: Draft Composite is missing audio while music is enabled; Scene scene_article_feed contains fully static footage",
          "Remaining quality gate: Draft Composite is missing audio while music is enabled",
          "Remaining quality gate: Scene scene_article_feed contains fully static footage",
        ],
      });
      expect(reviewEvidence).toEqual([
        expect.objectContaining({
          contactSheetPaths: [join(outputRoot, "contact-sheet.jpg")],
          ffmpegFindings: ["no audio streams found"],
          qualityFindings: [
            "Draft Composite is missing audio while music is enabled",
            "Scene scene_article_feed contains fully static footage",
          ],
          rawDraftCompositePath: join(outputRoot, "composite-1.mp4"),
          rawTakePath: join(outputRoot, "capture-1-raw.webm"),
          sampledFramePaths: [join(outputRoot, "frame-001.jpg")],
        }),
      ]);
    } finally {
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("routes generated ffmpeg probe failures through review without failing the pipeline", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "0";
    const ffmpegFindings: string[][] = [];

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
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            const manifest = compositeManifest(
              outputRoot,
              input.runId ?? "composite",
            );
            await writeFile(manifest.outputVideoPath ?? "", "not an mp4");
            return manifest;
          },
          async reviewDraftComposite(input) {
            ffmpegFindings.push(input.derivedEvidence.ffmpegFindings);
            return { decision: "accept", reason: "Evidence reviewed." };
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.finalVideo.runId).toBe("composite-1");
      expect(result.draftCompositeReview).toEqual({
        attempts: 1,
        findings: [
          "Scene scene_article_feed static-footage gate could not be verified",
        ],
        status: "exhausted",
        warnings: [
          "Draft Composite review retry limit exceeded; using latest draft.",
          "Draft Composite review requested repair: Scene scene_article_feed static-footage gate could not be verified",
          "Remaining quality gate: Scene scene_article_feed static-footage gate could not be verified",
        ],
      });
      expect(ffmpegFindings[0]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ffmpeg sampled-frame extraction failed"),
          expect.stringContaining("ffmpeg contact-sheet generation failed"),
          expect.stringContaining("ffprobe audio probe failed"),
        ]),
      );
    } finally {
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("keeps missing ffmpeg tools as review evidence instead of failing the pipeline", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    const ffmpegFindings: string[][] = [];

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
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            const manifest = compositeManifest(
              outputRoot,
              input.runId ?? "composite",
            );
            await writeFile(manifest.outputVideoPath ?? "", "draft video");
            return manifest;
          },
          async reviewDraftComposite(input) {
            ffmpegFindings.push(input.derivedEvidence.ffmpegFindings);
            return { decision: "accept", reason: "Evidence reviewed." };
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.status).toBe("succeeded");
      expect(ffmpegFindings[0]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ffmpeg sampled-frame extraction failed"),
          expect.stringContaining("ffmpeg contact-sheet generation failed"),
          expect.stringContaining("ffprobe audio probe failed"),
          expect.stringContaining("ffmpeg static-footage probe failed"),
        ]),
      );
    } finally {
      if (previousPath === undefined) {
        Reflect.deleteProperty(process.env, "PATH");
      } else {
        process.env.PATH = previousPath;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("routes unverified audio presence through the Draft Composite repair loop when music is enabled", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "0";

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
        stage1Dependencies([], { musicEnabled: true }),
        {
          async captureScenes(input) {
            return captureManifest(outputRoot, input.runId ?? "capture");
          },
          async compositeVideo(input) {
            return compositeManifest(outputRoot, input.runId ?? "composite");
          },
          async inspectDraftCompositeEvidence() {
            return {
              contactSheetPaths: [],
              ffmpegFindings: ["ffprobe audio probe failed: unavailable"],
              sampledFramePaths: [],
              staticProbeFailedSceneIds: [],
              staticSceneIds: [],
            };
          },
          async reviewDraftComposite() {
            return { decision: "accept" };
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.draftCompositeReview).toEqual({
        attempts: 1,
        findings: [
          "Draft Composite audio presence could not be verified while music is enabled",
        ],
        status: "exhausted",
        warnings: [
          "Draft Composite review retry limit exceeded; using latest draft.",
          "Draft Composite review requested repair: Draft Composite audio presence could not be verified while music is enabled",
          "Remaining quality gate: Draft Composite audio presence could not be verified while music is enabled",
        ],
      });
    } finally {
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("detects fully static draft footage as a deterministic quality gate", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "0";

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
              ...captureManifest(outputRoot, input.runId ?? "capture"),
              scenes: [
                {
                  durationSeconds: 2,
                  sceneId: "scene_article_feed",
                  sectionId: "demo-script",
                  videoPath: join(outputRoot, "scene.webm"),
                },
              ],
            };
          },
          async compositeVideo(input) {
            const manifest = {
              ...compositeManifest(outputRoot, input.runId ?? "composite"),
              durationInFrames: 60,
            };
            await writeStaticVideo(manifest.outputVideoPath as string, 2);
            return manifest;
          },
          async reviewDraftComposite() {
            return { decision: "accept" };
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.draftCompositeReview.findings).toContain(
        "Scene scene_article_feed contains fully static footage",
      );
      expect(result.draftCompositeReview.status).toBe("exhausted");
      expect(result.draftCompositeReview.warnings).toContain(
        "Remaining quality gate: Scene scene_article_feed contains fully static footage",
      );
    } finally {
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("includes per-Scene duration and capture findings in deterministic review gates", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-full-"));
    const previousMaxSceneDuration =
      process.env.MAKEADEMO_MAX_SCENE_CLIP_SECONDS;
    const previousReviewAttempts =
      process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS;
    process.env.MAKEADEMO_MAX_SCENE_CLIP_SECONDS = "4";
    process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS = "0";

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
              ...captureManifest(outputRoot, input.runId ?? "capture"),
              qualityFindings: ["Capture clip has low visual entropy"],
              scenes: [
                {
                  durationSeconds: 5,
                  sceneId: "scene_article_feed",
                  sectionId: "demo-script",
                  videoPath: join(outputRoot, "scene.webm"),
                },
              ],
            };
          },
          async compositeVideo(input) {
            return {
              ...compositeManifest(outputRoot, input.runId ?? "composite"),
              durationInFrames: 90,
            };
          },
          async reviewDraftComposite() {
            return { decision: "accept" };
          },
          async inspectDraftCompositeEvidence() {
            return cleanDraftEvidence();
          },
          outputRoot,
          runId: "full-run",
        },
      );

      expect(result.draftCompositeReview.findings).toEqual([
        "Capture clip has low visual entropy",
        "Scene scene_article_feed duration 5.00s exceeds 4s",
      ]);
      expect(result.draftCompositeReview.warnings).toEqual(
        expect.arrayContaining([
          "Remaining quality gate: Capture clip has low visual entropy",
          "Remaining quality gate: Scene scene_article_feed duration 5.00s exceeds 4s",
        ]),
      );
    } finally {
      if (previousMaxSceneDuration === undefined) {
        Reflect.deleteProperty(process.env, "MAKEADEMO_MAX_SCENE_CLIP_SECONDS");
      } else {
        process.env.MAKEADEMO_MAX_SCENE_CLIP_SECONDS = previousMaxSceneDuration;
      }
      if (previousReviewAttempts === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS",
        );
      } else {
        process.env.MAKEADEMO_DRAFT_COMPOSITE_REVIEW_ATTEMPTS =
          previousReviewAttempts;
      }
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function stage1Dependencies(
  calls: string[],
  options: { includeBrowserUrl?: boolean; musicEnabled?: boolean } = {
    includeBrowserUrl: true,
    musicEnabled: false,
  },
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
          "import { setup, scene } from './makeademo-capture-sdk';\nawait setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });\nawait scene('scene_article_feed', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
        exploration: {
          assumptions: [],
          productSurfaces: ["article feed"],
          summary: "Prepared app.",
        },
        format: "16:9",
        presentation: {
          music: options.musicEnabled
            ? { enabled: true as const, trackId: "focus" as const }
            : { enabled: false as const },
          textOverlays: [],
          transitions: [],
        },
        scenes: [
          {
            expectedVisibleOutcome: "The article feed is visible.",
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
        workspace: fakePreparationWorkspaceHandle(),
      };
    },
    screenRepoSecurity() {
      calls.push("repo-security-screen");
      return { rejections: [], status: "passed", warnings: [] };
    },
    async validateCapturePath() {
      calls.push("capture-path-validation");
      return {
        blockedNetworkAttempts: [],
        ...(options.includeBrowserUrl === false
          ? {}
          : { browserUrl: "https://preview.example.test/" }),
        logs: ["validated capture path"],
        status: "succeeded",
        warnings: [],
      };
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

function captureManifest(outputRoot: string, runId: string): CaptureManifest {
  return {
    baseUrl: "https://preview.example.test/",
    createdAt: "2026-01-01T00:00:00.000Z",
    keepTemp: true,
    manifestPath: join(outputRoot, `${runId}-capture-manifest.json`),
    qualityFindings: [],
    rawTakePath: join(outputRoot, `${runId}-raw.webm`),
    runDirectory: outputRoot,
    runId,
    scenes: [
      {
        durationSeconds: 5,
        sceneId: "scene_article_feed",
        sectionId: "demo-script",
        videoPath: join(outputRoot, `${runId}.webm`),
      },
    ],
    scriptId: "script_test",
    temporary: true,
    title: "Demo",
  };
}

function compositeManifest(
  outputRoot: string,
  runId: string,
): CompositedVideoManifest {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    durationInFrames: 150,
    fps: 30,
    manifestPath: join(outputRoot, `${runId}-composite-manifest.json`),
    outputVideoPath: join(outputRoot, `${runId}.mp4`),
    renderPlanPath: join(outputRoot, `${runId}-render-plan.json`),
    runDirectory: outputRoot,
    runId,
    scriptId: "script_test",
    title: "Demo",
    viewUrl: `file:///tmp/${runId}.mp4`,
  };
}

function cleanDraftEvidence() {
  return {
    audioPresent: true,
    contactSheetPaths: [],
    ffmpegFindings: [],
    sampledFramePaths: [],
    staticProbeFailedSceneIds: [],
    staticSceneIds: [],
  };
}

async function acceptDraftComposite() {
  return { decision: "accept" as const, reason: "Test draft accepted." };
}

async function writeStaticVideo(outputPath: string, durationSeconds: number) {
  const result = await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=10",
      "-t",
      String(durationSeconds),
      "-pix_fmt",
      "yuv420p",
      outputPath,
    ]);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create static test video. ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

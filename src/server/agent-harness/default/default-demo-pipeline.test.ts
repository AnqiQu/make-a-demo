import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT_OUTPUT_PATH } from "../schemas/artifacts";
import { runDefaultDemoPipeline } from "./default-demo-pipeline";

describe("runDefaultDemoPipeline", () => {
  it("rejects a feature list that cannot fit the Scene contract", async () => {
    let snapshotRead = false;

    await expect(
      runDefaultDemoPipeline(
        {
          demoLengthSeconds: 30,
          importantFeatures: Array.from(
            { length: 10 },
            (_, index) => `feature ${index + 1}`,
          ),
          repoUrl: "https://github.com/acme/too-many-features",
        },
        {
          async readRepoSnapshot() {
            snapshotRead = true;
            throw new Error("snapshot should not be read");
          },
        },
      ),
    ).rejects.toThrow("A demo can include at most 9 requested features");
    expect(snapshotRead).toBe(false);
  });

  it("forwards private-repo access and the screened source archive without persisting a token", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-private-"));
    const sourceArchive = {
      commitSha: "abc123def456",
      path: join(outputRoot, "screened-repo.tar"),
      sha256: "archive-sha256",
    };
    const installationTokenProvider = {
      async createInstallationToken() {
        return "short-lived-secret";
      },
    };

    await expect(
      runDefaultDemoPipeline(
        {
          demoLengthSeconds: 30,
          githubInstallationId: "installation-123",
          importantFeatures: [],
          repoUrl: "https://github.com/acme/private-app",
        },
        {
          async createHarnessDependencies(input) {
            expect(input.repoSourceArchive).toEqual(sourceArchive);
            throw new Error("dependency handoff observed");
          },
          installationTokenProvider,
          outputRoot,
          async readRepoSnapshot(snapshotInput, dependencies = {}) {
            expect(snapshotInput.githubInstallationId).toBe("installation-123");
            expect(dependencies.installationTokenProvider).toBe(
              installationTokenProvider,
            );
            return {
              commitSha: sourceArchive.commitSha,
              files: [{ path: "package.json", text: "{}" }],
              repoStats: { fileCount: 1, sizeBytes: 2 },
              sourceArchive,
            };
          },
          runId: "private-repo",
        },
      ),
    ).rejects.toThrow("dependency handoff observed");

    await expect(
      readFile(join(outputRoot, "private-repo", "input.json"), "utf8"),
    ).resolves.not.toContain("short-lived-secret");
  });

  it("runs the default harness, Footage Capture, and Compositing rails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-default-"));
    const calls: string[] = [];
    const staticImageAssets = {
      "architecture-v2.png": {
        sourcePath: join(outputRoot, "architecture.png"),
      },
    };
    const workspaceHandle = {
      async destroy() {
        calls.push("workspace.destroy");
      },
      id: "workspace-1",
      workspace: {
        async collectSandboxLogs() {
          calls.push("workspace.collectLogs");
          return [
            '{"event":"repo-preparation.started"}',
            '{"event":"repo-preparation.failed"}',
          ];
        },
        async destroy() {
          return undefined;
        },
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    };

    const result = await runDefaultDemoPipeline(
      {
        demoLengthSeconds: 30,
        importantFeatures: ["calendar view"],
        productSummary: "Scheduling automation",
        repoUrl: "https://github.com/acme/calendar",
        targetUsers: "Operations managers",
      },
      {
        async captureScenes(input) {
          calls.push(`capture:${input.baseUrl}:${input.runId}`);
          expect(input.captureRuntimeReset).toEqual({
            artifactPath:
              "/workspace/.makeademo/capture-runtime-reset-validation-report.json",
            stage: "capture-runtime-reset",
            status: "passed",
          });
          const manifestPath = join(
            input.tempRoot ?? outputRoot,
            "capture.json",
          );
          await writeFile(
            manifestPath,
            JSON.stringify({
              baseUrl: input.baseUrl,
              createdAt: "2026-07-08T00:00:00.000Z",
              keepTemp: true,
              manifestPath,
              qualityFindings: [],
              runDirectory: input.tempRoot,
              runId: input.runId,
              scenes: [
                {
                  durationSeconds: 3,
                  sceneId: "scene-1",
                  sectionId: "demo-script",
                  videoPath: join(outputRoot, "scene.webm"),
                },
              ],
              scriptId: "script-1",
              temporary: true,
              title: "Calendar Demo",
            }),
          );
          return JSON.parse(await readFile(manifestPath, "utf8"));
        },
        async compositeVideo(input) {
          calls.push(`composite:${input.runId}`);
          expect(input.staticImageAssets).toEqual(staticImageAssets);
          const outputVideoPath = join(
            input.outputRoot ?? outputRoot,
            "composite",
            "final-video.mp4",
          );
          await mkdir(join(input.outputRoot ?? outputRoot, "composite"), {
            recursive: true,
          });
          await writeFile(outputVideoPath, "mp4");
          return {
            createdAt: "2026-07-08T00:00:00.000Z",
            durationInFrames: 90,
            fps: 30,
            manifestPath: join(
              input.outputRoot ?? outputRoot,
              "composite.json",
            ),
            outputVideoPath,
            renderPlanPath: join(input.outputRoot ?? outputRoot, "render.json"),
            runDirectory: input.outputRoot ?? outputRoot,
            runId: input.runId ?? "composite",
            scriptId: "script-1",
            title: "Calendar Demo",
            viewUrl: "file://final-video.mp4",
          };
        },
        async createHarnessDependencies(dependencyInput) {
          expect(dependencyInput).toMatchObject({ staticImageAssets });
          const { artifactStore } = dependencyInput;
          return {
            dependencies: {
              artifactStore,
              async createWorkspace() {
                calls.push("harness.createWorkspace");
                return workspaceHandle.workspace;
              },
              async exploreApp() {
                throw new Error("fake harness runner should own stages");
              },
              async planFlow() {
                throw new Error("fake harness runner should own stages");
              },
              async prepareRepo() {
                throw new Error("fake harness runner should own stages");
              },
              async resetCaptureRuntime() {
                throw new Error("fake harness runner should own stages");
              },
              async synthesizeRunPlan() {
                throw new Error("fake harness runner should own stages");
              },
              async validateCapturePath() {
                throw new Error("fake harness runner should own stages");
              },
              async validatePreparation() {
                throw new Error("fake harness runner should own stages");
              },
              async validateScriptContract() {
                throw new Error("fake harness runner should own stages");
              },
              async writeScript() {
                throw new Error("fake harness runner should own stages");
              },
            },
            getWorkspaceHandle: () => workspaceHandle,
          };
        },
        outputRoot,
        async readRepoSnapshot() {
          calls.push("repo.snapshot");
          return {
            commitSha: "abc123def456",
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 2 },
            sourceArchive: {
              commitSha: "abc123def456",
              path: join(outputRoot, "screened-repo.tar"),
              sha256: "screened-repo-sha256",
            },
          };
        },
        runId: "terminal-run-001",
        staticImageAssets,
        async runHarnessPipeline(input, dependencies) {
          calls.push(`harness:${input.repoUrl}:${input.runId}`);
          await dependencies.artifactStore?.writeJson(
            "/workspace/.makeademo/pipeline-run-manifest.json",
            { finalStatus: "passed" },
          );
          return {
            pipelineRunManifest: {
              artifactPaths: {
                captureRuntimeReset:
                  "/workspace/.makeademo/capture-runtime-reset-validation-report.json",
              },
              daytonaSandboxIds: {},
              finalStatus: "passed",
              networkStateTransitions: [],
              opencodeSessionIds: [],
              repoUrl: input.repoUrl,
              runId: input.runId,
              stageStatuses: {},
              stageTimings: [],
            },
            preparationManifest: {
              appDir: ".",
              appExplorationHints: [],
              baseUrl: "http://127.0.0.1:3000",
              blockedExternalServicesReplaced: [],
              cleanupAndReproInstructions: [],
              createdFiles: [],
              envUsed: {},
              id: "prep-1",
              installCommandUsed: "bun install",
              knownLimitations: [],
              localDemoModeChanges: [],
              mocksAndFixturesAdded: [],
              modifiedFiles: [],
              ports: [3000],
              productContext: {
                evidencePaths: ["package.json"],
                featureInventory: [],
                name: "Demo App",
                summary: "A demo application.",
              },
              requiredLocalOnlyAssumptions: [],
              scriptGenerationContext: [],
              startCommandUsed: "bun run dev",
              validationEvidence: [],
            },
            scriptCandidate: {
              assumptions: [],
              browserActionCompilerVersion: "2026-07-12.1",
              bunRuntimeVersion: "1.3.14",
              captureSdkVersion: "2026-07-10.1",
              conformanceResult: {
                artifactReferences: [],
                blockedNetworkAttempts: [],
                browserObservations: [],
                consoleErrors: [],
                logsSummary: "passed",
                networkAttempts: [],
                pageErrors: [],
                retryCount: 0,
                screenshots: [],
                stage: "static-script-contract-validation",
                status: "passed",
                stderrExcerpts: [],
                stdoutExcerpts: [],
                suggestedRepairHints: [],
              },
              contractVersion: "2026-07-08",
              outputPath: DEMO_SCRIPT_OUTPUT_PATH,
              playwrightRuntimeVersion: "1.60.0",
              scriptJsonContent: {
                demoPlaywrightScript:
                  "import { setup, scene } from './makeademo-capture-sdk';",
                format: "16:9",
                presentation: {
                  music: { enabled: false },
                  textOverlays: [],
                  transitions: [],
                },
                scenes: [
                  {
                    expectedVisibleOutcome: "Calendar visible",
                    humanReadableDescription: "Show calendar",
                    id: "scene-1",
                    type: "playwright-recording",
                  },
                ],
                scriptId: "script-1",
                title: "Calendar Demo",
                version: 1,
              },
              sourceAppMapId: "appmap-1",
              sourceFlowSpecId: "flow-1",
              sourcePreparationManifestId: "prep-1",
              unsupportedPieces: [],
              validationArtifacts: [],
            },
            status: "passed",
            validationReports: [
              {
                artifactReferences: [],
                blockedNetworkAttempts: [],
                browserObservations: [],
                consoleErrors: [],
                logsSummary: "Fresh capture state restored",
                networkAttempts: [],
                pageErrors: [],
                retryCount: 0,
                screenshots: [],
                stage: "capture-runtime-reset",
                status: "passed",
                stderrExcerpts: [],
                stdoutExcerpts: [],
                suggestedRepairHints: [],
              },
            ],
          };
        },
      },
    );

    expect(calls).toEqual([
      "repo.snapshot",
      "harness:https://github.com/acme/calendar:terminal-run-001",
      "capture:http://127.0.0.1:3000:capture",
      "composite:composite",
      "workspace.collectLogs",
      "workspace.destroy",
    ]);
    expect(result.finalVideoPath).toBe(
      join(outputRoot, "terminal-run-001", "composite", "final-video.mp4"),
    );
    await expect(readFile(result.scriptPath, "utf8")).resolves.toContain(
      "Calendar Demo",
    );
    await expect(
      readFile(result.pipelineManifestPath, "utf8").then((content) =>
        JSON.parse(content),
      ),
    ).resolves.toMatchObject({ finalStatus: "passed" });
    await expect(
      readFile(join(result.runDirectory, "sandbox-log.jsonl"), "utf8"),
    ).resolves.toBe(
      '{"event":"repo-preparation.started"}\n{"event":"repo-preparation.failed"}\n',
    );
    await expect(
      readFile(join(result.runDirectory, "repo-snapshot.json"), "utf8").then(
        (content) => JSON.parse(content),
      ),
    ).resolves.toMatchObject({
      sourceArchive: {
        commitSha: "abc123def456",
        sha256: "screened-repo-sha256",
      },
    });
  });

  it("completes a synthetic-only Demo without requiring browser recording", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-synthetic-"));
    const workspaceHandle = {
      async destroy() {},
      id: "workspace-synthetic",
      workspace: {
        async destroy() {},
        async execute() {
          throw new Error("synthetic-only capture must not execute Playwright");
        },
      },
    };

    const result = await runDefaultDemoPipeline(
      {
        demoLengthSeconds: 10,
        importantFeatures: ["title card"],
        repoUrl: "https://github.com/acme/title-card",
      },
      {
        async compositeVideo(input) {
          const captureManifest = JSON.parse(
            await readFile(input.captureManifestPath, "utf8"),
          ) as { scenes: unknown[] };
          expect(captureManifest.scenes).toEqual([]);
          const outputVideoPath = join(
            input.outputRoot ?? outputRoot,
            "composite",
            "final-video.mp4",
          );
          await mkdir(join(input.outputRoot ?? outputRoot, "composite"), {
            recursive: true,
          });
          await writeFile(outputVideoPath, "mp4");
          return {
            createdAt: "2026-07-10T00:00:00.000Z",
            durationInFrames: 60,
            fps: 30,
            manifestPath: join(
              input.outputRoot ?? outputRoot,
              "composite.json",
            ),
            outputVideoPath,
            renderPlanPath: join(input.outputRoot ?? outputRoot, "render.json"),
            runDirectory: input.outputRoot ?? outputRoot,
            runId: input.runId ?? "composite",
            scriptId: "synthetic-script",
            title: "Synthetic Demo",
            viewUrl: "file://final-video.mp4",
          };
        },
        async createHarnessDependencies({ artifactStore }) {
          return {
            dependencies: { artifactStore } as never,
            getWorkspaceHandle: () => workspaceHandle,
          };
        },
        outputRoot,
        async readRepoSnapshot() {
          return {
            commitSha: "abc123def456",
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 2 },
            sourceArchive: {
              commitSha: "abc123def456",
              path: join(outputRoot, "screened-repo.tar"),
              sha256: "screened-repo-sha256",
            },
          };
        },
        runId: "synthetic-only",
        async runHarnessPipeline(input, dependencies) {
          await dependencies.artifactStore?.writeJson(
            "/workspace/.makeademo/pipeline-run-manifest.json",
            { finalStatus: "passed" },
          );
          return {
            pipelineRunManifest: {
              artifactPaths: {
                captureRuntimeReset:
                  "/workspace/.makeademo/capture-runtime-reset-validation-report.json",
              },
              daytonaSandboxIds: {},
              finalStatus: "passed",
              networkStateTransitions: [],
              opencodeSessionIds: [],
              repoUrl: input.repoUrl,
              runId: input.runId,
              stageStatuses: {},
              stageTimings: [],
            },
            preparationManifest: {
              appDir: ".",
              appExplorationHints: [],
              baseUrl: "http://127.0.0.1:3000",
              blockedExternalServicesReplaced: [],
              cleanupAndReproInstructions: [],
              createdFiles: [],
              envUsed: {},
              id: "prep-synthetic",
              installCommandUsed: "bun install",
              knownLimitations: [],
              localDemoModeChanges: [],
              mocksAndFixturesAdded: [],
              modifiedFiles: [],
              ports: [3000],
              productContext: {
                evidencePaths: ["package.json"],
                featureInventory: [],
                name: "Synthetic App",
                summary: "A synthetic demo application.",
              },
              requiredLocalOnlyAssumptions: [],
              scriptGenerationContext: [],
              startCommandUsed: "bun run dev",
              validationEvidence: [],
            },
            scriptCandidate: {
              assumptions: [],
              browserActionCompilerVersion: "2026-07-12.1",
              bunRuntimeVersion: "1.3.14",
              captureSdkVersion: "2026-07-10.1",
              conformanceResult: {
                artifactReferences: [],
                blockedNetworkAttempts: [],
                browserObservations: [],
                consoleErrors: [],
                logsSummary: "passed",
                networkAttempts: [],
                pageErrors: [],
                retryCount: 0,
                screenshots: [],
                stage: "static-script-contract-validation",
                status: "passed",
                stderrExcerpts: [],
                stdoutExcerpts: [],
                suggestedRepairHints: [],
              },
              contractVersion: "2026-07-12.1",
              outputPath: DEMO_SCRIPT_OUTPUT_PATH,
              playwrightRuntimeVersion: "1.60.0",
              scriptJsonContent: {
                format: "16:9",
                presentation: {},
                scenes: [
                  {
                    backgroundColor: "#101828",
                    durationSeconds: 2,
                    id: "title-card",
                    text: {
                      color: "#ffffff",
                      content: "Make a Demo",
                      font: "Inter",
                      position: "center",
                      size: "large",
                    },
                    type: "full-screen-text",
                  },
                ],
                scriptId: "synthetic-script",
                title: "Synthetic Demo",
                version: 1,
              },
              sourceAppMapId: "appmap-synthetic",
              sourceFlowSpecId: "flow-synthetic",
              sourcePreparationManifestId: "prep-synthetic",
              unsupportedPieces: [],
              validationArtifacts: [],
            },
            status: "passed",
            validationReports: [
              {
                artifactReferences: [],
                blockedNetworkAttempts: [],
                browserObservations: [],
                consoleErrors: [],
                logsSummary: "Fresh capture state restored",
                networkAttempts: [],
                pageErrors: [],
                retryCount: 0,
                screenshots: [],
                stage: "capture-runtime-reset",
                status: "passed",
                stderrExcerpts: [],
                stdoutExcerpts: [],
                suggestedRepairHints: [],
              },
            ],
          };
        },
      },
    );

    expect(result.finalVideoPath).toContain("final-video.mp4");
  });

  it("preserves the primary pipeline failure when workspace cleanup also fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-default-"));
    const workspaceHandle = {
      async destroy() {
        throw new Error("cleanup failed");
      },
      id: "workspace-1",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    };

    let caught: unknown;
    try {
      await runDefaultDemoPipeline(
        {
          demoLengthSeconds: 30,
          importantFeatures: [],
          productSummary: "Test app",
          repoUrl: "https://github.com/acme/test-app",
          targetUsers: "Test users",
        },
        {
          async createHarnessDependencies() {
            return {
              dependencies: {} as never,
              getWorkspaceHandle: () => workspaceHandle,
            };
          },
          outputRoot,
          async readRepoSnapshot() {
            return {
              commitSha: "abc123def456",
              files: [{ path: "package.json", text: "{}" }],
              repoStats: { fileCount: 1, sizeBytes: 2 },
              sourceArchive: {
                commitSha: "abc123def456",
                path: join(outputRoot, "screened-repo.tar"),
                sha256: "screened-repo-sha256",
              },
            };
          },
          runId: "cleanup-failure",
          async runHarnessPipeline() {
            throw new Error("primary pipeline failure");
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("primary pipeline failure");
    expect(Reflect.get(caught as object, "cleanupError")).toMatchObject({
      message: "cleanup failed",
    });
  });
});

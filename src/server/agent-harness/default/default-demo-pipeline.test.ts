import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT_OUTPUT_PATH } from "../schemas/artifacts";
import { runDefaultDemoPipeline } from "./default-demo-pipeline";

describe("runDefaultDemoPipeline", () => {
  it("runs the default harness, Footage Capture, and Compositing rails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-default-"));
    const calls: string[] = [];
    const workspaceHandle = {
      async destroy() {
        calls.push("workspace.destroy");
      },
      id: "workspace-1",
      workspace: {
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
        async createHarnessDependencies({ artifactStore }) {
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
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 2 },
          };
        },
        runId: "terminal-run-001",
        async runHarnessPipeline(input, dependencies) {
          calls.push(`harness:${input.repoUrl}:${input.runId}`);
          await dependencies.artifactStore?.writeJson(
            "/workspace/.makeademo/pipeline-run-manifest.json",
            { finalStatus: "passed" },
          );
          return {
            pipelineRunManifest: {
              artifactPaths: {},
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
              requiredLocalOnlyAssumptions: [],
              scriptGenerationContext: [],
              startCommandUsed: "bun run dev",
              validationEvidence: [],
            },
            scriptCandidate: {
              assumptions: [],
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
            validationReports: [],
          };
        },
      },
    );

    expect(calls).toEqual([
      "repo.snapshot",
      "harness:https://github.com/acme/calendar:terminal-run-001",
      "capture:http://127.0.0.1:3000:capture",
      "composite:composite",
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
  });
});

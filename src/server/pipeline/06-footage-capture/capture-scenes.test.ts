import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspaceHandle } from "../../agent-harness/daytona/workspace.interface";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { captureScenesFromScript } from "./capture-scenes";
import { PreparedWorkspacePlaywrightSceneRecorder } from "./playwright-scene-recorder";
import type { SceneRecorder } from "./scene-recorder.interface";

const execFileAsync = promisify(execFile);

describe("captureScenesFromScript", () => {
  it("accepts a Demo Script with a continuous Playwright flow and declared Scenes without durations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");

    await writeFile(
      scriptPath,
      JSON.stringify({
        demoPlaywrightScript: [
          "import { scene, setup } from './makeademo-capture-sdk';",
          "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
          "await scene('scene-001', async ({ page }) => { await expect(page.locator('body')).toBeVisible(); });",
          "await scene('scene-002', async ({ page }) => { await expect(page.locator('body')).toBeVisible(); });",
        ].join("\n"),
        presentation: {
          music: { enabled: true, trackId: "clean" },
          textOverlays: [
            {
              content: "Demo Script",
              font: "Inter",
              position: "top-left",
              sceneId: "scene-001",
              size: "medium",
            },
          ],
          transitions: [
            {
              durationSeconds: 0.25,
              fromSceneId: "scene-001",
              style: "fade",
              toSceneId: "scene-002",
            },
          ],
        },
        scenes: [
          {
            description: "Open the app.",
            expectedVisibleOutcome: "The prepared app shell is visible.",
            id: "scene-001",
          },
          {
            description: "Click the main action.",
            expectedVisibleOutcome: "The main action result is visible.",
            id: "scene-002",
          },
        ],
        scriptId: "script-001",
        setupActions: [
          {
            id: "dismiss-welcome",
            locator: { strategy: "text", value: "Dismiss" },
            type: "click",
          },
        ],
        title: "Demo Script",
        version: 1,
        format: "16:9",
      }),
    );

    const recordedSceneIds: string[] = [];
    const recordedSetupActionIds: string[] = [];
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        recordedSceneIds.push(...input.scenes.map((scene) => scene.id));
        recordedSetupActionIds.push(
          ...(input.setupActions?.map((action) => action.id) ?? []),
        );
        return input.scenes.map((scene, sceneIndex) => ({
          durationSeconds: 4,
          markerEndMs: 2_000 + sceneIndex,
          markerStartMs: 1_000 + sceneIndex,
          sceneId: scene.id,
          sectionId: input.sectionId,
          videoPath: join(
            input.runDirectory,
            "scene-clips",
            `${scene.id}.webm`,
          ),
        }));
      },
    };

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      recorder,
      scriptPath,
      tempRoot,
    });

    expect(recordedSceneIds).toEqual(["scene-001", "scene-002"]);
    expect(recordedSetupActionIds).toEqual(["dismiss-welcome"]);
    expect(manifest.scriptId).toBe("script-001");
    expect(manifest.scriptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.temporary).toBe(true);
    expect(manifest.scenes).toEqual([
      {
        durationSeconds: 4,
        markerEndMs: 2000,
        markerStartMs: 1000,
        sceneId: "scene-001",
        sectionId: "demo-script",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
      },
      {
        durationSeconds: 4,
        markerEndMs: 2001,
        markerStartMs: 1001,
        sceneId: "scene-002",
        sectionId: "demo-script",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-002.webm"),
      },
    ]);
    expect(manifest.markerLogPath).toBe(
      join(manifest.runDirectory, "scene-markers.jsonl"),
    );
    expect(manifest.stdoutLogPath).toBe(
      join(manifest.runDirectory, "stdout.log"),
    );
    expect(manifest.stderrLogPath).toBe(
      join(manifest.runDirectory, "stderr.log"),
    );
    expect(manifest.qualityFindings).toEqual([]);
    expect(manifest.rawTakePath).toBeUndefined();

    const manifestJson = JSON.parse(
      await readFile(manifest.manifestPath, "utf8"),
    ) as typeof manifest;
    expect(manifestJson).toEqual(manifest);
  });

  it("records the diagnostic raw take path only when capture retention is enabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        return input.scenes.map((scene) => ({
          durationSeconds: 4,
          markerEndMs: 2_000,
          markerStartMs: 1_000,
          sceneId: scene.id,
          sectionId: input.sectionId,
          videoPath: join(
            input.runDirectory,
            "scene-clips",
            `${scene.id}.webm`,
          ),
        }));
      },
    };

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      keepTemp: true,
      recorder,
      scriptPackage: validDemoScript(),
      tempRoot,
    });

    expect(manifest.rawTakePath).toBe(
      join(manifest.runDirectory, "raw-scenes", "continuous-take.webm"),
    );
  });

  it("records only playwright-recording Scenes from a mixed Demo Script", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const recordedSceneIds: string[] = [];
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        recordedSceneIds.push(...input.scenes.map((scene) => scene.id));
        return input.scenes.map((scene) => ({
          durationSeconds: 2,
          markerEndMs: 2_000,
          markerStartMs: 0,
          sceneId: scene.id,
          sectionId: input.sectionId,
          videoPath: join(
            input.runDirectory,
            "scene-clips",
            `${scene.id}.webm`,
          ),
        }));
      },
    };
    const browserScene = validDemoScript().scenes[0];

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      recorder,
      scriptPackage: {
        ...validDemoScript(),
        scenes: [
          {
            backgroundColor: "#101828",
            durationSeconds: 2,
            id: "intro",
            text: {
              color: "#ffffff",
              content: "Welcome",
              font: "Inter",
              position: "center",
              size: "large",
            },
            type: "full-screen-text",
          },
          browserScene,
          {
            alt: "Architecture diagram",
            assetId: "architecture.png",
            durationSeconds: 2,
            id: "architecture",
            type: "static-image",
          },
        ],
      },
      tempRoot: join(workspace, "runs"),
    });

    expect(recordedSceneIds).toEqual(["scene-001"]);
    expect(manifest.scenes.map((scene) => scene.sceneId)).toEqual([
      "scene-001",
    ]);
  });

  it("creates an empty Capture Manifest for a synthetic-only Demo Script", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));

    const manifest = await captureScenesFromScript({
      baseUrl: "http://localhost:3000",
      scriptPackage: {
        format: "16:9",
        presentation: {},
        scenes: [
          {
            backgroundColor: "#101828",
            durationSeconds: 2,
            id: "intro",
            text: {
              color: "#ffffff",
              content: "Welcome",
              font: "Inter",
              position: "center",
              size: "large",
            },
            type: "full-screen-text",
          },
        ],
        scriptId: "script-synthetic",
        title: "Synthetic Demo",
        version: 1,
      },
      tempRoot: join(workspace, "runs"),
    });

    expect(manifest.scenes).toEqual([]);
    expect(manifest.scriptId).toBe("script-synthetic");
    expect(manifest.markerLogPath).toBeUndefined();
    expect(manifest.rawTakePath).toBeUndefined();
  });

  it("runs Footage Capture remotely and trims clips locally from the downloaded raw take", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const executedCommands: string[] = [];
    const submittedCommands: string[] = [];
    const uploadedDestinations: string[] = [];
    const downloadedSources: string[] = [];
    const externalResourceDirectory = join(workspace, "external-resources");
    const externalResourceBody = Buffer.from("original-logo");
    const externalResourceDigest = createHash("sha256")
      .update(externalResourceBody)
      .digest("hex");
    await mkdir(join(externalResourceDirectory, "resources"), {
      recursive: true,
    });
    await writeFile(
      join(externalResourceDirectory, "resources", externalResourceDigest),
      externalResourceBody,
    );
    const preparationWorkspace: AgentHarnessWorkspaceHandle = {
      async destroy() {},
      id: "daytona_workspace",
      workspace: {
        async destroy() {},
        async downloadFiles() {
          throw new Error(
            "generic artifact download must not cross trust boundaries",
          );
        },
        async downloadSubmittedCodeFiles(files) {
          downloadedSources.push(...files.map((file) => file.sourcePath));
          expect(files).toHaveLength(1);
          const archiveSource = await mkdtemp(
            join(tmpdir(), "makeademo-capture-output-"),
          );
          await mkdir(join(archiveSource, "raw-scenes"), { recursive: true });
          await writeFile(
            join(archiveSource, "raw-scenes", "continuous-take.webm"),
            "raw take",
          );
          await mkdir(dirname(files[0]?.destinationPath ?? ""), {
            recursive: true,
          });
          await execFileAsync("tar", [
            "-cf",
            files[0]?.destinationPath ?? "",
            "-C",
            archiveSource,
            "--",
            "raw-scenes/continuous-take.webm",
          ]);
        },
        async execute(command) {
          executedCommands.push(command);
          if (
            command.includes("bun ") ||
            command.includes("find ") ||
            command.includes("ffmpeg") ||
            command.includes("ffprobe") ||
            command.includes("continuous-take") ||
            command.includes("raw-scenes")
          ) {
            throw new Error(
              "outer workspace execution must not run capture commands",
            );
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          submittedCommands.push(command);
          if (command.includes("find ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout:
                "/workspace/.makeademo/footage-capture-runs/capture-sandbox/work/continuous-take/playwright-videos/raw.webm\n",
            };
          }
          if (command.includes("bun ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: [
                '[makeademo:scene] {"elapsedMs":100,"event":"started","sceneId":"scene-001"}',
                '[makeademo:scene] {"elapsedMs":900,"event":"succeeded","sceneId":"scene-001"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async getPreviewUrl() {
          return "https://preview.example.test/";
        },
        async uploadFiles() {
          throw new Error(
            "generic artifact upload must not cross trust boundaries",
          );
        },
        async uploadSubmittedCodeFiles(files) {
          uploadedDestinations.push(
            ...files.map((file) => file.destinationPath),
          );
        },
      },
    };

    const externalResourceCache: {
      directory: string;
      manifest: ExternalResourceManifest;
    } = {
      directory: externalResourceDirectory,
      manifest: {
        entries: [
          {
            contentType: "image/svg+xml",
            headers: {},
            relativePath: `resources/${externalResourceDigest}`,
            sha256: `sha256:${externalResourceDigest}`,
            sizeBytes: externalResourceBody.byteLength,
            status: 200,
            url: "https://assets.example.com/logo.svg",
          },
        ],
        version: "2026-07-15",
      },
    };
    const trims: Array<{
      durationMs: number;
      outputVideoPath: string;
      rawTakePath: string;
      sceneId: string;
    }> = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      clipTrimmer: async (trim) => {
        trims.push({
          durationMs: trim.durationMs,
          outputVideoPath: trim.outputVideoPath,
          rawTakePath: trim.rawTakePath,
          sceneId: trim.sceneId,
        });
        await writeFile(trim.outputVideoPath, "trimmed video");
        return { durationSeconds: trim.durationMs / 1000 };
      },
      externalResourceCache,
      preparationWorkspace,
    });

    const manifest = await captureScenesFromScript({
      baseUrl: "https://preview.example.test/",
      captureRuntimeReset: {
        artifactPath: "/workspace/.makeademo/capture-runtime-reset.json",
        stage: "capture-runtime-reset",
        status: "passed",
      },
      externalResourceCache,
      keepTemp: false,
      recorder,
      runId: "capture-sandbox",
      scriptPackage: validDemoScript(),
      tempRoot,
    });

    expect(manifest.scenes).toEqual([
      expect.objectContaining({
        durationSeconds: 1.25,
        markerEndMs: 900,
        markerStartMs: 100,
        sceneId: "scene-001",
        videoPath: join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
      }),
    ]);
    expect(manifest.captureRuntimeResetArtifactPath).toBe(
      "/workspace/.makeademo/capture-runtime-reset.json",
    );
    expect(uploadedDestinations).toEqual(
      expect.arrayContaining([
        "/workspace/.makeademo/external-resources/external-resource-cache.tgz",
        expect.stringMatching(/capture-inputs\.tgz$/),
      ]),
    );
    expect(manifest.externalResourceManifestSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(submittedCommands.join("\n")).toContain(
      "/workspace/.makeademo/footage-capture-runs/capture-sandbox",
    );
    expect(submittedCommands.join("\n")).toMatch(
      /tar -xzf .*capture-inputs\.tgz.*continuous-take/s,
    );
    // Encoding never runs in the sandbox: the raw take is downloaded and
    // clips are trimmed and probed locally, so the artifacts compositing
    // consumes are the ones that were verified.
    expect(submittedCommands.join("\n")).not.toContain("ffmpeg");
    expect(submittedCommands.join("\n")).not.toContain("ffprobe");
    const outputArchiveCommand = submittedCommands.find(
      (command) =>
        command.includes("capture-outputs.tar") && command.includes("tar -cf"),
    );
    expect(outputArchiveCommand).toContain("raw-scenes/continuous-take.webm");
    expect(outputArchiveCommand).not.toContain("scene-clips");
    expect(executedCommands.join("\n")).not.toContain("ffmpeg");
    expect(executedCommands.join("\n")).not.toContain("ffprobe");
    expect(downloadedSources).toEqual([
      expect.stringMatching(/capture-outputs\.tar$/),
    ]);
    expect(trims).toEqual([
      {
        durationMs: 1250,
        outputVideoPath: join(
          manifest.runDirectory,
          "scene-clips",
          "scene-001.webm",
        ),
        rawTakePath: join(
          manifest.runDirectory,
          "raw-scenes",
          "continuous-take.webm",
        ),
        sceneId: "scene-001",
      },
    ]);
    await expect(
      readFile(
        join(manifest.runDirectory, "scene-clips", "scene-001.webm"),
        "utf8",
      ),
    ).resolves.toBe("trimmed video");
    // keepTemp=false drops the local raw take after trimming.
    await expect(
      readFile(
        join(manifest.runDirectory, "raw-scenes", "continuous-take.webm"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a prepared workspace when no explicit test recorder is injected", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        scriptPackage: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow(
      "Footage Capture requires a prepared workspace; local capture is not allowed.",
    );
  });

  it("requires a passed fresh-runtime reset proof before recording in a prepared workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const preparationWorkspace: AgentHarnessWorkspaceHandle = {
      async destroy() {},
      id: "daytona_workspace",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    };

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        preparationWorkspace,
        scriptPackage: validDemoScript(),
        tempRoot: join(workspace, "runs"),
      }),
    ).rejects.toThrow(
      "Footage Capture requires a passed capture-runtime-reset proof",
    );
  });

  it("rejects Demo Scripts with agent-authored recorded Scene durations before recording starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    let recordSceneWasCalled = false;

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        recorder: {
          async recordScenes() {
            recordSceneWasCalled = true;
            return [];
          },
        },
        scriptPackage: {
          demoPlaywrightScript: "await scene('scene-001', async () => {});",
          presentation: {
            music: { enabled: false },
            textOverlays: [],
            transitions: [],
          },
          scenes: [
            {
              description: "Open the app.",
              durationSeconds: 4,
              expectedVisibleOutcome: "The app is visible.",
              id: "scene-001",
            },
          ],
          scriptId: "script-001",
          title: "Demo Script",
          version: 1,
          format: "16:9",
        },
        tempRoot,
      }),
    ).rejects.toThrow("scenes[0].durationSeconds is not allowed");

    expect(recordSceneWasCalled).toBe(false);
  });

  it("keeps the capture run directory when recording fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const tempRoot = join(workspace, "runs");
    const recorder: SceneRecorder = {
      async recordScenes() {
        throw new Error("recording exploded");
      },
    };

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        keepTemp: false,
        recorder,
        runId: "capture-keeps-evidence",
        scriptPackage: validDemoScript(),
        tempRoot,
      }),
    ).rejects.toThrow("recording exploded");

    // The run directory is the failure's diagnosis (stdout, markers, clips);
    // it must survive the error.
    await expect(
      readdir(join(tempRoot, "capture-keeps-evidence")),
    ).resolves.toContain("raw-scenes");
  });

  it("rejects malformed Demo Scripts before recording starts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");
    let recordSceneWasCalled = false;

    await writeFile(
      scriptPath,
      JSON.stringify({
        scriptId: "script-001",
        title: "Demo Script",
        version: 1,
        format: "16:9",
        scenes: [],
      }),
    );

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        recorder: {
          async recordScenes() {
            recordSceneWasCalled = true;
            return [];
          },
        },
        scriptPath,
        tempRoot,
      }),
    ).rejects.toThrow("scenes must be a non-empty array");

    expect(recordSceneWasCalled).toBe(false);
  });
});

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { scene, setup } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });",
      "await scene('scene-001', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: false as const },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        description: "Open the app.",
        expectedVisibleOutcome: "The prepared app shell is visible.",
        id: "scene-001",
      },
    ],
    scriptId: "script-001",
    title: "Demo Script",
    version: 1,
  };
}

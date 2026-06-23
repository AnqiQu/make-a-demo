import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureScenesFromScript } from "./capture-scenes";
import type { SceneRecorder } from "./scene-recorder.interface";

describe("captureScenesFromScript", () => {
  it("accepts a Demo Script with a continuous Playwright flow and declared Scenes without durations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");

    await writeFile(
      scriptPath,
      JSON.stringify({
        audio: { enabled: true, music: { id: "clean" } },
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
        title: "Demo Script",
        version: 1,
        format: "16:9",
      }),
    );

    const recordedSceneIds: string[] = [];
    const recorder: SceneRecorder = {
      async recordScenes(input) {
        recordedSceneIds.push(...input.scenes.map((scene) => scene.id));
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
    expect(manifest.scriptId).toBe("script-001");
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
    expect(manifest.rawTakePath).toBe(
      join(manifest.runDirectory, "raw-scenes", "continuous-take.webm"),
    );

    const manifestJson = JSON.parse(
      await readFile(manifest.manifestPath, "utf8"),
    ) as typeof manifest;
    expect(manifestJson).toEqual(manifest);
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
    ).rejects.toThrow("demoPlaywrightScript must be a non-empty string");

    expect(recordSceneWasCalled).toBe(false);
  });
});

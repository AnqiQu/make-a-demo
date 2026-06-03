import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureScenesFromScript } from "./capture-scenes";
import type { SceneRecorder } from "./scene-recorder.interface";

describe("captureScenesFromScript", () => {
  it("records each Scene Description and writes a temporary capture manifest in order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-capture-test-"));
    const scriptPath = join(workspace, "script.json");
    const tempRoot = join(workspace, "runs");

    await writeFile(
      scriptPath,
      JSON.stringify({
        scriptId: "script-001",
        title: "Demo Script",
        version: 1,
        estimatedDurationSeconds: 9,
        format: "16:9",
        sections: [
          {
            id: "section-001",
            title: "First Section",
            scenes: [
              {
                id: "scene-001",
                humanReadableDescription: "Open the app.",
                durationSeconds: 4,
                events: ["Navigate to the app."],
                playwrightScript: "await page.goto(baseUrl);",
              },
            ],
          },
          {
            id: "section-002",
            title: "Second Section",
            scenes: [
              {
                id: "scene-002",
                humanReadableDescription: "Click the main action.",
                durationSeconds: 5,
                events: ["Click the main action."],
                playwrightScript: "await page.getByRole('button').click();",
              },
            ],
          },
        ],
      }),
    );

    const recordedSceneIds: string[] = [];
    const recorder: SceneRecorder = {
      async recordScene(input) {
        recordedSceneIds.push(input.scene.id);
        return {
          durationSeconds: input.scene.durationSeconds,
          videoPath: join(
            input.runDirectory,
            "raw-scenes",
            `${input.scene.id}.webm`,
          ),
        };
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
        sceneId: "scene-001",
        sectionId: "section-001",
        videoPath: join(manifest.runDirectory, "raw-scenes", "scene-001.webm"),
      },
      {
        durationSeconds: 5,
        sceneId: "scene-002",
        sectionId: "section-002",
        videoPath: join(manifest.runDirectory, "raw-scenes", "scene-002.webm"),
      },
    ]);

    const manifestJson = JSON.parse(
      await readFile(manifest.manifestPath, "utf8"),
    ) as typeof manifest;
    expect(manifestJson).toEqual(manifest);
  });

  it("rejects malformed Video Script Packages before recording starts", async () => {
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
        estimatedDurationSeconds: 9,
        format: "16:9",
        sections: [],
      }),
    );

    await expect(
      captureScenesFromScript({
        baseUrl: "http://localhost:3000",
        recorder: {
          async recordScene() {
            recordSceneWasCalled = true;
            return {
              durationSeconds: 1,
              videoPath: "should-not-exist.webm",
            };
          },
        },
        scriptPath,
        tempRoot,
      }),
    ).rejects.toThrow("sections must be a non-empty array");

    expect(recordSceneWasCalled).toBe(false);
  });
});

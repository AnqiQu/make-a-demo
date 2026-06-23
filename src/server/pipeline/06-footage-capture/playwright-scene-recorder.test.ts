import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPlaywrightSceneRecorder } from "./playwright-scene-recorder";

describe("DefaultPlaywrightSceneRecorder", () => {
  it("fails a Scene that does not complete instead of hanging indefinitely", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const recorder = new DefaultPlaywrightSceneRecorder({
      sceneTimeoutMs: 250,
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: "await new Promise(() => {});",
          runDirectory,
          scenes: [
            {
              expectedVisibleOutcome: "The scene never completes.",
              humanReadableDescription: "A scene that never completes.",
              id: "scene-hangs",
            },
          ],
          sectionId: "section-1",
        }),
      ).rejects.toThrow("Scene continuous-take timed out");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 10_000);

  it("records one continuous take and trims declared Scenes from helper markers", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const trims: Array<{
      durationMs: number;
      outputVideoPath: string;
      sceneId: string;
      startMs: number;
    }> = [];
    const recorder = new DefaultPlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({
          durationMs: input.durationMs,
          outputVideoPath: input.outputVideoPath,
          sceneId: input.sceneId,
          startMs: input.startMs,
        });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 0,
      preRollMs: 0,
      sceneTimeoutMs: 15_000,
    });

    try {
      const scenes = await recorder.recordScenes({
        baseUrl:
          "data:text/html,<main><h1>MakeADemo</h1><button>Next</button></main>",
        demoPlaywrightScript: [
          "import { scene, setup } from './makeademo-capture-sdk';",
          "await setup(async ({ page, baseUrl, expect }) => {",
          "  await page.goto(baseUrl);",
          "  await expect(page.locator('main')).toContainText('MakeADemo');",
          "});",
          "await scene('scene-one', async ({ page, expect }) => {",
          "  await expect(page.getByRole('heading', { name: 'MakeADemo' })).toBeVisible();",
          "});",
          "await scene('scene-two', async ({ page, expect }) => {",
          "  await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();",
          "});",
        ].join("\n"),
        runDirectory,
        scenes: [
          {
            expectedVisibleOutcome: "Heading is visible.",
            humanReadableDescription: "Show heading.",
            id: "scene-one",
          },
          {
            expectedVisibleOutcome: "Button is visible.",
            humanReadableDescription: "Show button.",
            id: "scene-two",
          },
        ],
        sectionId: "demo-script",
      });

      expect(scenes.map((scene) => scene.sceneId)).toEqual([
        "scene-one",
        "scene-two",
      ]);
      expect(trims.map((trim) => trim.sceneId)).toEqual([
        "scene-one",
        "scene-two",
      ]);
      expect(trims.every((trim) => trim.startMs >= 0)).toBe(true);
      expect(trims.every((trim) => trim.durationMs > 0)).toBe(true);
      expect(scenes[0]?.markerStartMs).toBeLessThanOrEqual(
        scenes[0]?.markerEndMs ?? 0,
      );
      expect(scenes[1]?.markerStartMs).toBeGreaterThanOrEqual(
        scenes[0]?.markerEndMs ?? 0,
      );
      expect(
        await readFile(join(runDirectory, "scene-markers.jsonl"), "utf8"),
      ).toContain('"sceneId":"scene-one"');
      expect(scenes[0]?.videoPath).toBe(trims[0]?.outputVideoPath);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});

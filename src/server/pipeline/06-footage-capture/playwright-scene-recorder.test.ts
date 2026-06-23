import { mkdtemp, rm, symlink } from "node:fs/promises";
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
        recorder.recordScene({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: "await new Promise(() => {});",
          runDirectory,
          scene: {
            expectedVisibleOutcome: "The scene never completes.",
            humanReadableDescription: "A scene that never completes.",
            id: "scene-hangs",
          },
          sectionId: "section-1",
        }),
      ).rejects.toThrow("Scene scene-hangs timed out");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 10_000);
});

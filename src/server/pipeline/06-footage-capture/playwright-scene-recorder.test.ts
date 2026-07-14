import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPlaywrightSceneRecorder } from "./playwright-scene-recorder";

describe("DefaultPlaywrightSceneRecorder", () => {
  it("adds backend-owned Scene holds to the capture execution budget", async () => {
    const runDirectory = await recorderWorkspace();
    let observedTimeoutMs: number | undefined;
    let preparedScript = "";
    const recorder = new DefaultPlaywrightSceneRecorder({
      sceneScriptRunner: async (scenePath, timeoutMs) => {
        observedTimeoutMs = timeoutMs;
        preparedScript = await readFile(scenePath, "utf8");
        return {
          exitCode: 1,
          stderr: "stopped after observing timeout",
          stdout: "",
          timedOut: false,
        };
      },
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: [
            validDemoScript("static-scene"),
            "await scene('interactive-scene', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
          ].join("\n"),
          runDirectory,
          scenes: [
            sceneDescription("static-scene", [
              { id: "open", path: "/", type: "goto" },
              {
                id: "show",
                locator: { strategy: "css", value: "main" },
                type: "assert-visible",
              },
            ]),
            sceneDescription("interactive-scene", [
              {
                id: "click",
                locator: { strategy: "text", value: "Next" },
                type: "click",
              },
              {
                id: "show-next",
                locator: { strategy: "css", value: "main" },
                type: "assert-visible",
              },
            ]),
          ],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("continuous-take failed");
      expect(preparedScript).toContain(
        'sceneHoldMsById: {"static-scene":3000,"interactive-scene":1000}',
      );
      expect(observedTimeoutMs).toBe(214_000);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  });

  it("rejects SDK type errors before recording browser footage", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const recorder = new DefaultPlaywrightSceneRecorder();

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ missingThing }) => {",
            "  await missingThing();",
            "});",
            "await scene('scene-type-error', async ({ page, expect }) => {",
            "  await expect(page.locator('main')).toBeVisible();",
            "});",
          ].join("\n"),
          runDirectory,
          scenes: [
            {
              expectedVisibleOutcome: "Main content is visible.",
              humanReadableDescription: "Show main content.",
              id: "scene-type-error",
              type: "playwright-recording",
            },
          ],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("failed Capture SDK TypeScript validation");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

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
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async ({ page, baseUrl, expect }) => {",
            "  await page.goto(baseUrl);",
            "  await expect(page.locator('main')).toBeVisible();",
            "});",
            "await scene('scene-hangs', async () => {",
            "  await new Promise(() => {});",
            "});",
          ].join("\n"),
          runDirectory,
          scenes: [
            {
              expectedVisibleOutcome: "The scene never completes.",
              humanReadableDescription: "A scene that never completes.",
              id: "scene-hangs",
              type: "playwright-recording",
            },
          ],
          sectionId: "section-1",
        }),
      ).rejects.toThrow("Scene continuous-take timed out");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 10_000);

  it("fails Footage Capture when generated Demo Scripts attempt runtime network access", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const recorder = new DefaultPlaywrightSceneRecorder({
      rawVideoFinder: async () => {
        throw new Error("raw video discovery must not run after network block");
      },
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout:
          '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime"}',
        timedOut: false,
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await setup(async () => {});",
            "await scene('scene-network', async () => {});",
          ].join("\n"),
          runDirectory,
          scenes: [
            {
              expectedVisibleOutcome: "Main content is visible.",
              humanReadableDescription: "Try analytics.",
              id: "scene-network",
              type: "playwright-recording",
            },
          ],
          sectionId: "section-network",
        }),
      ).rejects.toThrow(
        "Footage Capture blocked runtime network access from the generated Demo Script: analytics.example.com",
      );
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

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
          "  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p>Scene one state carried forward</p>'));",
          "  await expect(page.getByRole('heading', { name: 'MakeADemo' })).toBeVisible();",
          "});",
          "await scene('scene-two', async ({ page, expect }) => {",
          "  await expect(page.locator('body')).toContainText('Scene one state carried forward');",
          "  await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();",
          "});",
        ].join("\n"),
        runDirectory,
        scenes: [
          {
            expectedVisibleOutcome: "Heading is visible.",
            humanReadableDescription: "Show heading.",
            id: "scene-one",
            type: "playwright-recording",
          },
          {
            expectedVisibleOutcome: "Button is visible.",
            humanReadableDescription: "Show button.",
            id: "scene-two",
            type: "playwright-recording",
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
      expect(
        await readFile(join(runDirectory, "scene-markers.jsonl"), "utf8"),
      ).toContain('"kind":"action"');
      expect(
        await readFile(join(runDirectory, "stdout.log"), "utf8"),
      ).toContain("[makeademo:scene]");
      await expect(
        readFile(join(runDirectory, "stderr.log"), "utf8"),
      ).resolves.toBeTypeOf("string");
      expect(scenes[0]?.videoPath).toBe(trims[0]?.outputVideoPath);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 30_000);

  it("clamps pre-roll at the start of the continuous take", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    await writeFile(rawVideoPath, "raw video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: sceneMarker({
          elapsedMs: 200,
          event: "succeeded",
          sceneId: "scene-one",
        }),
        stdout: sceneMarker({
          elapsedMs: 100,
          event: "started",
          sceneId: "scene-one",
        }),
        timedOut: false,
      }),
    });

    try {
      await recorder.recordScenes({
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        demoPlaywrightScript: validDemoScript("scene-one"),
        runDirectory,
        scenes: [sceneDescription("scene-one")],
        sectionId: "demo-script",
      });

      expect(trims).toEqual([{ durationMs: 550, startMs: 0 }]);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("excludes setup time before the first Scene and extends post-roll after the Scene", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    await writeFile(rawVideoPath, "raw video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          sceneMarker({
            elapsedMs: 2_000,
            event: "started",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 3_000,
            event: "succeeded",
            sceneId: "scene-one",
          }),
        ].join("\n"),
        timedOut: false,
      }),
    });

    try {
      await recorder.recordScenes({
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        demoPlaywrightScript: validDemoScript("scene-one"),
        runDirectory,
        scenes: [sceneDescription("scene-one")],
        sectionId: "demo-script",
      });

      expect(trims).toEqual([{ durationMs: 1_600, startMs: 1_750 }]);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("keeps post-roll trim requests bounded by marker-derived ranges", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    await writeFile(rawVideoPath, "raw video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          sceneMarker({
            elapsedMs: 9_900,
            event: "started",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 10_000,
            event: "succeeded",
            sceneId: "scene-one",
          }),
        ].join("\n"),
        timedOut: false,
      }),
    });

    try {
      await recorder.recordScenes({
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        demoPlaywrightScript: validDemoScript("scene-one"),
        runDirectory,
        scenes: [sceneDescription("scene-one")],
        sectionId: "demo-script",
      });

      expect(trims).toEqual([{ durationMs: 700, startMs: 9_650 }]);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("uses one shared boundary when adjacent Scene padding would overlap", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    const trims: Array<{
      durationMs: number;
      sceneId: string;
      startMs: number;
    }> = [];
    await writeFile(rawVideoPath, "raw video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({
          durationMs: input.durationMs,
          sceneId: input.sceneId,
          startMs: input.startMs,
        });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          sceneMarker({
            elapsedMs: 1_000,
            event: "started",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 2_000,
            event: "succeeded",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 2_001,
            event: "started",
            sceneId: "scene-two",
          }),
          sceneMarker({
            elapsedMs: 3_000,
            event: "succeeded",
            sceneId: "scene-two",
          }),
        ].join("\n"),
        timedOut: false,
      }),
    });

    try {
      await recorder.recordScenes({
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        demoPlaywrightScript: [
          validDemoScript("scene-one"),
          "await scene('scene-two', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
        ].join("\n"),
        runDirectory,
        scenes: [sceneDescription("scene-one"), sceneDescription("scene-two")],
        sectionId: "demo-script",
      });

      expect(trims).toEqual([
        { durationMs: 1_250, sceneId: "scene-one", startMs: 750 },
        { durationMs: 1_350, sceneId: "scene-two", startMs: 2_000 },
      ]);
      expect((trims[0]?.startMs ?? 0) + (trims[0]?.durationMs ?? 0)).toBe(
        trims[1]?.startMs,
      );
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it.each([
    {
      expectedError: "not-json",
      markers: "[makeademo:scene] not-json",
      name: "malformed marker JSON",
    },
    {
      expectedError: "undeclared Scene marker scene-extra",
      markers: [
        sceneMarker({
          elapsedMs: 100,
          event: "started",
          sceneId: "scene-extra",
        }),
        sceneMarker({
          elapsedMs: 200,
          event: "succeeded",
          sceneId: "scene-extra",
        }),
      ].join("\n"),
      name: "undeclared Scene",
    },
    {
      expectedError: "nested Scene markers",
      markers: [
        sceneMarker({ elapsedMs: 100, event: "started", sceneId: "scene-one" }),
        sceneMarker({ elapsedMs: 150, event: "started", sceneId: "scene-two" }),
        sceneMarker({
          elapsedMs: 200,
          event: "succeeded",
          sceneId: "scene-two",
        }),
        sceneMarker({
          elapsedMs: 250,
          event: "succeeded",
          sceneId: "scene-one",
        }),
      ].join("\n"),
      name: "nested markers",
    },
    {
      expectedError: "duplicate markers for Scene scene-one",
      markers: [
        sceneMarker({ elapsedMs: 100, event: "started", sceneId: "scene-one" }),
        sceneMarker({
          elapsedMs: 200,
          event: "succeeded",
          sceneId: "scene-one",
        }),
        sceneMarker({ elapsedMs: 300, event: "started", sceneId: "scene-one" }),
        sceneMarker({
          elapsedMs: 400,
          event: "succeeded",
          sceneId: "scene-one",
        }),
      ].join("\n"),
      name: "duplicate markers",
    },
    {
      expectedError: "succeeded marker before start for Scene scene-one",
      markers: sceneMarker({
        elapsedMs: 100,
        event: "succeeded",
        sceneId: "scene-one",
      }),
      name: "terminal marker before start",
    },
  ])(
    "fails on capture-side $name",
    async ({ expectedError, markers }) => {
      const runDirectory = await recorderWorkspace();
      const rawVideoPath = join(runDirectory, "raw.webm");
      await writeFile(rawVideoPath, "raw video");
      const recorder = new DefaultPlaywrightSceneRecorder({
        rawVideoFinder: async () => rawVideoPath,
        sceneScriptRunner: async () => ({
          exitCode: 0,
          stderr: "",
          stdout: markers,
          timedOut: false,
        }),
      });

      try {
        await expect(
          recorder.recordScenes({
            baseUrl: "data:text/html,<main>MakeADemo</main>",
            demoPlaywrightScript: validDemoScript("scene-one"),
            runDirectory,
            scenes: [
              sceneDescription("scene-one"),
              sceneDescription("scene-two"),
            ],
            sectionId: "demo-script",
          }),
        ).rejects.toThrow(expectedError);
      } finally {
        await rm(runDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it("fails when a declared Scene starts but never emits an end marker", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    await writeFile(rawVideoPath, "raw video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: sceneMarker({
          elapsedMs: 100,
          event: "started",
          sceneId: "scene-one",
        }),
        timedOut: false,
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-one"),
          runDirectory,
          scenes: [sceneDescription("scene-one")],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("Scene start marker without an end marker");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("fails when Playwright does not create a raw video", async () => {
    const runDirectory = await recorderWorkspace();
    const recorder = new DefaultPlaywrightSceneRecorder({
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          sceneMarker({
            elapsedMs: 100,
            event: "started",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 200,
            event: "succeeded",
            sceneId: "scene-one",
          }),
        ].join("\n"),
        timedOut: false,
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-one"),
          runDirectory,
          scenes: [sceneDescription("scene-one")],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("No Playwright video was created");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("reports ffmpeg trim failures with the Scene ID", async () => {
    const runDirectory = await recorderWorkspace();
    const rawVideoPath = join(runDirectory, "raw.webm");
    await writeFile(rawVideoPath, "not a video");
    const recorder = new DefaultPlaywrightSceneRecorder({
      rawVideoFinder: async () => rawVideoPath,
      sceneScriptRunner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: [
          sceneMarker({
            elapsedMs: 100,
            event: "started",
            sceneId: "scene-one",
          }),
          sceneMarker({
            elapsedMs: 200,
            event: "succeeded",
            sceneId: "scene-one",
          }),
        ].join("\n"),
        timedOut: false,
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-one"),
          runDirectory,
          scenes: [sceneDescription("scene-one")],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("Failed to trim Scene scene-one with ffmpeg");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);
});

async function recorderWorkspace() {
  const runDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-recorder-test-"),
  );
  await symlink(
    join(process.cwd(), "node_modules"),
    join(runDirectory, "node_modules"),
  );
  return runDirectory;
}

function validDemoScript(sceneId: string) {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('main')).toBeVisible();",
    "});",
    `await scene(${JSON.stringify(sceneId)}, async ({ page, expect }) => {`,
    "  await expect(page.locator('main')).toBeVisible();",
    "});",
  ].join("\n");
}

function sceneDescription(
  id: string,
  actions?: NonNullable<
    Parameters<
      DefaultPlaywrightSceneRecorder["recordScenes"]
    >[0]["scenes"][number]["actions"]
  >,
) {
  return {
    ...(actions === undefined ? {} : { actions }),
    expectedVisibleOutcome: "Main content is visible.",
    humanReadableDescription: "Show main content.",
    id,
    type: "playwright-recording" as const,
  };
}

function sceneMarker(input: {
  elapsedMs: number;
  event: "failed" | "started" | "succeeded";
  sceneId: string;
}) {
  return `[makeademo:scene] ${JSON.stringify(input)}`;
}

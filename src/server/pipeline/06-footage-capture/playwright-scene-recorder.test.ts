import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspaceHandle } from "../../agent-harness/daytona/workspace.interface";
import { createFakeAgentHarnessWorkspace } from "../../agent-harness/daytona/workspace.test-helpers";
import { CaptureBrowserActionFailureError } from "./capture-runtime-protocol";
import { PreparedWorkspacePlaywrightSceneRecorder } from "./playwright-scene-recorder";

const execFileAsync = promisify(execFile);

describe("PreparedWorkspacePlaywrightSceneRecorder", () => {
  it("adds backend-owned Scene holds to the remote capture execution budget", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const submittedCommands: string[] = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
          exitCode: 1,
          stderr: "stopped after observing timeout",
          stdout: "",
        },
        submittedCommands,
      }),
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
      const preparedScript = await readFile(
        join(runDirectory, "work", "continuous-take", "demo-script.ts"),
        "utf8",
      );
      expect(preparedScript).toContain(
        'sceneHoldMsById: {"static-scene":3000,"interactive-scene":1000}',
      );
      const bunCommand = submittedCommands.find((command) =>
        command.includes("bun "),
      );
      expect(bunCommand).toContain("timeout -k 10s 214s");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("bounds a capture failure to a summary that references the retained logs", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
          exitCode: 1,
          stderr: `boom at the start\n${"x".repeat(100_000)}`,
          stdout: "",
        },
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-bounded"),
          runDirectory,
          scenes: [
            sceneDescription("scene-bounded", [
              { id: "open", path: "/", type: "goto" },
              {
                id: "show",
                locator: { strategy: "css", value: "main" },
                type: "assert-visible",
              },
            ]),
          ],
          sectionId: "demo-script",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message.length).toBeLessThanOrEqual(2_048);
        expect(message).toContain("stderr.log");
        return true;
      });
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("preserves the failed action identity from a continuous-take scene failure", async () => {
    // N137 (calcom, 2026-08-14): the real take emitted complete step/action
    // failure markers for return-availability, but Footage Capture replaced
    // them with a generic continuous-take exit error. Script Repair needs the
    // same {sceneId, actionId} identity the dry-run already consumes.
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const sceneId = "availability-settings";
    const actionId = "return-availability";
    const failureMessage =
      "goto: net::ERR_ABORTED at http://127.0.0.1:3000/availability";
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
          exitCode: 1,
          stdout: [
            sceneMarker({ elapsedMs: 1, event: "started", sceneId }),
            runtimeMarker("step", {
              elapsedMs: 2,
              event: "started",
              sceneId,
              stepId: actionId,
            }),
            runtimeMarker("action", {
              elapsedMs: 3,
              event: "started",
              label: "page.goto(http://127.0.0.1:3000/availability)",
              sceneId,
            }),
            runtimeMarker("action", {
              elapsedMs: 4,
              event: "failed",
              label: "page.goto(http://127.0.0.1:3000/availability)",
              message: failureMessage,
              sceneId,
            }),
            runtimeMarker("step", {
              elapsedMs: 4,
              event: "failed",
              message: failureMessage,
              sceneId,
              stepId: actionId,
            }),
            sceneMarker({
              elapsedMs: 4,
              event: "failed",
              sceneId,
            }),
          ].join("\n"),
        },
      }),
    });

    try {
      let caught: unknown;
      try {
        await recorder.recordScenes({
          baseUrl: "http://127.0.0.1:3000",
          demoPlaywrightScript: validDemoScript(sceneId),
          runDirectory,
          scenes: [
            sceneDescription(sceneId, [
              { id: actionId, path: "/availability", type: "goto" },
            ]),
          ],
          sectionId: "demo-script",
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CaptureBrowserActionFailureError);
      expect(caught).toMatchObject({ actionId, sceneId });
      expect((caught as Error).message).toContain("net::ERR_ABORTED");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("classifies a SIGKILLed capture as a timeout alongside exit 124", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: { exitCode: 137, stderr: "", stdout: "" },
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-timeout"),
          runDirectory,
          scenes: [
            sceneDescription("scene-timeout", [
              { id: "open", path: "/", type: "goto" },
              {
                id: "show",
                locator: { strategy: "css", value: "main" },
                type: "assert-visible",
              },
            ]),
          ],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow("timed out");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("clears the remote capture scratch before recording so retries start clean", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const submittedCommands: string[] = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: { exitCode: 1, stderr: "boom", stdout: "" },
        submittedCommands,
      }),
    });

    try {
      await expect(
        recorder.recordScenes({
          baseUrl: "data:text/html,<main>MakeADemo</main>",
          demoPlaywrightScript: validDemoScript("scene-clean"),
          runDirectory,
          scenes: [
            sceneDescription("scene-clean", [
              { id: "open", path: "/", type: "goto" },
              {
                id: "show",
                locator: { strategy: "css", value: "main" },
                type: "assert-visible",
              },
            ]),
          ],
          sectionId: "demo-script",
        }),
      ).rejects.toThrow();

      const cleanupIndex = submittedCommands.findIndex((command) =>
        command.startsWith("rm -rf "),
      );
      const captureIndex = submittedCommands.findIndex((command) =>
        command.includes("bun "),
      );
      expect(cleanupIndex).toBeGreaterThanOrEqual(0);
      expect(cleanupIndex).toBeLessThan(captureIndex);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("clamps pre-roll at the start of the continuous take", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
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
        },
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
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
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
        },
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
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const trims: Array<{ durationMs: number; startMs: number }> = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      clipTrimmer: async (input) => {
        trims.push({ durationMs: input.durationMs, startMs: input.startMs });
        await writeFile(input.outputVideoPath, "trimmed");
        return { durationSeconds: input.durationMs / 1000 };
      },
      postRollMs: 350,
      preRollMs: 250,
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
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
        },
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
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const trims: Array<{
      durationMs: number;
      sceneId: string;
      startMs: number;
    }> = [];
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
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
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
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
        },
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
      expectedError: "undeclared Scene",
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
      const runDirectory = await mkdtemp(
        join(tmpdir(), "makeademo-recorder-test-"),
      );
      const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
        preparationWorkspace: fakeCaptureWorkspace({
          bunResult: { stdout: markers },
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
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
          stdout: sceneMarker({
            elapsedMs: 100,
            event: "started",
            sceneId: "scene-one",
          }),
        },
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

  it("reports ffmpeg trim failures with the Scene ID", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-recorder-test-"),
    );
    const recorder = new PreparedWorkspacePlaywrightSceneRecorder({
      preparationWorkspace: fakeCaptureWorkspace({
        bunResult: {
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
        },
        rawTakeBytes: "not a video",
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

/**
 * Fakes the submitted-code sandbox seam the prepared-workspace recorder drives:
 * the remote `bun` run returns the given marker output, `find` reports one
 * recorded video, and the raw-take download materializes a local tar whose
 * continuous-take bytes are configurable so trim behavior can be exercised.
 */
function fakeCaptureWorkspace(input: {
  bunResult?: { exitCode?: number; stderr?: string; stdout?: string };
  rawTakeBytes?: string;
  submittedCommands?: string[];
}): AgentHarnessWorkspaceHandle {
  return {
    async destroy() {},
    id: "daytona_workspace",
    workspace: createFakeAgentHarnessWorkspace({
      async downloadSubmittedCodeFiles(files) {
        const archiveSource = await mkdtemp(
          join(tmpdir(), "makeademo-capture-output-"),
        );
        await mkdir(join(archiveSource, "raw-scenes"), { recursive: true });
        await writeFile(
          join(archiveSource, "raw-scenes", "continuous-take.webm"),
          input.rawTakeBytes ?? "raw take",
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
      async executeSubmittedCode(command) {
        input.submittedCommands?.push(command);
        if (command.includes("find ")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              "/workspace/.makeademo/footage-capture-runs/run/work/continuous-take/playwright-videos/raw.webm\n",
          };
        }
        if (command.includes("bun ")) {
          return {
            exitCode: input.bunResult?.exitCode ?? 0,
            stderr: input.bunResult?.stderr ?? "",
            stdout: input.bunResult?.stdout ?? "",
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    }),
  };
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
      PreparedWorkspacePlaywrightSceneRecorder["recordScenes"]
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

function runtimeMarker(
  kind: "action" | "step",
  input: Record<string, unknown>,
) {
  return `[makeademo:${kind}] ${JSON.stringify(input)}`;
}

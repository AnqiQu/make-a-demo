import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "./pipeline-event-logger";

describe("createPipelineEventLogger", () => {
  it("writes Pino-formatted JSONL with run context to every sink", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "makeademo-logs-"));
    const lines: string[] = [];

    try {
      const logPath = join(outputRoot, "pipeline-log.jsonl");
      const logger = createPipelineEventLogger({
        base: {
          component: "pipeline",
          runId: "run_123",
        },
        level: "debug",
        sinks: [
          createFilePipelineLogSink(logPath),
          {
            write(line) {
              lines.push(line);
            },
          },
        ],
        timestamp: () => "2026-06-17T00:00:00.000Z",
      });

      await logger.info(
        {
          event: "repo-preparation.started",
          stage: "repo-preparation",
          workspaceId: "workspace_123",
        },
        "Repo Preparation started.",
      );
      await logger.child({ stage: "script-generation" }).error(
        {
          errorMessage: "Script Generation failed.",
          event: "script-generation.failed",
        },
        "Script Generation failed.",
      );
      await logger.flush();

      const fileLines = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(fileLines).toEqual(lines.map((line) => line.trimEnd()));
      expect(fileLines.map((line) => JSON.parse(line))).toEqual([
        {
          component: "pipeline",
          event: "repo-preparation.started",
          level: "info",
          message: "Repo Preparation started.",
          runId: "run_123",
          service: "makeademo",
          stage: "repo-preparation",
          time: "2026-06-17T00:00:00.000Z",
          workspaceId: "workspace_123",
        },
        {
          component: "pipeline",
          errorMessage: "Script Generation failed.",
          event: "script-generation.failed",
          level: "error",
          message: "Script Generation failed.",
          runId: "run_123",
          service: "makeademo",
          stage: "script-generation",
          time: "2026-06-17T00:00:00.000Z",
        },
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("redacts common secret fields before writing", async () => {
    const lines: string[] = [];
    const logger = createPipelineEventLogger({
      sinks: [
        {
          write(line) {
            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await logger.info({ event: "agent.started", providerApiKey: "secret" });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "agent.started",
      providerApiKey: "[Redacted]",
    });
  });

  it("uses an entry message without writing duplicate message keys", async () => {
    const lines: string[] = [];
    const logger = createPipelineEventLogger({
      sinks: [
        {
          write(line) {
            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await logger.info({ event: "pipeline-started", message: "Started." });

    expect(countOccurrences(lines[0] ?? "", '"message"')).toBe(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "pipeline-started",
      message: "Started.",
    });
  });

  it("flushes writes from sinks that return promises", async () => {
    const lines: string[] = [];
    const logger = createPipelineEventLogger({
      sinks: [
        {
          write(line) {
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                lines.push(line);
                resolve();
              }, 0);
            });
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await logger.info({ event: "pipeline-started" });
    await logger.flush();

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "pipeline-started",
    });
  });

  it("waits for a normal promise-returning sink write before invoking the next write", async () => {
    const writtenEvents: string[] = [];
    let settleFirstWrite: (() => void) | undefined;
    const logger = createPipelineEventLogger({
      sinks: [
        {
          write(line) {
            writtenEvents.push(String(JSON.parse(line).event));

            if (writtenEvents.length === 1) {
              return new Promise<void>((resolve) => {
                settleFirstWrite = resolve;
              });
            }

            return Promise.resolve();
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const firstWrite = logger.info({ event: "first-event" });
    const secondWrite = logger.info({ event: "second-event" });
    await Promise.resolve();

    expect(writtenEvents).toEqual(["first-event"]);

    settleFirstWrite?.();
    await firstWrite;
    await secondWrite;

    expect(writtenEvents).toEqual(["first-event", "second-event"]);
  });

  it("waits for every sink to settle before recovering from a failed write", async () => {
    const slowSinkEvents: string[] = [];
    let settleFirstSlowSinkWrite: (() => void) | undefined;
    let failingSinkWriteCount = 0;
    const logger = createPipelineEventLogger({
      sinks: [
        {
          async write() {
            failingSinkWriteCount += 1;
            if (failingSinkWriteCount === 1) {
              throw new Error("temporary sink failure");
            }
          },
        },
        {
          write(line) {
            const event = String(JSON.parse(line).event);
            slowSinkEvents.push(event);

            if (event === "first-event") {
              return new Promise<void>((resolve) => {
                settleFirstSlowSinkWrite = resolve;
              });
            }

            return Promise.resolve();
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    const firstWrite = logger.info({ event: "first-event" });
    const secondWrite = logger.info({ event: "second-event" });
    const firstFailure = firstWrite.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(slowSinkEvents).toEqual(["first-event"]);

    settleFirstSlowSinkWrite?.();

    await expect(firstFailure).resolves.toMatchObject({
      message: "temporary sink failure",
    });
    await expect(secondWrite).resolves.toBeUndefined();
    expect(slowSinkEvents).toEqual(["first-event", "second-event"]);
  });

  it("propagates async sink write failures", async () => {
    const logger = createPipelineEventLogger({
      sinks: [
        {
          async write() {
            throw new Error("temporary sink failure");
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await expect(logger.info({ event: "first-event" })).rejects.toThrow(
      "temporary sink failure",
    );
  });

  it("continues writing later log calls after an async sink write fails", async () => {
    const lines: string[] = [];
    let writeCount = 0;
    const logger = createPipelineEventLogger({
      sinks: [
        {
          async write(line) {
            writeCount += 1;
            if (writeCount === 1) {
              throw new Error("temporary sink failure");
            }

            lines.push(line);
          },
        },
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await expect(logger.info({ event: "first-event" })).rejects.toThrow(
      "temporary sink failure",
    );
    await logger.info({ event: "second-event" });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: "second-event" }),
    ]);
  });

  it("formats Pino JSON lines for stdout pretty streaming", async () => {
    const prettyLines: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "full-pipeline" },
      sinks: [
        createPrettyPipelineLogSink({
          write(text) {
            prettyLines.push(text);
          },
        }),
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await logger.info(
      {
        event: "stage-progress",
        stage: "repo-preparation",
      },
      "Repo Preparation started.",
    );

    expect(prettyLines).toEqual([
      "[2026-06-17T00:00:00.000Z] INFO  full-pipeline/repo-preparation/stage-progress Repo Preparation started.\n",
    ]);
  });

  it("colors succeeded messages green and failed messages red", async () => {
    const prettyLines: string[] = [];
    const logger = createPipelineEventLogger({
      base: { component: "full-pipeline" },
      sinks: [
        createPrettyPipelineLogSink({
          write(text) {
            prettyLines.push(text);
          },
        }),
      ],
      timestamp: () => "2026-06-17T00:00:00.000Z",
    });

    await logger.info(
      {
        event: "repo-preparation.succeeded",
        stage: "repo-preparation",
      },
      "Repo Preparation succeeded.",
    );
    await logger.info(
      {
        event: "script-generation.failed",
        stage: "script-generation",
      },
      "Script Generation failed.",
    );

    expect(prettyLines).toEqual([
      "\u001b[32m[2026-06-17T00:00:00.000Z] INFO  full-pipeline/repo-preparation/repo-preparation.succeeded Repo Preparation succeeded.\u001b[39m\n",
      "\u001b[31m[2026-06-17T00:00:00.000Z] INFO  full-pipeline/script-generation/script-generation.failed Script Generation failed.\u001b[39m\n",
    ]);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

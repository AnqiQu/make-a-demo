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
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

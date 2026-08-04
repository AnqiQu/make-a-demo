import { describe, expect, it } from "vitest";
import { sanitizeObservabilityError } from "./pipeline-observer";

import { createJsonPipelineObserver } from "./pipeline-observer";

describe("createJsonPipelineObserver", () => {
  it("writes sanitized newline-delimited JSON observability events", async () => {
    const lines: string[] = [];
    const observer = createJsonPipelineObserver({
      now: () => "2026-06-14T00:00:00.000Z",
      service: "makeademo-worker",
      write: (line) => lines.push(line),
    });

    observer.record({
      demoRequestId: "demo-request-1",
      durationMs: 42,
      event: "stage.succeeded",
      projectId: "project-1",
      sceneCount: 3,
      stage: "compositing",
      status: "succeeded",
      workspaceId: "workspace-1",
    });
    await Promise.resolve();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      demoRequestId: "demo-request-1",
      durationMs: 42,
      event: "stage.succeeded",
      level: "info",
      projectId: "project-1",
      sceneCount: 3,
      service: "makeademo-worker",
      stage: "compositing",
      status: "succeeded",
      time: "2026-06-14T00:00:00.000Z",
      workspaceId: "workspace-1",
    });
  });
});

describe("sanitizeObservabilityError", () => {
  it("bounds a project record error to 2 KB however large the stream was", () => {
    const sanitized = sanitizeObservabilityError(
      new Error(
        `Scene continuous-take failed with exit code 1.\n${"x".repeat(100_000)}`,
      ),
    );

    expect(sanitized.errorType).toBe("Error");
    expect(sanitized.errorMessage.length).toBeLessThanOrEqual(2_048);
    expect(sanitized.errorMessage).toContain(
      "Scene continuous-take failed with exit code 1.",
    );
  });
});

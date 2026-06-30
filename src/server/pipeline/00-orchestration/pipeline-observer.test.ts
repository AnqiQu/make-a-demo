import { describe, expect, it } from "vitest";

import { createJsonPipelineObserver } from "./pipeline-observer";

describe("createJsonPipelineObserver", () => {
  it("writes sanitized newline-delimited JSON observability events", () => {
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

import { describe, expect, it, vi } from "vitest";

import {
  type PreparationWorkspaceProvider,
  runInPreparationWorkspace,
} from "./preparation-workspace-runner";
import type { PreparationWorkspace } from "./preparation-workspace.interface";

describe("runInPreparationWorkspace", () => {
  it("creates a workspace, returns the agent result, and destroys the workspace", async () => {
    const events: string[] = [];
    const provider = fakeProvider(events);

    const result = await runInPreparationWorkspace({
      provider,
      run: async (handle) => {
        events.push(`run:${handle.id}`);
        return "prepared";
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ status: "succeeded", value: "prepared" });
    expect(events).toEqual(["create", "run:workspace_123", "destroy"]);
  });

  it("blocks network and destroys the workspace when the agent run times out", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const provider = fakeProvider(events);
    const runPromise = runInPreparationWorkspace({
      provider,
      run: () => new Promise(() => undefined),
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    const result = await runPromise;

    expect(result).toEqual({
      reason: "Repo Preparation agent timed out after 10ms.",
      status: "timed-out",
    });
    expect(events).toEqual(["create", "network:blocked", "destroy"]);
    vi.useRealTimers();
  });
});

function fakeProvider(events: string[]): PreparationWorkspaceProvider {
  return {
    async create() {
      events.push("create");
      return {
        async destroy() {
          events.push("destroy");
        },
        id: "workspace_123",
        workspace: fakeWorkspace(events),
      };
    },
  };
}

function fakeWorkspace(events: string[]): PreparationWorkspace {
  return {
    async execute(command) {
      events.push(`execute:${command}`);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess(enabled) {
      events.push(enabled ? "network:unblocked" : "network:blocked");
    },
    async uploadFiles() {},
  };
}

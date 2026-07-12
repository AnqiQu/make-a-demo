import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeSession } from "./daytona-opencode-session";

describe("DaytonaOpenCodeSession", () => {
  it("returns a completed Demo Script validation handoff without cancelling the workspace", async () => {
    const events: string[] = [];
    const workspace: PreparationWorkspace = {
      async execute(_command, options) {
        options?.onStdout?.(
          `${JSON.stringify({ tool: "makeademo_validate_demo_script", input: { demoScriptPath: "/workspace/.makeademo/demo-script.json" }, state: { status: "completed" } })}\n`,
        );
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async cancelActiveCommands() {
        events.push("cancelled");
      },
      async getPreviewUrl() {
        return "http://localhost";
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles() {},
    };
    const session = new DaytonaOpenCodeSession({
      modelID: "gpt-5.5",
      providerID: "openai",
    });
    const result = await session.run({
      attempt: 1,
      hardDeadlineAt: Date.now() + 10_000,
      hardTimeoutMs: 10_000,
      inactivityTimeoutMs: 1_000,
      prompt: "validate",
      sessionID: "session_1",
      stage: "script-generation",
      workspace,
    });
    await Promise.resolve();
    expect(result.completedToolPayload?.toolName).toBe(
      "makeademo_validate_demo_script",
    );
    expect(events).toEqual([]);
  });
});

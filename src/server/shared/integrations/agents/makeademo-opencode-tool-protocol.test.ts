import { describe, expect, it } from "vitest";

import {
  createMakeADemoOpenCodeProtocolTracker,
  readOpenCodeProtocolResult,
} from "./makeademo-opencode-tool-protocol";

describe("MakeADemo OpenCode tool protocol", () => {
  it("recognizes the demo-script validation payload only after completion", () => {
    const tracker = createMakeADemoOpenCodeProtocolTracker();
    tracker.write(
      `${JSON.stringify({ tool: "makeademo_validate_demo_script", input: { demoScriptPath: "/workspace/.makeademo/demo-script.json" }, state: { status: "running" } })}\n`,
    );
    expect(tracker.readPayload()).toEqual({
      input: { demoScriptPath: "/workspace/.makeademo/demo-script.json" },
      toolName: "makeademo_validate_demo_script",
    });
    expect(tracker.readCompletedPayload()).toBeUndefined();

    tracker.write(
      `${JSON.stringify({ tool: "makeademo_validate_demo_script", input: { demoScriptPath: "/workspace/.makeademo/demo-script.json" }, state: { status: "completed" } })}\n`,
    );
    expect(tracker.readCompletedPayload()).toEqual({
      input: { demoScriptPath: "/workspace/.makeademo/demo-script.json" },
      toolName: "makeademo_validate_demo_script",
    });
  });

  it("reports malformed demo-script tool input without treating it as complete", () => {
    const result = readOpenCodeProtocolResult(
      `${JSON.stringify({ tool: "makeademo_validate_demo_script", state: { status: "completed" }, input: {} })}\n`,
    );
    expect(result.payload).toBeUndefined();
    expect(result.payloadError).toBe(
      "makeademo_validate_demo_script payload is missing required field input.demoScriptPath",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  createMakeADemoOpenCodeProtocolTracker,
  parseOpenCodeJsonPayload,
  readOpenCodeProtocolResult,
} from "./makeademo-opencode-tool-protocol";

describe("MakeADemo OpenCode tool protocol", () => {
  it("parses text events into a JSON payload", () => {
    expect(
      parseOpenCodeJsonPayload(
        [
          JSON.stringify({ type: "text", part: { text: '{"status":' } }),
          JSON.stringify({
            type: "text",
            part: { text: '"succeeded"}' },
          }),
        ].join("\n"),
      ),
    ).toEqual({ status: "succeeded" });
  });

  it("tracks a tool payload split across arbitrary chunks", () => {
    const tracker = createMakeADemoOpenCodeProtocolTracker();
    const line = `${JSON.stringify({
      part: {
        input: { manifestPath: "/tmp/preparation-manifest.json" },
        tool: "makeademo_validate_preparation",
        type: "tool-call",
      },
      type: "message.part",
    })}\n`;

    tracker.write(line.slice(0, 17));
    tracker.write(line.slice(17));

    expect(tracker.readPayload()).toEqual({
      input: { manifestPath: "/tmp/preparation-manifest.json" },
      toolName: "makeademo_validate_preparation",
    });
  });

  it.each([
    [
      "missing command",
      "makeademo_dependency_request_install",
      { input: {} },
      "input.command",
    ],
    [
      "missing manifest path",
      "makeademo_validate_preparation",
      { input: {} },
      "input.manifestPath",
    ],
    [
      "malformed JSON",
      "makeademo_validate_preparation",
      '{"input":',
      "not parseable JSON",
    ],
  ])(
    "reports %s payload errors without inventing a payload",
    (_label, tool, input, field) => {
      const output =
        typeof input === "string"
          ? `{"toolName":"${tool}",${input.slice(1)}\n`
          : `${JSON.stringify({ toolName: tool, ...input })}\n`;
      const result = readOpenCodeProtocolResult(output);
      expect(result.payload).toBeUndefined();
      expect(result.payloadError).toContain(field);
    },
  );

  it("keeps the latest valid tool and payload across noisy output", () => {
    const result = readOpenCodeProtocolResult(
      [
        "noise makeademo_dependency_request_install",
        JSON.stringify({
          toolName: "makeademo_dependency_request_install",
          args: { command: "bun install" },
        }),
        "more noise makeademo_validate_preparation",
        JSON.stringify({
          part: {
            input: { manifestPath: "/tmp/manifest.json" },
            tool: "makeademo_validate_preparation",
          },
        }),
      ].join("\n"),
    );

    expect(result.tool).toBe("makeademo_validate_preparation");
    expect(result.payload).toEqual({
      input: { manifestPath: "/tmp/manifest.json" },
      toolName: "makeademo_validate_preparation",
    });
  });

  it("returns only completed payloads for cancellation decisions", () => {
    const tracker = createMakeADemoOpenCodeProtocolTracker();
    tracker.write(
      `${JSON.stringify({
        part: {
          state: {
            input: { manifestPath: "/tmp/manifest.json" },
            status: "completed",
          },
          tool: "makeademo_validate_preparation",
        },
        type: "tool_use",
      })}\n`,
    );

    expect(tracker.readCompletedPayload()).toEqual({
      input: { manifestPath: "/tmp/manifest.json" },
      toolName: "makeademo_validate_preparation",
    });
  });

  it("extracts session IDs from supported OpenCode event shapes", () => {
    const tracker = createMakeADemoOpenCodeProtocolTracker();
    tracker.write(`${JSON.stringify({ session: { id: "session_123" } })}\n`);
    expect(tracker.readSessionID()).toBe("session_123");
  });
});

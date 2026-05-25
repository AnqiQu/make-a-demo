import { CliTurnRenderer } from "../../../src/apps/cli/render";

test("CLI renderer streams text deltas inline instead of line-per-token", () => {
  const renderer = new CliTurnRenderer();

  const output = [
    renderer.render({ type: "text.delta", delta: "I" }),
    renderer.render({ type: "text.delta", delta: "'m" }),
    renderer.render({ type: "text.delta", delta: " here." }),
    renderer.render({ type: "completed" }),
  ].join("");

  expect(output).toBe("I'm here.\n");
});

test("CLI renderer streams reasoning deltas inline instead of line-per-token", () => {
  const renderer = new CliTurnRenderer();

  const output = [
    renderer.render({ type: "reasoning_summary.delta", delta: "I" }),
    renderer.render({ type: "reasoning_summary.delta", delta: " should" }),
    renderer.render({ type: "reasoning_summary.delta", delta: " inspect." }),
    renderer.render({ type: "completed" }),
  ].join("");

  expect(output).toBe("[reasoning] I should inspect.\n");
});

test("CLI renderer puts labeled metadata events on their own lines", () => {
  const renderer = new CliTurnRenderer();

  const output = [
    renderer.render({ type: "text.delta", delta: "Before" }),
    renderer.render({
      type: "tool_call",
      callId: "call_1",
      name: "bash",
      input: {},
    }),
    renderer.render({
      type: "tool_result",
      callId: "call_1",
      name: "bash",
      output: "unavailable",
      isError: true,
    }),
    renderer.render({ type: "text.delta", delta: "After" }),
    renderer.render({ type: "completed" }),
  ].join("");

  expect(output).toBe(
    "Before\n[tool call] bash call_1\n[tool result] error: unavailable\nAfter\n",
  );
});

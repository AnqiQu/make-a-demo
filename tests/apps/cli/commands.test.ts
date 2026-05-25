import { applyCliSettingsCommand } from "../../../src/apps/cli/commands";

test("CLI settings commands patch branch-local response settings", () => {
  const initial = {
    model: "gpt-5.1",
    reasoning: { effort: "medium", summary: "auto" },
    responseOverrides: {},
  };

  expect(applyCliSettingsCommand(initial, "/model gpt-5.2")).toEqual({
    model: "gpt-5.2",
    reasoning: { effort: "medium", summary: "auto" },
    responseOverrides: {},
  });
  expect(applyCliSettingsCommand(initial, "/reasoning high")).toEqual({
    model: "gpt-5.1",
    reasoning: { effort: "high", summary: "auto" },
    responseOverrides: {},
  });
  expect(
    applyCliSettingsCommand(initial, '/set-json {"temperature":0.1}'),
  ).toEqual({
    model: "gpt-5.1",
    reasoning: { effort: "medium", summary: "auto" },
    responseOverrides: { temperature: 0.1 },
  });
});

import { describe, expect, it } from "vitest";
import { collectTerminalDemoInput } from "./terminal-demo-runner";

describe("collectTerminalDemoInput", () => {
  it("prompts for repo context and defaults Demo length to 30 seconds", async () => {
    const answers = [
      "https://github.com/acme/calendar",
      "Scheduling automation for teams",
      "Operations managers",
      "calendar view, booking flow",
      "",
    ];

    const input = await collectTerminalDemoInput({
      question: async () => answers.shift() ?? "",
    });

    expect(input).toEqual({
      demoLengthSeconds: 30,
      importantFeatures: ["calendar view", "booking flow"],
      productSummary: "Scheduling automation for teams",
      repoUrl: "https://github.com/acme/calendar",
      targetUsers: "Operations managers",
    });
  });
});

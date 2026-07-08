import { describe, expect, it } from "vitest";
import {
  collectTerminalDemoInput,
  runTerminalDemoPipeline,
} from "./terminal-demo-runner";

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

describe("runTerminalDemoPipeline", () => {
  it("delegates terminal input to the default pipeline rails", async () => {
    const input = {
      demoLengthSeconds: 30,
      importantFeatures: ["calendar view"],
      repoUrl: "https://github.com/acme/calendar",
    };
    const result = {
      artifactDirectory: "artifacts",
      captureManifestPath: "capture-manifest.json",
      compositeManifestPath: "composite-manifest.json",
      finalVideoPath: "final-video.mp4",
      logPath: "pipeline-log.jsonl",
      pipelineManifestPath: "pipeline-run-manifest.json",
      runDirectory: "run",
      scriptPath: "demo-script.json",
    };
    const calls: unknown[] = [];

    await expect(
      runTerminalDemoPipeline(input, {
        async runPipeline(receivedInput) {
          calls.push(receivedInput);
          return result;
        },
      }),
    ).resolves.toBe(result);
    expect(calls).toEqual([input]);
  });
});

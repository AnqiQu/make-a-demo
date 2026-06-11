import { describe, expect, it } from "vitest";

import { collectStage1CliOptions } from "./stage1-cli-interactive";

describe("collectStage1CliOptions", () => {
  it("collects Stage 1 options through deterministic prompts", async () => {
    const answers = [
      "https://github.com/example/app",
      "validation dashboard, script package",
      "./brief.md, ./setup-notes.txt",
      "openai",
      "gpt-5.5",
      "workspace-demo",
    ];

    const options = await collectStage1CliOptions({
      prompt: async () => answers.shift() ?? "",
      write: () => {},
    });

    expect(options).toEqual({
      docs: ["./brief.md", "./setup-notes.txt"],
      features: ["validation dashboard", "script package"],
      modelID: "gpt-5.5",
      providerID: "openai",
      repoUrl: "https://github.com/example/app",
      workspaceId: "workspace-demo",
    });
  });

  it("re-prompts with guidance when an answer is invalid", async () => {
    const answers = [
      "not github",
      "https://github.com/example/app",
      "",
      "validation dashboard",
      "",
      "",
      "",
      "",
    ];
    const messages: string[] = [];

    const options = await collectStage1CliOptions({
      prompt: async () => answers.shift() ?? "",
      write: (message) => messages.push(message),
    });

    expect(options.repoUrl).toBe("https://github.com/example/app");
    expect(options.features).toEqual(["validation dashboard"]);
    expect(messages).toContain(
      "Invalid repo URL. Use a GitHub HTTPS URL like https://github.com/owner/repo.",
    );
    expect(messages).toContain(
      "Invalid features. Provide at least one feature, separated by commas.",
    );
  });
});

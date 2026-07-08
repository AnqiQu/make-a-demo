import { describe, expect, it } from "vitest";
import {
  type OpenCodeHarnessRunInput,
  type OpenCodeHarnessRunResult,
  type OpenCodeHarnessRunner,
  type OpenCodeHarnessStage,
  createStagePrompt,
} from "./opencode-harness";

describe("OpenCode harness seam", () => {
  it("builds stage prompts around durable artifact paths", () => {
    const stage: OpenCodeHarnessStage = "script-writing";

    expect(
      createStagePrompt({
        artifactPaths: [
          "/workspace/.makeademo/preparation-manifest.json",
          "/workspace/.makeademo/flow-spec.json",
        ],
        instructions: "Write the script without editing app source.",
        stage,
      }),
    ).toContain("/workspace/.makeademo/flow-spec.json");
  });

  it("keeps runner inputs and outputs explicit for stage-specific execution", async () => {
    const runner: OpenCodeHarnessRunner = {
      async run(
        input: OpenCodeHarnessRunInput,
      ): Promise<OpenCodeHarnessRunResult> {
        return {
          exitCode: 0,
          sessionId: input.sessionId ?? "session_new",
          stderr: "",
          stdout: input.stage,
        };
      },
    };

    await expect(
      runner.run({
        availableTools: ["read-manifest"],
        configDir: "/tmp/makeademo/opencode",
        model: "openai/gpt-5",
        prompt: "Use artifacts.",
        stage: "repo-preparation",
        timeoutMs: 1000,
        workingDirectory: "/workspace",
        workspace: {
          async destroy() {
            return undefined;
          },
          async execute() {
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      }),
    ).resolves.toMatchObject({
      sessionId: "session_new",
      stdout: "repo-preparation",
    });
  });
});

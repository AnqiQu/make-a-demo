import { describe, expect, it } from "vitest";
import { DefaultOpenCodeHarnessRunner } from "./default-opencode-harness-runner";
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

  it("creates the OpenCode config directory before running OpenCode", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();

    await expect(
      runner.run({
        availableTools: ["read", "write", "bash"],
        configDir: "/tmp/makeademo/opencode",
        model: "openai/gpt-5",
        prompt: "Use artifacts.",
        stage: "repo-preparation",
        timeoutMs: 1000,
        workingDirectory: "/workspace/repo",
        workspace: {
          async destroy() {
            return undefined;
          },
          async execute(command, options) {
            if (!command.startsWith("mkdir -p '/tmp/makeademo/opencode' && ")) {
              return {
                exitCode: 1,
                stderr:
                  "NotFound: FileSystem.writeFile (/tmp/makeademo/opencode/.gitignore)",
                stdout: "",
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: options?.env?.OPENCODE_CONFIG_DIR ?? "",
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/tmp/makeademo/opencode",
    });
  });

  it("starts a new OpenCode session without resuming a made-up session", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();

    await expect(
      runner.run({
        availableTools: ["read", "write", "bash"],
        configDir: "/tmp/makeademo/opencode",
        model: "openai/gpt-5",
        prompt: "Use artifacts.",
        stage: "repo-preparation",
        timeoutMs: 1000,
        workingDirectory: "/workspace/repo",
        workspace: {
          async destroy() {
            return undefined;
          },
          async execute(command) {
            if (command.includes(" --session ")) {
              return {
                exitCode: 1,
                stderr: "Error: Session not found",
                stdout: "",
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: `${JSON.stringify({ sessionID: "ses_repo_prepare" })}\n`,
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      sessionId: "ses_repo_prepare",
    });
  });
});

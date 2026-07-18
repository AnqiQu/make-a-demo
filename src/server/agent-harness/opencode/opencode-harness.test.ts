import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspaceExecuteOptions } from "../daytona/workspace.interface";
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

  it("applies stage deadlines and streams OpenCode output to the caller", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();
    let executeOptions: AgentHarnessWorkspaceExecuteOptions | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const input: OpenCodeHarnessRunInput & {
      onStderr(chunk: string): void;
      onStdout(chunk: string): void;
    } = {
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      inactivityTimeoutMs: 321,
      model: "openai/gpt-5",
      onStderr: (chunk) => stderr.push(chunk),
      onStdout: (chunk) => stdout.push(chunk),
      prompt: "Prepare the repo.",
      stage: "repo-preparation",
      timeoutMs: 1_234,
      workingDirectory: "/workspace/repo",
      workspace: {
        async destroy() {},
        async execute(_command, options) {
          executeOptions = options;
          options?.onStdout?.("progress\n");
          options?.onStderr?.("warning\n");
          return { exitCode: 0, stderr: "", stdout: "progress\n" };
        },
      },
    };

    await runner.run(input);

    expect(executeOptions?.timeoutMs).toBe(1_234);
    expect(executeOptions?.inactivityTimeoutMs).toBe(321);
    expect(stdout).toEqual(["progress\n"]);
    expect(stderr).toEqual(["warning\n"]);
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

  it("enforces stage tools with an inline deny-by-default OpenCode policy", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();
    let command = "";
    let environment: Record<string, string> = {};

    await runner.run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt: "Write the Demo Script.",
      stage: "script-writing",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: {
        async destroy() {},
        async execute(receivedCommand, options) {
          command = receivedCommand;
          environment = options?.env ?? {};
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      permission?: Record<string, unknown>;
      share?: string;
    };
    expect(command).toContain("opencode run --pure");
    expect(environment.OPENCODE_ENABLE_EXA).toBe("0");
    expect(config.share).toBe("disabled");
    expect(config.permission).toMatchObject({
      "*": "deny",
      bash: "deny",
      edit: {
        "*": "deny",
        "../.makeademo/demo-script.json": "allow",
      },
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
    });
  });

  it("allows Repo Preparation edits inside the repo but only its own external artifact", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();
    let configContent = "{}";

    await runner.run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt: "Prepare the repo.",
      stage: "repo-preparation",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: {
        async destroy() {},
        async execute(_command, options) {
          configContent = options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}";
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    const config = JSON.parse(configContent) as {
      permission: { edit: Record<string, string> };
    };
    expect(config.permission.edit).toMatchObject({
      "**": "allow",
      "../.makeademo/**": "deny",
      "../.makeademo/preparation-manifest.json": "allow",
      "/workspace/repo/**": "allow",
    });
    expect(Object.keys(config.permission.edit)).toEqual([
      "*",
      "**",
      "/workspace/repo/**",
      "../.makeademo/**",
      "../.makeademo/preparation-manifest.json",
    ]);
  });

  it("authorizes every stage artifact using OpenCode worktree-relative paths", async () => {
    const cases: Array<{
      artifacts: string[];
      stage: OpenCodeHarnessStage;
    }> = [
      {
        artifacts: [
          "../.makeademo/action-catalog.json",
          "../.makeademo/app-map.json",
        ],
        stage: "app-exploration",
      },
      {
        artifacts: ["../.makeademo/flow-spec.json"],
        stage: "flow-planning",
      },
      {
        artifacts: ["../.makeademo/preparation-manifest.json"],
        stage: "repo-preparation-repair",
      },
      {
        artifacts: ["../.makeademo/runtime-target-selection.json"],
        stage: "runtime-target-selection",
      },
      {
        artifacts: ["../.makeademo/demo-script.json"],
        stage: "script-repair",
      },
    ];

    for (const testCase of cases) {
      let configContent = "{}";
      await new DefaultOpenCodeHarnessRunner().run({
        availableTools: ["read", "write"],
        configDir: "/tmp/makeademo/opencode",
        model: "openai/gpt-5",
        prompt: "Write the stage artifact.",
        stage: testCase.stage,
        timeoutMs: 1000,
        workingDirectory: "/workspace/repo",
        workspace: {
          async destroy() {},
          async execute(_command, options) {
            configContent = options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}";
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      });
      const config = JSON.parse(configContent) as {
        permission: { edit: Record<string, string> };
      };
      for (const artifact of testCase.artifacts) {
        expect(config.permission.edit[artifact]).toBe("allow");
      }
    }
  });
});

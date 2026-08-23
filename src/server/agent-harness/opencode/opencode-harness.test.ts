import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspaceExecuteOptions } from "../daytona/workspace.interface";
import { createFakeAgentHarnessWorkspace } from "../daytona/workspace.test-helpers";
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
        workspace: createFakeAgentHarnessWorkspace(),
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
        workspace: createFakeAgentHarnessWorkspace({
          async execute(command, options) {
            const mkdirAt = command.indexOf(
              "mkdir -p '/tmp/makeademo/opencode' && ",
            );
            if (mkdirAt === -1 || command.indexOf("opencode run") < mkdirAt) {
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
        }),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/tmp/makeademo/opencode",
    });
  });

  it("keeps a silent working OpenCode run alive with CPU heartbeats", async () => {
    // The no-output watchdog killed working agents 43 times in one matrix
    // (2026-08-09): a long tool call streams nothing while it works. The
    // runner brackets OpenCode with the CPU-liveness sampler so silence
    // with progress stays alive and silence without progress still dies.
    const runner = new DefaultOpenCodeHarnessRunner();
    const commands: string[] = [];

    await runner.run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt: "Prepare the repo.",
      stage: "repo-preparation",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: createFakeAgentHarnessWorkspace({
        async execute(command) {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    });

    const command = commands.find((entry) => entry.includes("opencode run"));
    expect(command).toContain("[makeademo:alive] cpu");
    // The heartbeat wrapper must preserve OpenCode's own exit status.
    expect(command).toContain('sh -c "exit $makeademo_alive_status"');
  });

  it("installs the agent-liveness plugin in the config dir before launching", async () => {
    // A model can stream tokens for longer than the inactivity window
    // without touching the terminal (silent tool calls, long thinking);
    // the plugin turns event-bus activity into throttled stderr beats the
    // PTY watchdog can hear. OpenCode auto-loads `<configDir>/plugin/`.
    const events: string[] = [];
    const writes: Array<{ contents: string; path: string }> = [];

    await new DefaultOpenCodeHarnessRunner().run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt: "Prepare the repo.",
      stage: "repo-preparation",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: createFakeAgentHarnessWorkspace({
        async execute() {
          events.push("execute");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async writeTextFile(path, contents) {
          events.push("write");
          writes.push({ contents, path });
        },
      }),
    });

    const pluginWrite = writes.find(
      (write) =>
        write.path === "/tmp/makeademo/opencode/plugin/agent-liveness.js",
    );
    expect(pluginWrite?.contents).toContain("[makeademo:agent-alive]");
    expect(events.indexOf("execute")).toBeGreaterThan(
      events.lastIndexOf("write"),
    );
  });

  it("applies stage deadlines and streams OpenCode output to the caller", async () => {
    const runner = new DefaultOpenCodeHarnessRunner();
    let executeOptions: AgentHarnessWorkspaceExecuteOptions | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const activityFilter = (chunk: string) => chunk.length > 0;
    const input: OpenCodeHarnessRunInput & {
      onStderr(chunk: string): void;
      onStdout(chunk: string): void;
    } = {
      activityFilter,
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
      workspace: createFakeAgentHarnessWorkspace({
        async execute(_command, options) {
          executeOptions = options;
          options?.onStdout?.("progress\n");
          options?.onStderr?.("warning\n");
          return { exitCode: 0, stderr: "", stdout: "progress\n" };
        },
      }),
    };

    await runner.run(input);

    expect(executeOptions?.timeoutMs).toBe(1_234);
    expect(executeOptions?.inactivityTimeoutMs).toBe(321);
    expect(executeOptions?.activityFilter).toBe(activityFilter);
    expect(stdout).toEqual(["progress\n"]);
    expect(stderr).toEqual(["warning\n"]);
  });

  it("transports the prompt by file instead of a shell argument", async () => {
    // A single-line shell argument travels through the sandbox PTY's
    // canonical line discipline, which truncates lines around 4KB
    // (MAX_CANON) — silently corrupting large stage prompts. The prompt must
    // reach OpenCode through a file the command reads back, keeping the
    // command line small regardless of prompt size.
    const runner = new DefaultOpenCodeHarnessRunner();
    const prompt = `Write the FlowSpec.\n${"evidence line\n".repeat(400)}`;
    const events: string[] = [];
    const writes: Array<{ contents: string; path: string }> = [];
    let command = "";

    await runner.run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt,
      stage: "flow-planning",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: createFakeAgentHarnessWorkspace({
        async execute(receivedCommand) {
          events.push("execute");
          command = receivedCommand;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async writeTextFile(path, contents) {
          events.push("write");
          writes.push({ contents, path });
        },
      }),
    });

    const promptWrite = writes.find((write) => write.contents === prompt);
    expect(promptWrite).toBeDefined();
    expect(events[0]).toBe("write");
    expect(command).toContain(promptWrite?.path ?? "");
    expect(command).not.toContain("evidence line");
  });

  it("elides the middle of a prompt that would exceed the argv transport limit", async () => {
    // The run command expands the prompt file back into a single execve
    // argument via "$(cat …)"; Linux caps one argument around 128KB
    // (MAX_ARG_STRLEN). Past it, bash reports "Argument list too long" and
    // OpenCode exits 126 without ever launching — so the runner must keep
    // every stage prompt under the limit, preserving its head and tail.
    const runner = new DefaultOpenCodeHarnessRunner();
    const prompt = `HEAD-MARKER\n${"y".repeat(400_000)}\nTAIL-MARKER`;
    const writes: Array<{ contents: string; path: string }> = [];

    await runner.run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt,
      stage: "flow-planning",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: createFakeAgentHarnessWorkspace({
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async writeTextFile(path, contents) {
          writes.push({ contents, path });
        },
      }),
    });

    const promptWrite = writes.find(({ path }) => path.includes("prompt-"));
    expect(promptWrite).toBeDefined();
    expect(promptWrite?.contents.length ?? 0).toBeLessThan(100_000);
    expect(promptWrite?.contents).toContain("HEAD-MARKER");
    expect(promptWrite?.contents).toContain("TAIL-MARKER");
    expect(promptWrite?.contents).toContain("characters elided");
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
        workspace: createFakeAgentHarnessWorkspace({
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
        }),
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
      workspace: createFakeAgentHarnessWorkspace({
        async execute(receivedCommand, options) {
          command = receivedCommand;
          environment = options?.env ?? {};
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
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
      workspace: createFakeAgentHarnessWorkspace({
        async execute(_command, options) {
          configContent = options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}";
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    });

    const config = JSON.parse(configContent) as {
      permission: { edit: Record<string, string> };
    };
    expect(config.permission.edit).toMatchObject({
      "**": "allow",
      "../.makeademo/**": "deny",
      "../.makeademo/preparation-manifest.json": "allow",
      "/workspace/.makeademo/**": "deny",
      "/workspace/.makeademo/preparation-manifest.json": "allow",
      "/workspace/repo/**": "allow",
    });
    expect(Object.keys(config.permission.edit)).toEqual([
      "*",
      "**",
      "/workspace/repo/**",
      "../.makeademo/**",
      "/workspace/.makeademo/**",
      "../.makeademo/preparation-manifest.json",
      "/workspace/.makeademo/preparation-manifest.json",
    ]);
  });

  it("authorizes artifact writes addressed absolutely as well as relatively", async () => {
    // 2026-08-03 homer run: whether a legal flow-spec write survived depended
    // on how the model spelled the path, because the table registered only
    // workingDirectory-relative globs. Both spellings must resolve identically.
    let configContent = "{}";
    await new DefaultOpenCodeHarnessRunner().run({
      availableTools: ["read", "write"],
      configDir: "/tmp/makeademo/opencode",
      model: "openai/gpt-5",
      prompt: "Write the FlowSpec.",
      stage: "flow-planning",
      timeoutMs: 1000,
      workingDirectory: "/workspace/repo",
      workspace: createFakeAgentHarnessWorkspace({
        async execute(_command, options) {
          configContent = options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}";
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    });

    const config = JSON.parse(configContent) as {
      permission: { edit: Record<string, string> };
    };
    expect(config.permission.edit["../.makeademo/flow-spec.json"]).toBe(
      "allow",
    );
    expect(config.permission.edit["/workspace/.makeademo/flow-spec.json"]).toBe(
      "allow",
    );
    expect(config.permission.edit["../.makeademo/**"]).toBe("deny");
    expect(config.permission.edit["/workspace/.makeademo/**"]).toBe("deny");
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
        artifacts: ["../.makeademo/repair-advice.json"],
        stage: "repair-strategy",
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
        workspace: createFakeAgentHarnessWorkspace({
          async execute(_command, options) {
            configContent = options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}";
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        }),
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

import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";

describe("DaytonaOpenCodeRepoPreparationAgent", () => {
  it("clones the submitted repo and runs OpenCode inside Daytona", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events),
      providerApiKey: "openai_key",
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual([
      { network: true },
      {
        execute:
          "mkdir -p /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && git clone --depth 1 'https://github.com/example/app' /workspace",
      },
      { network: false },
      {
        execute: expect.stringContaining("plugins/makeademo-tools.ts"),
      },
      {
        configDir: "/workspace/.makeademo/opencode",
        execute: expect.stringContaining("opencode run"),
        streaming: true,
      },
      {
        execute: expect.stringContaining(
          "/workspace/.makeademo/dependency-install-request.json",
        ),
      },
    ]);
    expect(streamed).toEqual(["stdout:opencode output"]);

    const command = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(command).not.toContain("OPENCODE_ENABLE_EXA");
    expect(command).not.toContain("OPENAI_API_KEY");
    expect(command).toContain("opencode run");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("--dir /workspace");
    expect(command).toContain("--model 'openai/gpt-5.5'");
  });

  it("handles custom tool dependency install requests in the retained Daytona workspace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider(events, {
        commandStdout: [
          "Dependency install requested.",
          JSON.stringify(successResult()),
        ],
        dependencyInstallRequest: { command: "bun install" },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual([
      { network: true },
      {
        execute:
          "mkdir -p /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && git clone --depth 1 'https://github.com/example/app' /workspace",
      },
      { network: false },
      {
        execute: expect.stringContaining("plugins/makeademo-tools.ts"),
      },
      {
        configDir: "/workspace/.makeademo/opencode",
        execute: expect.stringContaining("opencode run"),
        streaming: false,
      },
      {
        execute: expect.stringContaining(
          "/workspace/.makeademo/dependency-install-request.json",
        ),
      },
      { network: true },
      { execute: "bun install" },
      { network: false },
      {
        execute: expect.stringContaining(
          "/workspace/.makeademo/dependency-install-request.json",
        ),
      },
      {
        configDir: "/workspace/.makeademo/opencode",
        execute: expect.stringContaining("opencode run"),
        streaming: false,
      },
    ]);
  });
});

function fakeProvider(
  events: unknown[],
  input:
    | string[]
    | {
        commandStdout?: string[];
        dependencyInstallRequest?: { command: string };
      } = [JSON.stringify(successResult())],
): PreparationWorkspaceProvider {
  const workspaceInput = Array.isArray(input)
    ? { commandStdout: input }
    : input;

  return {
    async create() {
      return {
        async destroy() {
          events.push({ destroy: "daytona_workspace" });
        },
        id: "daytona_workspace",
        workspace: fakeWorkspace(events, workspaceInput),
      };
    },
  };
}

function fakeWorkspace(
  events: unknown[],
  input: {
    commandStdout?: string[];
    dependencyInstallRequest?: { command: string };
  },
): PreparationWorkspace {
  const commandStdout = input.commandStdout ?? [
    JSON.stringify(successResult()),
  ];

  return {
    async execute(command, options) {
      events.push({
        execute: command,
        ...(command.includes("opencode run")
          ? {
              configDir: options?.env?.OPENCODE_CONFIG_DIR,
              streaming:
                options?.onStdout !== undefined ||
                options?.onStderr !== undefined,
            }
          : {}),
      });
      options?.onStdout?.("opencode output");
      if (
        command.startsWith("if test -f") &&
        command.includes("dependency-install-request.json")
      ) {
        return {
          exitCode: input.dependencyInstallRequest === undefined ? 1 : 0,
          stderr: "",
          stdout:
            input.dependencyInstallRequest === undefined
              ? ""
              : JSON.stringify(input.dependencyInstallRequest),
        };
      }
      if (
        command.includes("plugins/makeademo-tools.ts") ||
        command.startsWith("rm -f")
      ) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command === "bun install") {
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: command.includes("git clone")
          ? "cloned"
          : (commandStdout.shift() ?? ""),
      };
    },
    async setOutboundNetworkAccess(enabled) {
      events.push({ network: enabled });
    },
    async uploadFiles() {
      throw new Error("Repo Preparation should clone inside Daytona.");
    },
  };
}

function successResult() {
  return {
    manifest: {
      assumptions: [],
      createdFiles: [],
      demoCommand: "npm run demo:makeademo",
      diffArtifactId: "artifact_diff",
      existingDemoEvidence: [],
      mockedServices: [],
      modifiedFiles: [],
      repoUrl: "https://github.com/example/app",
      risks: [],
      scriptGenerationContext: [],
      setupSummary: "Prepared demo runtime.",
      status: "created-new-demo",
      url: "http://localhost:3000",
      workspaceId: "workspace_123",
    },
    status: "succeeded",
  };
}

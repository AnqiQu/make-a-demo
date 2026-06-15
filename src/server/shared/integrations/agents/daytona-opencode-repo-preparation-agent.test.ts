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
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
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
    expect(events).toEqual(
      expect.arrayContaining([
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
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/repo-preparation-result.json",
          ),
        },
      ]),
    );
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
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          "Submitted preparation result.",
        ],
        dependencyInstallRequest: { command: "bun install" },
        preparationResult: successResult(),
        validationResult: validationArtifact(),
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
      opencodeSessionID: "session_123",
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual(
      expect.arrayContaining([
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
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/repo-preparation-result.json",
          ),
        },
      ]),
    );
    const openCodeCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      )
      .map((event) => event.execute);
    expect(openCodeCommands).toHaveLength(2);
    expect(openCodeCommands[0]).not.toContain("--session");
    expect(openCodeCommands[1]).toContain("--session 'session_123'");
  });

  it("returns a successful preparation result as soon as backend validation passes", async () => {
    const events: unknown[] = [];
    const validations: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async (input) => {
        validations.push(input);
        return {
          blockedNetworkAttempts: [],
          logs: ["loaded preview"],
          screenshotArtifactId: "artifact_screenshot",
          status: "succeeded",
          warnings: [],
        };
      },
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
      validation: { status: "succeeded" },
      workspace: { id: "daytona_workspace" },
    });
    expect(validations).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ url: "http://localhost:3000" }),
        workspace: expect.objectContaining({ id: "daytona_workspace" }),
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/validation-request.json",
          ),
        },
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/validation-result.json",
          ),
        },
      ]),
    );
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(1);
  });

  it("preserves the OpenCode session ID from streamed output when validation passes", async () => {
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider([], {
        commandStdout: ["Validation requested."],
        commandStdoutChunks: [
          `${JSON.stringify({ sessionID: "session_streamed_123", type: "step_start" })}\n`,
        ],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        logs: ["validated"],
        status: "succeeded",
        warnings: [],
      }),
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      opencodeSessionID: "session_streamed_123",
      status: "succeeded",
    });
  });

  it("returns malformed manifest handoff failures to the agent as validation feedback", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider(events, {
        commandStdout: [
          "Validation requested.",
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        manifestPayload: { demoCommand: "npm run demo" },
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: ["Agent received validation feedback."],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("opencode run"),
      ),
    ).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining(
            '"failureReason":"Preparation manifest handoff is invalid: status must be a non-empty string"',
          ),
        },
      ]),
    );
  });

  it("writes a Daytona-side preparation debug log during the agent loop", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerApiKey: "openai_key",
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/repo-preparation-debug.jsonl",
          ),
        },
        {
          execute: expect.stringContaining('"event":"opencode-started"'),
        },
        {
          execute: expect.stringContaining(
            '"event":"preparation-result-found"',
          ),
        },
      ]),
    );
  });

  it("mirrors streamed OpenCode output into Daytona attempt log files", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStderrChunks: ["agent warning"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerApiKey: "openai_key",
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(streamed).toEqual(["stdout:agent output", "stderr:agent warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/opencode-attempt-1.stdout.log",
          ),
        },
        {
          execute: expect.stringContaining("agent output"),
        },
        {
          execute: expect.stringContaining(
            "/workspace/.makeademo/opencode-attempt-1.stderr.log",
          ),
        },
        {
          execute: expect.stringContaining("agent warning"),
        },
      ]),
    );
  });

  it("fails fast instead of starting backend validation when the preparation deadline is nearly exhausted", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider(events, {
        commandDelayMs: 920,
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath: "/workspace/.makeademo/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => {
        validationStarted = true;
        return validationArtifact().validation;
      },
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        "Repo Preparation ran out of time before backend validation could start.",
      ],
      status: "failed",
    });
    expect(validationStarted).toBe(false);
  });
});

function fakeProvider(
  events: unknown[],
  input:
    | string[]
    | {
        commandStdout?: string[];
        commandStderrChunks?: string[];
        commandStdoutChunks?: string[];
        commandDelayMs?: number;
        dependencyInstallRequest?: { command: string };
        manifestPayload?: unknown;
        preparationResult?: ReturnType<typeof successResult>;
        validationRequest?: {
          manifestPath: string;
        };
        validationResult?: ReturnType<typeof validationArtifact>;
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
    commandStderrChunks?: string[];
    commandStdoutChunks?: string[];
    commandDelayMs?: number;
    dependencyInstallRequest?: { command: string };
    manifestPayload?: unknown;
    preparationResult?: ReturnType<typeof successResult>;
    validationRequest?: {
      manifestPath: string;
    };
    validationResult?: ReturnType<typeof validationArtifact>;
  },
): PreparationWorkspace {
  const commandStdout = input.commandStdout ?? [
    JSON.stringify(successResult()),
  ];
  let dependencyInstallRequest = input.dependencyInstallRequest;
  let validationRequest = input.validationRequest;
  let validationResult = input.validationResult;

  return {
    async execute(command, options) {
      if (
        command.includes("opencode run") &&
        input.commandDelayMs !== undefined
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, input.commandDelayMs),
        );
      }
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
      for (const chunk of input.commandStdoutChunks ?? ["opencode output"]) {
        options?.onStdout?.(chunk);
      }
      for (const chunk of input.commandStderrChunks ?? []) {
        options?.onStderr?.(chunk);
      }
      if (command.includes("repo-preparation-debug.jsonl")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command.includes("opencode-attempt-") && command.includes(".log")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("dependency-install-request.json")
      ) {
        return {
          exitCode: dependencyInstallRequest === undefined ? 1 : 0,
          stderr: "",
          stdout:
            dependencyInstallRequest === undefined
              ? ""
              : JSON.stringify(dependencyInstallRequest),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("validation-request.json")
      ) {
        return {
          exitCode: validationRequest === undefined ? 1 : 0,
          stderr: "",
          stdout:
            validationRequest === undefined
              ? ""
              : JSON.stringify(validationRequest),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("preparation-manifest.json")
      ) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            input.manifestPayload ?? successResult().manifest,
          ),
        };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("validation-result.json")
      ) {
        return {
          exitCode: validationResult === undefined ? 1 : 0,
          stderr: "",
          stdout:
            validationResult === undefined
              ? ""
              : JSON.stringify(validationResult),
        };
      }
      if (
        command.startsWith("mkdir -p") &&
        command.includes("validation-result.json")
      ) {
        const match = command.match(
          /MAKEADEMO_VALIDATION_RESULT\n([\s\S]*)\nMAKEADEMO_VALIDATION_RESULT/,
        );
        validationResult =
          match?.[1] === undefined
            ? validationArtifact()
            : JSON.parse(match[1]);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (
        command.startsWith("if test -f") &&
        command.includes("repo-preparation-result.json")
      ) {
        return {
          exitCode: input.preparationResult === undefined ? 1 : 0,
          stderr: "",
          stdout:
            input.preparationResult === undefined
              ? ""
              : JSON.stringify(input.preparationResult),
        };
      }
      if (
        command.includes("plugins/makeademo-tools.ts") ||
        command.startsWith("rm -f")
      ) {
        if (command.includes("dependency-install-request.json")) {
          dependencyInstallRequest = undefined;
        }
        if (command.includes("validation-request.json")) {
          validationRequest = undefined;
        }
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
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async uploadFiles() {
      throw new Error("Repo Preparation should clone inside Daytona.");
    },
  };
}

function validationArtifact() {
  return {
    manifest: successResult().manifest,
    status: "succeeded",
    validation: {
      blockedNetworkAttempts: [],
      logs: ["validated"],
      status: "succeeded" as const,
      warnings: [],
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

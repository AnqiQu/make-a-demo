import { describe, expect, it, vi } from "vitest";

import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type {
  PreparationWorkspace,
  PreparationWorkspaceCommandResult,
} from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { createPipelineEventLogger } from "../../logging/pipeline-event-logger";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";

describe("DaytonaOpenCodeRepoPreparation", () => {
  it("clones the submitted repo and runs OpenCode inside Daytona", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
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
      status: "succeeded",
      workspace: { id: "daytona_workspace" },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        {
          execute: expect.stringContaining("sudo mkdir -p '/workspace'"),
        },
        {
          execute: expect.stringContaining(
            "git clone --depth 1 'https://github.com/example/app' '/workspace'",
          ),
        },
        { network: false },
        {
          execute: expect.stringContaining("plugins/makeademo-tools.ts"),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/repo-preparation-result.json",
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
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain("--dir /workspace");
    expect(command).toContain("--model 'openai/gpt-5.5'");

    const cloneCommands = events
      .filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("git clone"),
      )
      .map((event) => event.execute);
    expect(cloneCommands).toHaveLength(1);
    expect(cloneCommands[0]).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(cloneCommands[0]).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(cloneCommands[0]).toContain("/etc/openshell-tls/ca-bundle.pem");
    expect(cloneCommands[0]).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(cloneCommands[0]).not.toContain("GIT_SSL_NO_VERIFY");
    expect(cloneCommands[0]).not.toContain("sslVerify=false");
  });

  it("mirrors streamed OpenCode chunks to the sandbox audit log", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
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
    });
    expect(streamed).toEqual(["stdout:agent output", "stderr:agent warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            channel: "stdout",
            event: "opencode.output",
            raw: "agent output",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            channel: "stderr",
            event: "opencode.output",
            raw: "agent warning",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
  });

  it("continues Repo Preparation when streamed OpenCode activity log writes fail", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      provider: fakeProvider(events, {
        commandStderrChunks: ["agent warning"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "opencode.output",
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
      status: "succeeded",
    });
    expect(streamed).toEqual(["stdout:agent output", "stderr:agent warning"]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("continues Repo Preparation when streamed OpenCode activity log writes never settle", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["agent output"],
        preparationResult: successResult(),
        sandboxLogNeverSettlesEvent: "opencode.output",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await Promise.race([
      agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      }),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
    });
  });

  it("continues Repo Preparation when sandbox progress logging fails", async () => {
    const events: unknown[] = [];
    const pipelineLogs: Array<Record<string, unknown>> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new DaytonaOpenCodeRepoPreparation({
      logger: createPipelineEventLogger({
        base: { component: "repo-preparation-agent" },
        sinks: [
          {
            write(line) {
              pipelineLogs.push(JSON.parse(line) as Record<string, unknown>);
            },
          },
        ],
      }),
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    try {
      const result = await agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      });

      expect(result).toMatchObject({
        manifest: { demoCommand: "npm run demo:makeademo" },
        status: "succeeded",
      });
      expect(warn).not.toHaveBeenCalled();
      expect(pipelineLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            component: "repo-preparation-agent",
            error: "sandbox log sink failed",
            event: "sandbox-log-write-failed",
            failedEvent: "workspace-created",
            level: "warn",
            stage: "repo-preparation",
            workspaceComponent: "sandbox-log",
          }),
        ]),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("continues Repo Preparation when sandbox progress logging fails and fallback warning logging hangs", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      logger: {
        child() {
          return this;
        },
        debug: vi.fn(async () => {}),
        error: vi.fn(async () => {}),
        flush: vi.fn(async () => {}),
        info: vi.fn(async () => {}),
        warn: vi.fn(() => new Promise<void>(() => {})),
      },
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        sandboxLogFailureEvent: "workspace-created",
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    const result = await Promise.race([
      agent.prepare({
        normalizedSupportingDocuments: [],
        repoUrl: "https://github.com/example/app",
        structuredDemoIntent: { keyProductFeatures: ["validation"] },
        workspaceId: "workspace_123",
      }),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);

    expect(result).toMatchObject({
      manifest: { demoCommand: "npm run demo:makeademo" },
      status: "succeeded",
    });
  });

  it("retries transient Daytona clone connection failures before starting OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        cloneResults: [
          new Error(
            "DaytonaConnectionError: connect ECONNREFUSED 127.0.0.1:443",
          ),
          { exitCode: 0, stderr: "", stdout: "cloned" },
        ],
        commandStdout: ["Submitted preparation result."],
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

    expect(result).toMatchObject({ status: "succeeded" });
    expect(
      events.filter(
        (event): event is { execute: string } =>
          typeof event === "object" &&
          event !== null &&
          "execute" in event &&
          typeof event.execute === "string" &&
          event.execute.includes("git clone"),
      ),
    ).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        { network: false },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("reports pre-OpenCode git clone failures as Repo Preparation clone blockers", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        cloneResults: [
          {
            exitCode: 128,
            stderr:
              "fatal: unable to access 'https://github.com/example/app/': server certificate verification failed. CAfile: none CRLfile: none",
            stdout: "",
          },
        ],
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
      blockers: [
        expect.stringMatching(
          /^(?!.*OpenCode exited)[\s\S]*Repo Preparation could not clone the submitted repository[\s\S]*server certificate verification failed/,
        ),
      ],
      status: "failed",
      suggestedChanges: [
        "Retry Repo Preparation after the submitted repository can be cloned from the Daytona workspace.",
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        { network: true },
        { network: false },
        { destroy: "daytona_workspace" },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
      ]),
    );
  });

  it("handles custom tool dependency install requests in the retained Daytona workspace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
          execute: expect.stringContaining("sudo mkdir -p '/workspace'"),
        },
        {
          execute: expect.stringContaining(
            "git clone --depth 1 'https://github.com/example/app' '/workspace'",
          ),
        },
        { network: false },
        {
          execute: expect.stringContaining("plugins/makeademo-tools.ts"),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        { submittedCodeNetwork: true },
        { submittedCodeExecute: "bun install" },
        { submittedCodeNetwork: false },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/dependency-install-request.json",
          ),
        },
        {
          configDir: "/tmp/makeademo/opencode",
          execute: expect.stringContaining("opencode run"),
          streaming: true,
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/repo-preparation-result.json",
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

  it("logs Repo Preparation retries with the reason before resuming OpenCode", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
          JSON.stringify({
            assumptions: [],
            blockers: ["Agent received validation feedback."],
            status: "failed",
            suggestedChanges: [],
          }),
        ],
        dependencyInstallRequest: { command: "bun install" },
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureReason: "Preview requested https://api.example.test/articles.",
        logs: ["external runtime request blocked"],
        status: "failed",
        warnings: ["network mock needed"],
      }),
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(events).toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            nextAttempt: 2,
            reason: "dependency-install-completed",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            nextAttempt: 3,
            reason: "Preview requested https://api.example.test/articles.",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
  });

  it("fails fast when preparation preflight cannot restore submitted-code files", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureKind: "submitted-code-workspace-sync-failed",
        failureReason:
          "Failed to sync prepared files to submitted-code workspace.",
        logs: ["Failed to sync prepared files to submitted-code workspace."],
        status: "failed",
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
      blockers: [
        expect.stringContaining(
          "non-retryable MakeADemo infrastructure failure",
        ),
      ],
      status: "failed",
    });
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
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
          }),
        },
      ]),
    );
  });

  it("retries preparation preflight feedback when restore-looking text has no failure kind", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
        },
      }),
      providerID: "openai",
      timeoutMs: 1_000,
      validatePreparation: async () => ({
        blockedNetworkAttempts: [],
        failureReason:
          'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
        logs: [
          'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
        ],
        status: "failed",
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
      blockers: ["Agent received validation feedback."],
      status: "failed",
    });
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
          sandboxLog: expect.objectContaining({
            event: "repo-preparation.retrying",
            reason:
              'Failed to restore prepared files in submitted-code sandbox (exit code 2). stderr: sh: 1: Syntax error: "(" unexpected',
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-preflight.non-retryable-failure",
          }),
        },
      ]),
    );
  });

  it("reseals submitted-code network when dependency installation times out", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: [
          JSON.stringify({ sessionID: "session_123", type: "session" }),
        ],
        dependencyInstallRequest: { command: "bun install" },
        submittedCodeNeverSettles: true,
      }),
      providerID: "openai",
      timeoutMs: 150,
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(events).toEqual(
      expect.arrayContaining([
        { submittedCodeNetwork: true },
        { submittedCodeExecute: "bun install" },
        { cancelActiveCommands: true },
        { submittedCodeNetwork: false },
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([{ destroy: "daytona_workspace" }]),
    );
  });

  it("returns a successful preparation result as soon as preparation preflight passes", async () => {
    const events: unknown[] = [];
    const validations: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
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
            "/tmp/makeademo/submitted-code/validation-request.json",
          ),
        },
        {
          execute: expect.stringContaining(
            "/tmp/makeademo/submitted-code/validation-result.json",
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
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider([], {
        commandStdout: ["Validation requested."],
        commandStdoutChunks: [
          `${JSON.stringify({ sessionID: "session_streamed_123", type: "step_start" })}\n`,
        ],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
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

  it("returns malformed manifest handoff failures to the agent as preparation preflight feedback", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
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
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
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
          sandboxLog: expect.objectContaining({
            event: "preparation-preflight.finished",
            failureReason:
              "Preparation manifest handoff is invalid: status must be a non-empty string",
            stage: "repo-preparation",
            status: "failed",
          }),
        },
      ]),
    );
  });

  it("clones the submitted repo into the submitted-code workspace when available", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, [JSON.stringify(successResult())]),
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
          submittedCodeExecute: expect.stringContaining(
            "sudo mkdir -p '/workspace'",
          ),
        },
        {
          submittedCodeExecute: expect.stringContaining(
            "git clone --depth 1 'https://github.com/example/app' '/workspace'",
          ),
        },
      ]),
    );
    const submittedCodeClone = events.find(
      (event): event is { submittedCodeExecute: string } =>
        typeof event === "object" &&
        event !== null &&
        "submittedCodeExecute" in event &&
        typeof event.submittedCodeExecute === "string" &&
        event.submittedCodeExecute.includes("git clone"),
    )?.submittedCodeExecute;
    expect(submittedCodeClone).toContain("/etc/ssl/certs/ca-certificates.crt");
    expect(submittedCodeClone).toContain("/etc/pki/tls/certs/ca-bundle.crt");
    expect(submittedCodeClone).toContain("/etc/openshell-tls/ca-bundle.pem");
    expect(submittedCodeClone).toMatch(/export GIT_SSL_CAINFO=.*git clone/s);
    expect(submittedCodeClone).not.toContain("GIT_SSL_NO_VERIFY");
    expect(submittedCodeClone).not.toContain("sslVerify=false");
    expect(events).toEqual(
      expect.arrayContaining([
        { submittedCodeNetwork: true },
        { submittedCodeNetwork: false },
      ]),
    );
  });

  it("writes Repo Preparation lifecycle events to the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStdout: ["Submitted preparation result."],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
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
          sandboxLog: expect.objectContaining({
            event: "opencode-started",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            event: "preparation-result-found",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("repo-preparation-debug.jsonl") },
      ]),
    );
  });

  it("mirrors meaningful streamed OpenCode output into the sandbox Pino log seam", async () => {
    const events: unknown[] = [];
    const streamed: string[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
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
          sandboxLog: expect.objectContaining({
            channel: "stdout",
            event: "opencode.output",
            raw: "agent output",
            stage: "repo-preparation",
          }),
        },
        {
          sandboxLog: expect.objectContaining({
            channel: "stderr",
            event: "opencode.output",
            raw: "agent warning",
            stage: "repo-preparation",
          }),
        },
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        { execute: expect.stringContaining("opencode-activity.jsonl") },
        { execute: expect.stringContaining("opencode-attempt-1.stdout.log") },
        { execute: expect.stringContaining("opencode-attempt-1.stderr.log") },
      ]),
    );
  });

  it("filters terminal-control-only OpenCode chunks out of the sandbox audit log", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandStderrChunks: ["\r"],
        commandStdout: ["Submitted preparation result."],
        commandStdoutChunks: ["\r\r", "\u001b[?25h", ">"],
        preparationResult: successResult(),
        validationResult: validationArtifact(),
      }),
      providerID: "openai",
      timeoutMs: 1_000,
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation"] },
      workspaceId: "workspace_123",
    });

    expect(events).not.toEqual(
      expect.arrayContaining([
        { sandboxLog: expect.objectContaining({ raw: "\r\r" }) },
        { sandboxLog: expect.objectContaining({ raw: "\u001b[?25h" }) },
        { sandboxLog: expect.objectContaining({ raw: ">" }) },
        { sandboxLog: expect.objectContaining({ raw: "\r" }) },
      ]),
    );
  });

  it("fails fast instead of starting preparation preflight when the preparation deadline is nearly exhausted", async () => {
    const events: unknown[] = [];
    let validationStarted = false;
    const agent = new DaytonaOpenCodeRepoPreparation({
      modelID: "gpt-5.5",
      provider: fakeProvider(events, {
        commandDelayMs: 920,
        commandStdout: ["Validation requested."],
        validationRequest: {
          manifestPath:
            "/tmp/makeademo/submitted-code/preparation-manifest.json",
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
        "Repo Preparation ran out of time before preparation preflight could start.",
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
        cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
        dependencyInstallRequest?: { command: string };
        manifestPayload?: unknown;
        preparationResult?: ReturnType<typeof successResult>;
        queuedSandboxLogWrites?: boolean;
        sandboxLogFailureEvent?: string;
        sandboxLogNeverSettlesEvent?: string;
        submittedCodeNeverSettles?: boolean;
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
    cloneResults?: Array<PreparationWorkspaceCommandResult | Error>;
    dependencyInstallRequest?: { command: string };
    manifestPayload?: unknown;
    preparationResult?: ReturnType<typeof successResult>;
    queuedSandboxLogWrites?: boolean;
    sandboxLogFailureEvent?: string;
    sandboxLogNeverSettlesEvent?: string;
    submittedCodeNeverSettles?: boolean;
    validationRequest?: {
      manifestPath: string;
    };
    validationResult?: ReturnType<typeof validationArtifact>;
  },
): PreparationWorkspace {
  const commandStdout = input.commandStdout ?? [
    JSON.stringify(successResult()),
  ];
  const cloneResults = [...(input.cloneResults ?? [])];
  let dependencyInstallRequest = input.dependencyInstallRequest;
  let sandboxLogChain = Promise.resolve();
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
        throw new Error(
          "outer workspace execution must not install dependencies",
        );
      }
      if (command.includes("git clone") && cloneResults.length > 0) {
        const cloneResult = cloneResults.shift();
        if (cloneResult instanceof Error) {
          throw cloneResult;
        }
        return cloneResult ?? { exitCode: 0, stderr: "", stdout: "cloned" };
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
    async executeSubmittedCode(command) {
      events.push({ submittedCodeExecute: command });
      if (command.includes("git clone")) {
        return { exitCode: 0, stderr: "", stdout: "cloned submitted" };
      }
      if (command === "bun install") {
        if (input.submittedCodeNeverSettles === true) {
          await new Promise(() => {});
        }
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      throw new Error(`Unexpected submitted-code command: ${command}`);
    },
    async setSubmittedCodeNetworkAccess(enabled) {
      events.push({ submittedCodeNetwork: enabled });
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async cancelActiveCommands() {
      events.push({ cancelActiveCommands: true });
      events.push({ submittedCodeNetwork: false });
    },
    async uploadFiles() {
      throw new Error("Repo Preparation should clone inside Daytona.");
    },
    writeSandboxLog(entry) {
      const write = async () => {
        events.push({ sandboxLog: entry });
        if (entry.event === input.sandboxLogNeverSettlesEvent) {
          await new Promise(() => {});
        }
        if (entry.event === input.sandboxLogFailureEvent) {
          throw new Error("sandbox log sink failed");
        }
      };
      if (input.queuedSandboxLogWrites !== true) {
        return write();
      }

      sandboxLogChain = sandboxLogChain.then(write, write);
      return sandboxLogChain;
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

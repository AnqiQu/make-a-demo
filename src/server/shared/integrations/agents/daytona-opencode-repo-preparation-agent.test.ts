import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";

describe("DaytonaOpenCodeRepoPreparationAgent", () => {
  it("clones the submitted repo and runs OpenCode inside Daytona", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
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
      { execute: expect.stringContaining("opencode run") },
    ]);

    const command = events.find(
      (event): event is { execute: string } =>
        typeof event === "object" &&
        event !== null &&
        "execute" in event &&
        typeof event.execute === "string" &&
        event.execute.includes("opencode run"),
    )?.execute;
    expect(command).toContain("OPENCODE_ENABLE_EXA=1");
    expect(command).toContain("OPENAI_API_KEY='openai_key'");
    expect(command).toContain("opencode run");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("--dir /workspace");
    expect(command).toContain("--model 'openai/gpt-5.5'");
  });

  it("handles dependency install network-window requests in the retained Daytona workspace", async () => {
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      provider: fakeProvider(events, [
        JSON.stringify({
          command: "bun install",
          securityReviewOutcomes: [
            accept("dependency-reviewer"),
            accept("runtime-security-reviewer"),
            accept("obfuscation-deception-auditor"),
            accept("prompt-injection-reviewer"),
          ],
          status: "needs-dependency-install",
        }),
        "installed",
        JSON.stringify(successResult()),
      ]),
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
      { execute: expect.stringContaining("opencode run") },
      { network: true },
      { execute: "bun install" },
      { network: false },
      { execute: expect.stringContaining("Continue Repo Preparation") },
    ]);
  });
});

function fakeProvider(
  events: unknown[],
  commandStdout: string[] = [JSON.stringify(successResult())],
): PreparationWorkspaceProvider {
  return {
    async create() {
      return {
        async destroy() {
          events.push({ destroy: "daytona_workspace" });
        },
        id: "daytona_workspace",
        workspace: fakeWorkspace(events, commandStdout),
      };
    },
  };
}

function fakeWorkspace(
  events: unknown[],
  commandStdout: string[],
): PreparationWorkspace {
  return {
    async execute(command) {
      events.push({ execute: command });
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

function accept(reviewer: string) {
  return {
    evidence: [],
    reason: "No blocking security findings.",
    reviewer,
    status: "accepted",
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

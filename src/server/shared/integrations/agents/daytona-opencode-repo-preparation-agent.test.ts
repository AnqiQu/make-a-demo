import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PreparationWorkspaceProvider } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";

describe("DaytonaOpenCodeRepoPreparationAgent", () => {
  it("uploads the screened workspace and runs OpenCode inside Daytona", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "makeademo-source-"));
    await writeFile(join(sourceDirectory, "package.json"), "{}", "utf8");
    await mkdir(join(sourceDirectory, "src"));
    await writeFile(join(sourceDirectory, "src/app.ts"), "export {};", "utf8");
    const events: unknown[] = [];
    const agent = new DaytonaOpenCodeRepoPreparationAgent({
      modelID: "gpt-5.5",
      provider: fakeProvider(events),
      providerID: "openai",
      sourceDirectory,
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
      expect(events).toContainEqual({
        upload: [
          {
            destinationPath: "/workspace/package.json",
            sourcePath: join(sourceDirectory, "package.json"),
          },
          {
            destinationPath: "/workspace/src/app.ts",
            sourcePath: join(sourceDirectory, "src/app.ts"),
          },
        ],
      });
      expect(events).toContainEqual({ network: false });
      const command = events.find(
        (event): event is { execute: string } =>
          typeof event === "object" && event !== null && "execute" in event,
      )?.execute;
      expect(command).toContain("OPENCODE_ENABLE_EXA=1");
      expect(command).toContain("opencode run");
      expect(command).toContain("--dangerously-skip-permissions");
      expect(command).toContain("--dir /workspace");
      expect(command).toContain("--model 'openai/gpt-5.5'");
      expect(events.at(-1)).toEqual({ destroy: "daytona_workspace" });
    } finally {
      await rm(sourceDirectory, { force: true, recursive: true });
    }
  });
});

function fakeProvider(events: unknown[]): PreparationWorkspaceProvider {
  return {
    async create() {
      return {
        async destroy() {
          events.push({ destroy: "daytona_workspace" });
        },
        id: "daytona_workspace",
        workspace: fakeWorkspace(events),
      };
    },
  };
}

function fakeWorkspace(events: unknown[]): PreparationWorkspace {
  return {
    async execute(command) {
      events.push({ execute: command });
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
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
        }),
      };
    },
    async setOutboundNetworkAccess(enabled) {
      events.push({ network: enabled });
    },
    async uploadFiles(files) {
      events.push({ upload: files });
    },
  };
}

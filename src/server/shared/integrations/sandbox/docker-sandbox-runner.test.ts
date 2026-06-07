import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DockerSandboxRunner } from "./docker-sandbox-runner";

describe("DockerSandboxRunner", () => {
  it("runs install and demo commands in the prepared workspace", async () => {
    const workspaceRoot = await createWorkspace({
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { demo: "vite" } }),
    });
    const calls: Array<{ command: string; cwd: string }> = [];
    const runner = new DockerSandboxRunner({
      commandRunner: async ({ command, cwd }) => {
        calls.push({ command, cwd });
        return { exitCode: 0, logs: [`ran ${command}`] };
      },
      workspaceRoot,
    });

    const result = await runner.runValidation({
      demoCommand: "npm run demo:makeademo",
      preparationManifest: manifest("workspace_123"),
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(calls).toEqual([
      { command: "bun install", cwd: join(workspaceRoot, "workspace_123") },
      {
        command: "npm run demo:makeademo",
        cwd: join(workspaceRoot, "workspace_123"),
      },
    ]);
    expect(result).toMatchObject({
      blockedNetworkAttempts: [],
      logs: ["ran bun install", "ran npm run demo:makeademo"],
      repoFiles: ["bun.lock", "package.json"],
      runtimeExitCode: 0,
    });
  });
});

async function createWorkspace(files: Record<string, string>) {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "makeademo-sandbox-test-"),
  );
  const workspaceDirectory = join(workspaceRoot, "workspace_123");
  await mkdir(workspaceDirectory, { recursive: true });

  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(workspaceDirectory, file), contents);
  }

  return workspaceRoot;
}

function manifest(workspaceId: string) {
  return {
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
    status: "created-new-demo" as const,
    url: "http://localhost:3000",
    workspaceId,
  };
}

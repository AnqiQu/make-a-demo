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
    const calls: Array<{
      command: string;
      cwd: string;
      mode: string;
      readyUrl?: string;
    }> = [];
    const runner = new DockerSandboxRunner({
      commandRunner: async ({ command, cwd, mode, readyUrl }) => {
        calls.push({ command, cwd, mode, ...(readyUrl ? { readyUrl } : {}) });
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
      {
        command: "bun install",
        cwd: join(workspaceRoot, "workspace_123"),
        mode: "exit",
      },
      {
        command: "npm run demo:makeademo",
        cwd: join(workspaceRoot, "workspace_123"),
        mode: "start",
        readyUrl: "http://localhost:3000",
      },
    ]);
    expect(result).toMatchObject({
      blockedNetworkAttempts: [],
      logs: ["ran bun install", "ran npm run demo:makeademo"],
      repoFiles: ["bun.lock", "package.json"],
      runtimeExitCode: 0,
    });
  });

  it("reports runtime network attempts separately from allowed install network", async () => {
    const workspaceRoot = await createWorkspace({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ scripts: { demo: "vite" } }),
    });
    const runner = new DockerSandboxRunner({
      commandRunner: async ({ command }) => {
        if (command === "npm ci") {
          return {
            blockedNetworkAttempts: [
              {
                direction: "outbound",
                host: "registry.npmjs.org",
                phase: "install",
              },
            ],
            exitCode: 0,
            logs: ["installed dependencies"],
          };
        }

        return {
          blockedNetworkAttempts: [
            {
              direction: "outbound",
              host: "api.realworld.io",
              phase: "runtime",
            },
          ],
          exitCode: 0,
          logs: ["started demo"],
        };
      },
      workspaceRoot,
    });

    const result = await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(result.blockedNetworkAttempts).toEqual([
      { direction: "outbound", host: "registry.npmjs.org", phase: "install" },
      { direction: "outbound", host: "api.realworld.io", phase: "runtime" },
    ]);
  });

  it("waits for dependency installation before starting the demo runtime", async () => {
    const workspaceRoot = await createWorkspace({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ scripts: { demo: "vite" } }),
    });
    const calls: string[] = [];
    const runner = new DockerSandboxRunner({
      commandRunner: async ({ command, mode, readyUrl }) => {
        calls.push(`${command}:${mode}:${readyUrl ?? ""}`);
        return { exitCode: 0, logs: [] };
      },
      workspaceRoot,
    });

    await runner.runValidation({
      demoCommand: "npm run demo",
      preparationManifest: manifest("workspace_123"),
      repoUrl: "https://github.com/example/app",
      url: "http://localhost:3000",
    });

    expect(calls).toEqual([
      "npm ci:exit:",
      "npm run demo:start:http://localhost:3000",
    ]);
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

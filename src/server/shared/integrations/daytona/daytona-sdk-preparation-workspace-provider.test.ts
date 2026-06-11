import { describe, expect, it } from "vitest";

import { DaytonaSdkPreparationWorkspaceProvider } from "./daytona-sdk-preparation-workspace-provider";

describe("DaytonaSdkPreparationWorkspaceProvider", () => {
  it("creates a sandbox from the configured snapshot", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      snapshot: "makeademo-opencode",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls[0]).toEqual({
      create: {
        snapshot: "makeademo-opencode",
      },
    });
  });

  it("uploads screened workspace files with Daytona fs.uploadFiles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);

    expect(calls[1]).toEqual({
      uploadFiles: [
        {
          destination: "/workspace/package.json",
          source: "/tmp/repo/package.json",
        },
      ],
    });
  });

  it("executes commands, updates network settings, and deletes the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello");
    await handle.workspace.setOutboundNetworkAccess(false);
    await handle.destroy();

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(calls.slice(1)).toEqual([
      { executeCommand: "opencode run hello" },
      { updateNetworkSettings: { networkBlockAll: true } },
      { delete: "sandbox_123" },
    ]);
  });

  it("continues when Daytona org policy rejects sandbox-level network overrides", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        networkError: new Error(
          "Network access is restricted and cannot be overridden at the sandbox level.",
        ),
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.setOutboundNetworkAccess(true),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.setOutboundNetworkAccess(false),
    ).resolves.toBeUndefined();

    expect(calls.slice(1)).toEqual([
      { updateNetworkSettings: { networkBlockAll: false } },
      { updateNetworkSettings: { networkBlockAll: true } },
    ]);
  });
});

function fakeClient(calls: unknown[], options: { networkError?: Error } = {}) {
  const sandbox = {
    fs: {
      async uploadFiles(files: unknown[]) {
        calls.push({ uploadFiles: files });
      },
    },
    id: "sandbox_123",
    process: {
      async executeCommand(command: string) {
        calls.push({ executeCommand: command });
        return { exitCode: 0, result: "ok" };
      },
    },
    async updateNetworkSettings(settings: unknown) {
      calls.push({ updateNetworkSettings: settings });
      if (options.networkError !== undefined) {
        throw options.networkError;
      }
    },
  };

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      return sandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
  };
}

import { describe, expect, it } from "vitest";

import { DaytonaSdkPreparationWorkspaceProvider } from "./daytona-sdk-preparation-workspace-provider";

describe("DaytonaSdkPreparationWorkspaceProvider", () => {
  it("creates a network-blocked sandbox from the configured snapshot", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      snapshot: "makeademo-opencode-dind",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls[0]).toEqual({
      create: {
        networkBlockAll: true,
        snapshot: "makeademo-opencode-dind",
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
});

function fakeClient(calls: unknown[]) {
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

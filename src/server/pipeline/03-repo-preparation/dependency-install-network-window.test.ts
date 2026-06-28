import { describe, expect, it } from "vitest";

import { runDependencyInstallWithNetworkWindow } from "./dependency-install-network-window";
import type { PreparationWorkspace } from "./preparation-workspace.interface";

describe("runDependencyInstallWithNetworkWindow", () => {
  it("unblocks outbound network for a dependency install and blocks it again", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);

    const result = await runDependencyInstallWithNetworkWindow({
      command: "bun install",
      workspace,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("blocks outbound network again when the install command fails", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events, { exitCode: 1, stderr: "nope" });

    const result = await runDependencyInstallWithNetworkWindow({
      command: "npm install",
      workspace,
    });

    expect(result).toEqual({ exitCode: 1, stderr: "nope", stdout: "" });
    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:npm install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });

  it("does not fall back to outer workspace execution for dependency install", async () => {
    const workspace = fakeWorkspace([]);
    workspace.execute = async () => {
      throw new Error("outer workspace execution must not run submitted code");
    };

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "pnpm install",
        workspace,
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
  });

  it("denies non-install commands without opening submitted-code network", async () => {
    const events: string[] = [];

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "npm run build",
        workspace: fakeWorkspace(events),
      }),
    ).rejects.toThrow(
      "Dependency installation network access is limited to allowlisted package-manager install commands.",
    );

    expect(events).toEqual([]);
  });

  it("surfaces failures when submitted-code network cannot be blocked again", async () => {
    const events: string[] = [];

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "bun install",
        workspace: fakeWorkspace(events, undefined, {
          failNetworkDisable: true,
        }),
      }),
    ).rejects.toThrow("failed to block submitted-code network");

    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
    ]);
  });

  it("blocks submitted-code network again when install execution throws", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);
    workspace.executeSubmittedCode = async (command) => {
      events.push(`submitted-execute:${command}`);
      throw new Error("install exploded");
    };

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "bun install",
        workspace,
      }),
    ).rejects.toThrow("install exploded");

    expect(events).toEqual([
      "log:submitted-code-network.opening",
      "submitted-network:unblocked",
      "log:submitted-code-network.opened",
      "submitted-execute:bun install",
      "log:submitted-code-network.closing",
      "submitted-network:blocked",
      "log:submitted-code-network.closed",
    ]);
  });
});

function fakeWorkspace(
  events: string[],
  result: { exitCode: number; stderr: string; stdout?: string } = {
    exitCode: 0,
    stderr: "",
    stdout: "installed",
  },
  options: { failNetworkDisable?: boolean } = {},
): PreparationWorkspace {
  return {
    async execute(command) {
      events.push(`execute:${command}`);
      return { stdout: "", ...result };
    },
    async executeSubmittedCode(command) {
      events.push(`submitted-execute:${command}`);
      return { stdout: "", ...result };
    },
    async getPreviewUrl(port) {
      return `https://preview.example.test:${port}`;
    },
    async setOutboundNetworkAccess(enabled) {
      events.push(enabled ? "network:unblocked" : "network:blocked");
    },
    async setSubmittedCodeNetworkAccess(enabled) {
      events.push(
        enabled ? "submitted-network:unblocked" : "submitted-network:blocked",
      );
      if (!enabled && options.failNetworkDisable === true) {
        throw new Error("failed to block submitted-code network");
      }
    },
    async writeSandboxLog(entry) {
      events.push(`log:${entry.event}`);
    },
    async uploadFiles() {},
  };
}

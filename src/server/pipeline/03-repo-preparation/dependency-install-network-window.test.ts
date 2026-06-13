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
      "network:unblocked",
      "execute:bun install",
      "network:blocked",
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
      "network:unblocked",
      "execute:npm install",
      "network:blocked",
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
): PreparationWorkspace {
  return {
    async execute(command) {
      events.push(`execute:${command}`);
      return { stdout: "", ...result };
    },
    async setOutboundNetworkAccess(enabled) {
      events.push(enabled ? "network:unblocked" : "network:blocked");
    },
    async uploadFiles() {},
  };
}

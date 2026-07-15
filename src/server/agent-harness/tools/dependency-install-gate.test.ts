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
});

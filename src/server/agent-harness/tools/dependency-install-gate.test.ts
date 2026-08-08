import { describe, expect, it } from "vitest";
import {
  createOfflineLifecycleCommand,
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

  it("appends the package manager's script-suppression flag inside the install window", async () => {
    for (const [command, expected] of [
      [
        "bun install --frozen-lockfile",
        "bun install --frozen-lockfile --ignore-scripts",
      ],
      ["npm ci --no-audit", "npm ci --no-audit --ignore-scripts"],
      [
        "corepack pnpm install --frozen-lockfile",
        "corepack pnpm install --frozen-lockfile --ignore-scripts",
      ],
      [
        "yarn install --immutable",
        "yarn install --immutable --mode=skip-build",
      ],
      [
        "yarn install --frozen-lockfile",
        "yarn install --frozen-lockfile --ignore-scripts",
      ],
    ] as const) {
      const ran: string[] = [];
      const result = await runDependencyInstallThroughGate({
        command,
        closeNetwork: async () => {},
        openNetwork: async () => {},
        runCommand: async (executed) => {
          ran.push(executed);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });

      expect(result).toMatchObject({ status: "succeeded" });
      // A successful install is followed by the in-window prisma prefetch.
      expect(ran[0]).toBe(expected);
      expect(ran[1]).toContain("binaries.prisma.sh");
    }
  });

  it("emits a suppressed berry install the gate's own allowlist accepts", async () => {
    // The 2026-08-07 matrix killed every yarn-berry repo on
    // `--mode=skip-builds`: the suppression branch and the flag allowlist
    // agreed with each other on a value yarn rejects, so no gate-internal
    // check could catch it. Pin yarn's actual contract value here.
    const ran: string[] = [];
    await runDependencyInstallThroughGate({
      command: "yarn install --immutable",
      closeNetwork: async () => {},
      openNetwork: async () => {},
      runCommand: async (executed) => {
        ran.push(executed);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    expect(ran[0]).toBe("yarn install --immutable --mode=skip-build");
    expect(evaluateDependencyInstallCommand(ran[0] ?? "")).toMatchObject({
      status: "allowed",
    });
  });

  it("does not duplicate a suppression flag the install command already carries", async () => {
    for (const command of [
      "bun install --frozen-lockfile --ignore-scripts",
      "yarn install --immutable --mode=skip-build",
      "yarn install --mode=update-lockfile",
    ]) {
      const ran: string[] = [];
      await runDependencyInstallThroughGate({
        command,
        closeNetwork: async () => {},
        openNetwork: async () => {},
        runCommand: async (executed) => {
          ran.push(executed);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      });

      expect(ran[0]).toBe(command);
      expect(ran[1]).toContain("binaries.prisma.sh");
    }
  });

  it("lets the repo's yarn variant override berry-style install flags", async () => {
    // excalidraw (2026-08-08 matrix): pinned yarn@1.22.22, agent wrote
    // `--immutable`; flag-inferred "berry" issued `yarn rebuild` (which
    // classic yarn lacks) and chose a suppression flag yarn 1 silently
    // ignores. The repo's identity, not the agent's flags, decides.
    const ran: string[] = [];
    await runDependencyInstallThroughGate({
      command: "yarn install --immutable",
      closeNetwork: async () => {},
      openNetwork: async () => {},
      runCommand: async (executed) => {
        ran.push(executed);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      yarnVariant: "classic",
    });

    expect(ran[0]).toBe("yarn install --immutable --ignore-scripts");
  });

  it("skips the offline yarn rebuild for a classic-variant repo", () => {
    expect(
      createOfflineLifecycleCommand({
        installCommand: "yarn install --immutable",
        packageScripts: {},
        yarnVariant: "classic",
      }),
    ).toBeUndefined();
  });

  it("keeps the offline yarn rebuild when the repo variant is berry", () => {
    expect(
      createOfflineLifecycleCommand({
        installCommand: "yarn install --frozen-lockfile",
        packageScripts: {},
        yarnVariant: "berry",
      }),
    ).toBe("yarn rebuild");
  });

  it("prefetches prisma engines inside the still-open window after a successful install", async () => {
    // The sealed network makes these downloads impossible later (calcom's
    // libquery_engine fetch, ghostfolio's prisma generate — 2026-08-08
    // matrix), so warming them is part of the gated install itself.
    const events: string[] = [];
    const ran: string[] = [];

    await runDependencyInstallThroughGate({
      command: "npm ci --no-audit",
      closeNetwork: async () => {
        events.push("closed");
      },
      openNetwork: async () => {
        events.push("opened");
      },
      runCommand: async (executed) => {
        ran.push(executed);
        events.push("ran");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    expect(ran).toHaveLength(2);
    expect(ran[1]).toContain("binaries.prisma.sh");
    expect(events).toEqual(["opened", "ran", "ran", "closed"]);
  });

  it("skips the prisma prefetch when the install fails", async () => {
    const ran: string[] = [];

    await runDependencyInstallThroughGate({
      command: "npm ci --no-audit",
      closeNetwork: async () => {},
      openNetwork: async () => {},
      runCommand: async (executed) => {
        ran.push(executed);
        return { exitCode: 1, stderr: "install failed", stdout: "" };
      },
    });

    expect(ran).toHaveLength(1);
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
      executedCommand: "npm ci --no-audit --ignore-scripts",
      exitCode: 1,
      stderr: "install failed",
      status: "failed",
      stdout: "",
    });
    expect(events).toEqual(["opened", "ran", "closed"]);
  });

  it("retries a failed network reseal once and keeps the install result", async () => {
    let closes = 0;

    const result = await runDependencyInstallThroughGate({
      command: "npm ci --no-audit",
      closeNetwork: async () => {
        closes += 1;
        if (closes === 1) {
          throw new Error("502 Bad Gateway");
        }
      },
      openNetwork: async () => {},
      runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "done" }),
    });

    expect(closes).toBe(2);
    expect(result).toEqual({
      executedCommand: "npm ci --no-audit --ignore-scripts",
      exitCode: 0,
      status: "succeeded",
      stderr: "",
      stdout: "done",
    });
  });

  it("reports a persistent reseal failure without displacing the install result", async () => {
    const result = await runDependencyInstallThroughGate({
      command: "npm ci --no-audit",
      closeNetwork: async () => {
        throw new Error("network settings update rejected");
      },
      openNetwork: async () => {},
      runCommand: async () => ({
        exitCode: 1,
        stderr: "missing sqlite3 from lock file",
        stdout: "",
      }),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      resealError: expect.stringContaining("network settings update rejected"),
      status: "failed",
      stderr: "missing sqlite3 from lock file",
    });
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
    // Two install attempts plus the post-success prisma prefetch.
    expect(runs).toBe(3);
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

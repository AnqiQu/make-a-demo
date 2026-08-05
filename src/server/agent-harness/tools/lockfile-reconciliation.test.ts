import { describe, expect, it } from "vitest";
import { evaluateDependencyInstallCommand } from "./dependency-install-gate";
import {
  planEngineMismatchRetry,
  planLockfileReconciliation,
} from "./lockfile-reconciliation";

describe("lockfile reconciliation", () => {
  it("plans script-free lockfile repair only for recognized frozen-lockfile failures", () => {
    expect(
      planLockfileReconciliation({
        installCommand: "npm ci --no-audit --workspace=@acme/web",
        stderr:
          "npm ci can only install packages when package.json and package-lock.json are in sync. Missing: sqlite3 from lock file",
        stdout: "",
      }),
    ).toBe(
      "npm install --package-lock-only --ignore-scripts --no-audit --no-fund --workspace=@acme/web",
    );
    expect(
      planLockfileReconciliation({
        installCommand: "corepack pnpm install --frozen-lockfile",
        stderr:
          "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile",
        stdout: "",
      }),
    ).toBe("corepack pnpm install --lockfile-only --ignore-scripts");
    expect(
      planLockfileReconciliation({
        installCommand:
          "bun install --frozen-lockfile --filter=@midday/website",
        stderr: "Lockfile had changes, but lockfile is frozen",
        stdout: "",
      }),
    ).toBe(
      "bun install --lockfile-only --ignore-scripts --filter=@midday/website",
    );
    expect(
      planLockfileReconciliation({
        installCommand: "yarn install --immutable",
        stderr: "YN0028: The lockfile would have been modified",
        stdout: "",
      }),
    ).toBe("yarn install --mode=update-lockfile");
    expect(
      planLockfileReconciliation({
        installCommand: "npm ci --no-audit",
        stderr: "ECONNREFUSED registry.npmjs.org",
        stdout: "",
      }),
    ).toBeUndefined();
  });

  it("keeps yarn workspace scope and picks the flag the yarn variant accepts", () => {
    expect(
      planLockfileReconciliation({
        installCommand: "corepack yarn install --immutable --filter=@acme/web",
        stderr: "YN0028: The lockfile would have been modified",
        stdout: "",
      }),
    ).toBe("corepack yarn install --mode=update-lockfile --filter=@acme/web");
    expect(
      planLockfileReconciliation({
        installCommand: "yarn install --frozen-lockfile",
        stderr: "error Lockfile would have been modified by this install",
        stdout: "",
      }),
    ).toBe("yarn install --ignore-scripts");
  });

  it("does not rewrite a lockfile when dependency transport failed", () => {
    expect(
      planLockfileReconciliation({
        installCommand: "bun install --frozen-lockfile",
        stderr:
          "ConnectionClosed downloading tarball xlsx; Lockfile had changes, but lockfile is frozen",
        stdout: "",
      }),
    ).toBeUndefined();
  });

  it("retries an engine-incompatible install with the manager's engine bypass", () => {
    expect(
      planEngineMismatchRetry({
        installCommand: "yarn install --immutable",
        stderr:
          'error i18next-parser@9.4.0: The engine "node" is incompatible with this module. Expected version "^18.0.0 || ^20.0.0 || ^22.0.0". Got "24.15.0"\nerror Found incompatible module.',
        stdout: "",
      }),
    ).toBe("yarn install --immutable --ignore-engines");
    expect(
      planEngineMismatchRetry({
        installCommand: "corepack pnpm install --frozen-lockfile",
        stderr:
          "ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)",
        stdout: "",
      }),
    ).toBe(
      "corepack pnpm install --frozen-lockfile --config.engine-strict=false",
    );
  });

  it("plans only remedy commands the dependency-install gate allows", () => {
    // A remedy this module plans but the gate denies is a deterministic
    // dead-end: the repair fires, is silently rejected, and the failure is
    // reported under the original command. Every plannable remedy must pass
    // the gate that will execute it.
    const failures = [
      {
        installCommand: "npm ci --no-audit --workspace=@acme/web",
        stderr:
          "npm ci can only install packages when package.json and package-lock.json are in sync. Missing: sqlite3 from lock file",
      },
      {
        installCommand:
          "corepack pnpm install --frozen-lockfile --filter=@directus/app",
        stderr:
          "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile",
      },
      {
        installCommand:
          "bun install --frozen-lockfile --filter=@midday/website",
        stderr: "Lockfile had changes, but lockfile is frozen",
      },
      {
        installCommand: "corepack yarn install --immutable",
        stderr: "YN0028: The lockfile would have been modified",
      },
      {
        installCommand: "yarn install --frozen-lockfile",
        stderr: "error Lockfile would have been modified by this install",
      },
      {
        installCommand: "yarn install --immutable",
        stderr:
          'error i18next-parser@9.4.0: The engine "node" is incompatible with this module.',
      },
      {
        installCommand:
          "corepack pnpm install --frozen-lockfile --filter=@directus/app",
        stderr:
          "ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)",
      },
    ];
    const remedies = failures.flatMap(({ installCommand, stderr }) =>
      [
        planLockfileReconciliation({ installCommand, stderr, stdout: "" }),
        planEngineMismatchRetry({ installCommand, stderr, stdout: "" }),
      ].filter((remedy) => remedy !== undefined),
    );

    expect(remedies.length).toBe(failures.length);
    for (const remedy of remedies) {
      expect({
        decision: evaluateDependencyInstallCommand(remedy),
        remedy,
      }).toEqual({ decision: { status: "allowed" }, remedy });
    }
  });

  it("does not plan an engine retry for other failures or managers", () => {
    expect(
      planEngineMismatchRetry({
        installCommand: "yarn install --immutable",
        stderr: "YN0028: The lockfile would have been modified",
        stdout: "",
      }),
    ).toBeUndefined();
    expect(
      planEngineMismatchRetry({
        installCommand: "npm ci --no-audit",
        stderr: 'The engine "node" is incompatible with this module.',
        stdout: "",
      }),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { planLockfileReconciliation } from "./lockfile-reconciliation";

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
    ).toBe("yarn install --ignore-scripts");
    expect(
      planLockfileReconciliation({
        installCommand: "npm ci --no-audit",
        stderr: "ECONNREFUSED registry.npmjs.org",
        stdout: "",
      }),
    ).toBeUndefined();
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
});

import {
  parseInstallCommand,
  readYarnInstallVariant,
} from "./dependency-install-gate";

export type LockfileReconciliationInput = {
  installCommand: string;
  stderr: string;
  stdout: string;
};

type PackageManagerInstall = {
  corepack: string;
  manager: "bun" | "npm" | "pnpm" | "yarn";
  workspaceScope: string;
};

/**
 * Per-package-manager reconciliation knowledge: the stale-lockfile failure
 * signature in a clean install's output, and the lifecycle-script-free
 * command that regenerates only the lockfile.
 */
const lockfileReconciliations: Record<
  PackageManagerInstall["manager"],
  {
    isStaleLockfileFailure: (output: string) => boolean;
    reconciliationCommand: (
      install: PackageManagerInstall,
      installCommand: string,
      yarnVariant?: "berry" | "classic",
    ) => string;
  }
> = {
  bun: {
    isStaleLockfileFailure: (output) =>
      output.includes("lockfile") &&
      output.includes("frozen") &&
      (output.includes("change") || output.includes("outdated")),
    reconciliationCommand: () => "bun install --lockfile-only --ignore-scripts",
  },
  npm: {
    isStaleLockfileFailure: (output) =>
      output.includes("package-lock.json") &&
      (output.includes("in sync") || output.includes("missing:")),
    reconciliationCommand: () =>
      "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
  },
  pnpm: {
    isStaleLockfileFailure: (output) =>
      output.includes("err_pnpm_outdated_lockfile") ||
      (output.includes("frozen-lockfile") && output.includes("cannot install")),
    reconciliationCommand: (install) =>
      `${install.corepack}pnpm install --lockfile-only --ignore-scripts`,
  },
  yarn: {
    isStaleLockfileFailure: (output) =>
      output.includes("yn0028") ||
      (output.includes("lockfile") &&
        output.includes("would have been modified")),
    reconciliationCommand: (install, installCommand, yarnVariant) =>
      `${install.corepack}yarn install ${
        readYarnInstallVariant(installCommand, yarnVariant) === "berry"
          ? "--mode=update-lockfile"
          : "--ignore-scripts"
      }`,
  },
};

/** Returns the lifecycle-script-free lockfile command for a recognized install. */
export function createLockfileReconciliationCommand(
  installCommand: string,
  yarnVariant?: "berry" | "classic",
): string | undefined {
  const install = readPackageManagerInstall(installCommand);
  if (install === undefined) return undefined;
  return scopedReconciliationCommand(install, installCommand, yarnVariant);
}

/**
 * Returns a package-manager-only, lifecycle-script-free command when a clean
 * install failed specifically because its lockfile is stale. Other install
 * failures remain agent-visible and are never broadened into shell execution.
 */
export function planLockfileReconciliation(
  input: LockfileReconciliationInput,
  yarnVariant?: "berry" | "classic",
): string | undefined {
  const install = readPackageManagerInstall(input.installCommand);
  if (install === undefined) {
    return undefined;
  }

  const output = `${input.stderr}\n${input.stdout}`.toLowerCase();
  if (
    /connectionclosed|econn(?:refused|reset)|enotfound|downloading tarball|failed to resolve|network timeout|socket hang up|tls handshake/.test(
      output,
    )
  ) {
    return undefined;
  }
  return lockfileReconciliations[install.manager].isStaleLockfileFailure(output)
    ? scopedReconciliationCommand(install, input.installCommand, yarnVariant)
    : undefined;
}

/**
 * Per-package-manager engine-mismatch knowledge: the engine-check failure
 * signature in a clean install's output, and the flag that bypasses the
 * check. npm and bun are absent because they do not enforce engines by
 * default; their engine failures stay agent-visible.
 */
const engineMismatchRetries: Partial<
  Record<
    PackageManagerInstall["manager"],
    { isEngineMismatchFailure: (output: string) => boolean; retryFlag: string }
  >
> = {
  pnpm: {
    isEngineMismatchFailure: (output) =>
      output.includes("err_pnpm_unsupported_engine"),
    retryFlag: "--config.engine-strict=false",
  },
  yarn: {
    isEngineMismatchFailure: (output) =>
      output.includes('the engine "node" is incompatible with this module'),
    retryFlag: "--ignore-engines",
  },
};

/**
 * Returns the original install command with the manager's engine-check bypass
 * appended when a clean install failed specifically on an engine version
 * check. A demo sandbox pins one Node version; a dependency's engines range
 * must not be able to dead-end preparation when the manager offers a bypass.
 */
export function planEngineMismatchRetry(
  input: LockfileReconciliationInput,
): string | undefined {
  const install = readPackageManagerInstall(input.installCommand);
  if (install === undefined) return undefined;
  const retry = engineMismatchRetries[install.manager];
  if (retry === undefined) return undefined;
  const output = `${input.stderr}\n${input.stdout}`.toLowerCase();
  return retry.isEngineMismatchFailure(output)
    ? `${input.installCommand} ${retry.retryFlag}`
    : undefined;
}

function scopedReconciliationCommand(
  install: PackageManagerInstall,
  installCommand: string,
  yarnVariant?: "berry" | "classic",
): string {
  const command = lockfileReconciliations[
    install.manager
  ].reconciliationCommand(install, installCommand, yarnVariant);
  return install.workspaceScope.length === 0
    ? command
    : `${command} ${install.workspaceScope}`;
}

function readPackageManagerInstall(
  installCommand: string,
): PackageManagerInstall | undefined {
  const parsed = parseInstallCommand(installCommand);
  const manager = parsed.packageManager;
  if (
    manager !== "bun" &&
    manager !== "npm" &&
    manager !== "pnpm" &&
    manager !== "yarn"
  ) {
    return undefined;
  }
  if (parsed.subcommand !== "ci" && parsed.subcommand !== "install") {
    return undefined;
  }
  return {
    corepack: parsed.corepackPrefix,
    manager,
    workspaceScope: parsed.tokens
      .filter(
        (argument) =>
          argument.startsWith("--filter=") ||
          argument.startsWith("--workspace="),
      )
      .join(" "),
  };
}

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

/** Returns the lifecycle-script-free lockfile command for a recognized install. */
export function createLockfileReconciliationCommand(
  installCommand: string,
): string | undefined {
  const install = readPackageManagerInstall(installCommand);
  if (install === undefined) return undefined;
  const scoped = (command: string) =>
    install.workspaceScope.length === 0
      ? command
      : `${command} ${install.workspaceScope}`;

  switch (install.manager) {
    case "npm":
      return scoped(
        "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
      );
    case "pnpm":
      return scoped(
        `${install.corepack}pnpm install --lockfile-only --ignore-scripts`,
      );
    case "bun":
      return scoped("bun install --lockfile-only --ignore-scripts");
    case "yarn":
      return `${install.corepack}yarn install --ignore-scripts`;
  }
}

/**
 * Returns a package-manager-only, lifecycle-script-free command when a clean
 * install failed specifically because its lockfile is stale. Other install
 * failures remain agent-visible and are never broadened into shell execution.
 */
export function planLockfileReconciliation(
  input: LockfileReconciliationInput,
): string | undefined {
  const install = readPackageManagerInstall(input.installCommand);
  const reconciliationCommand = createLockfileReconciliationCommand(
    input.installCommand,
  );
  if (install === undefined || reconciliationCommand === undefined) {
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
  switch (install.manager) {
    case "npm":
      return output.includes("package-lock.json") &&
        (output.includes("in sync") || output.includes("missing:"))
        ? reconciliationCommand
        : undefined;
    case "pnpm":
      return output.includes("err_pnpm_outdated_lockfile") ||
        (output.includes("frozen-lockfile") &&
          output.includes("cannot install"))
        ? reconciliationCommand
        : undefined;
    case "bun":
      return output.includes("lockfile") &&
        output.includes("frozen") &&
        (output.includes("change") || output.includes("outdated"))
        ? reconciliationCommand
        : undefined;
    case "yarn":
      return output.includes("yn0028") ||
        (output.includes("lockfile") &&
          output.includes("would have been modified"))
        ? reconciliationCommand
        : undefined;
  }
}

function readPackageManagerInstall(
  installCommand: string,
): PackageManagerInstall | undefined {
  const command = installCommand.trim();
  const match =
    /^(?<corepack>corepack\s+)?(?<manager>bun|npm|pnpm|yarn)\s+(?:ci|install)(?:\s|$)/.exec(
      command,
    );
  const manager = match?.groups?.manager;
  if (
    manager !== "bun" &&
    manager !== "npm" &&
    manager !== "pnpm" &&
    manager !== "yarn"
  ) {
    return undefined;
  }
  return {
    corepack: match?.groups?.corepack ?? "",
    manager,
    workspaceScope: command
      .split(/\s+/)
      .filter(
        (argument) =>
          argument.startsWith("--filter=") ||
          argument.startsWith("--workspace="),
      )
      .join(" "),
  };
}

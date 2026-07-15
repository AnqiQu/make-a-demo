export type LockfileReconciliationInput = {
  installCommand: string;
  stderr: string;
  stdout: string;
};

/**
 * Returns a package-manager-only, lifecycle-script-free command when a clean
 * install failed specifically because its lockfile is stale. Other install
 * failures remain agent-visible and are never broadened into shell execution.
 */
export function planLockfileReconciliation(
  input: LockfileReconciliationInput,
): string | undefined {
  const command = input.installCommand.trim();
  const match =
    /^(?<corepack>corepack\s+)?(?<manager>bun|npm|pnpm|yarn)\s+(?:ci|install)(?:\s|$)/.exec(
      command,
    );
  const manager = match?.groups?.manager;
  if (manager === undefined) {
    return undefined;
  }
  const workspaceScope = command
    .split(/\s+/)
    .filter(
      (argument) =>
        argument.startsWith("--filter=") || argument.startsWith("--workspace="),
    )
    .join(" ");
  const scoped = (reconciliationCommand: string) =>
    workspaceScope.length === 0
      ? reconciliationCommand
      : `${reconciliationCommand} ${workspaceScope}`;

  const output = `${input.stderr}\n${input.stdout}`.toLowerCase();
  if (
    /connectionclosed|econn(?:refused|reset)|enotfound|downloading tarball|failed to resolve|network timeout|socket hang up|tls handshake/.test(
      output,
    )
  ) {
    return undefined;
  }
  switch (manager) {
    case "npm":
      return output.includes("package-lock.json") &&
        (output.includes("in sync") || output.includes("missing:"))
        ? scoped(
            "npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
          )
        : undefined;
    case "pnpm":
      return output.includes("err_pnpm_outdated_lockfile") ||
        (output.includes("frozen-lockfile") &&
          output.includes("cannot install"))
        ? scoped(
            `${match?.groups?.corepack ?? ""}pnpm install --lockfile-only --ignore-scripts`,
          )
        : undefined;
    case "bun":
      return output.includes("lockfile") &&
        output.includes("frozen") &&
        (output.includes("change") || output.includes("outdated"))
        ? scoped("bun install --lockfile-only --ignore-scripts")
        : undefined;
    case "yarn":
      return output.includes("yn0028") ||
        (output.includes("lockfile") &&
          output.includes("would have been modified"))
        ? `${match?.groups?.corepack ?? ""}yarn install --ignore-scripts`
        : undefined;
  }
}

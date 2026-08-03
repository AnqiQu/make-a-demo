export type DependencyInstallDecision =
  | { status: "allowed" }
  | { reason: string; status: "denied" };

export type DependencyInstallCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

const allowedPackageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);
const allowedInstallFlags = new Set([
  "--check-files",
  "--force",
  "--frozen-lockfile",
  "--ignore-engines",
  "--ignore-optional",
  "--ignore-platform",
  "--ignore-scripts",
  "--immutable",
  "--include=dev",
  "--legacy-peer-deps",
  "--lockfile-only",
  "--mode=skip-builds",
  "--mode=update-lockfile",
  "--no-audit",
  "--no-bin-links",
  "--no-frozen-lockfile",
  "--no-fund",
  "--no-lockfile",
  "--no-optional",
  "--no-package-lock",
  "--no-save",
  "--offline",
  "--omit=dev",
  "--omit=optional",
  "--package-lock-only",
  "--prefer-offline",
  "--prefer-online",
  "--production",
  "--prod",
  "--prod=false",
  "--pure-lockfile",
  "--silent",
  "--verbose",
  "--workspaces=false",
]);

const deniedReason =
  "Dependency installation network access is limited to allowlisted package-manager install commands.";

export function evaluateDependencyInstallCommand(
  command: string,
): DependencyInstallDecision {
  if (!isAllowedDependencyInstallCommand(command)) {
    return { reason: deniedReason, status: "denied" };
  }

  return { status: "allowed" };
}

/**
 * Runs an allowlisted install command inside the open network window. Every
 * command handed to `runCommand` carries the package manager's
 * lifecycle-script suppression flag, so submitted-repo install scripts never
 * execute while the sandbox has network access.
 */
export async function runDependencyInstallThroughGate(input: {
  closeNetwork: () => Promise<void>;
  command: string;
  openNetwork: () => Promise<void>;
  runCommand: (command: string) => Promise<DependencyInstallCommandResult>;
}): Promise<
  | ({ status: "failed" | "succeeded" } & DependencyInstallCommandResult)
  | { reason: string; status: "denied" }
> {
  const decision = evaluateDependencyInstallCommand(input.command);
  if (decision.status === "denied") {
    return decision;
  }

  const command = withLifecycleScriptSuppression(input.command);
  await input.openNetwork();
  try {
    let result = await input.runCommand(command);
    if (result.exitCode !== 0 && hasNetworkInstallFailureSignature(result)) {
      result = await input.runCommand(command);
    }
    return {
      ...result,
      status: result.exitCode === 0 ? "succeeded" : "failed",
    };
  } finally {
    await input.closeNetwork();
  }
}

/**
 * A dropped connection or registry outage during the open install window is
 * worth one immediate retry; a failure that repeats through the retry means
 * the host is unreachable from the sandbox and callers should classify it as
 * an external network requirement rather than a generic install failure.
 */
export function hasNetworkInstallFailureSignature(
  result: DependencyInstallCommandResult,
): boolean {
  return /(?:ConnectionClosed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network timeout|ERR_SOCKET_TIMEOUT|503 Service Unavailable|502 Bad Gateway|504 Gateway Timeout)/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

const classicYarnOnlyFlags = new Set([
  "--check-files",
  "--frozen-lockfile",
  "--ignore-engines",
  "--ignore-optional",
  "--ignore-platform",
  "--no-bin-links",
  "--no-lockfile",
  "--pure-lockfile",
]);

/**
 * Yarn Berry rejects `--ignore-scripts` and classic yarn rejects `--mode=...`,
 * so the yarn variant is read from version-specific flags already on the
 * command; a bare `yarn install` follows the run planner's Berry convention.
 */
export function readYarnInstallVariant(command: string): "berry" | "classic" {
  return command
    .trim()
    .split(/\s+/)
    .some((token) => classicYarnOnlyFlags.has(token))
    ? "classic"
    : "berry";
}

function withLifecycleScriptSuppression(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const packageManager = tokens[tokens[0] === "corepack" ? 1 : 0];
  if (
    tokens.some(
      (token) => token === "--ignore-scripts" || token.startsWith("--mode="),
    )
  ) {
    return command;
  }

  const flag =
    packageManager === "yarn" && readYarnInstallVariant(command) === "berry"
      ? "--mode=skip-builds"
      : "--ignore-scripts";
  return `${command.trim()} ${flag}`;
}

function isAllowedDependencyInstallCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0 || hasShellSyntax(normalized)) {
    return false;
  }

  const tokens = normalized.split(/\s+/);
  const packageManagerIndex = tokens[0] === "corepack" ? 1 : 0;
  const packageManager = tokens[packageManagerIndex];
  const installSubcommand = tokens[packageManagerIndex + 1];
  const args = tokens.slice(packageManagerIndex + 2);

  if (
    packageManager === undefined ||
    installSubcommand === undefined ||
    !allowedPackageManagers.has(packageManager)
  ) {
    return false;
  }

  if (!isInstallSubcommand(packageManager, installSubcommand)) {
    return false;
  }

  return args.every(isAllowedInstallArgument);
}

function hasShellSyntax(command: string): boolean {
  return /[;&|<>`$\\\n\r]/.test(command);
}

function isInstallSubcommand(
  packageManager: string,
  subcommand: string,
): boolean {
  if (packageManager === "npm") {
    return subcommand === "ci" || subcommand === "install";
  }

  return subcommand === "install";
}

function isAllowedInstallArgument(argument: string): boolean {
  if (allowedInstallFlags.has(argument)) {
    return true;
  }

  return /^--(cache|cache-dir|cwd|filter|modules-folder|network-concurrency|store-dir|virtual-store-dir|workspace)=[A-Za-z0-9._/@:-]+$/.test(
    argument,
  );
}

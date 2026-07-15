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

  await input.openNetwork();
  try {
    const result = await input.runCommand(input.command);
    return {
      ...result,
      status: result.exitCode === 0 ? "succeeded" : "failed",
    };
  } finally {
    await input.closeNetwork();
  }
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

export type DependencyNetworkRequest = {
  command: string;
  reason: string;
};

export type DependencyNetworkDecision =
  | { status: "allowed" }
  | { reason: string; status: "denied" };

const agentOnlyEnvKeys = new Set([
  "ANTHROPIC_API_KEY",
  "CONTEXT7_API_KEY",
  "EXA_API_KEY",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL_EXA",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
]);

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
  "--immutable-cache",
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
  "--prefer-offline",
  "--prefer-online",
  "--production",
  "--prod",
  "--prod=false",
  "--pure-lockfile",
  "--silent",
  "--verbose",
]);
const deniedDependencyCommandReason =
  "Dependency installation network access is limited to allowlisted package-manager install commands.";

/**
 * Decides whether Repo Preparation may temporarily unblock outbound network.
 * Network access is limited to backend-controlled dependency installation;
 * deterministic Repo Security Screen runs before this stage.
 */
export function evaluateDependencyNetworkRequest(
  request: DependencyNetworkRequest,
): DependencyNetworkDecision {
  if (request.reason !== "dependency-install") {
    return {
      reason:
        "Outbound network access is only allowed for dependency installation.",
      status: "denied",
    };
  }

  if (!isAllowedDependencyInstallCommand(request.command)) {
    return {
      reason: deniedDependencyCommandReason,
      status: "denied",
    };
  }

  return { status: "allowed" };
}

export function createSubmittedRuntimeEnv(
  agentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(agentEnv)) {
    if (value === undefined || isAgentOnlyEnvKey(key)) {
      continue;
    }

    runtimeEnv[key] = value;
  }

  return runtimeEnv;
}

function isAgentOnlyEnvKey(key: string): boolean {
  return (
    agentOnlyEnvKeys.has(key) ||
    key.startsWith("DAYTONA_") ||
    key.startsWith("OPENCODE_") ||
    key.endsWith("_API_KEY") ||
    key.endsWith("_TOKEN") ||
    key.endsWith("_SECRET")
  );
}

function isAllowedDependencyInstallCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || hasShellSyntax(command)) {
    return false;
  }

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

  return /^--(cache|cache-dir|cwd|filter|modules-folder|network-concurrency|prefer-offline|store-dir|virtual-store-dir)=[A-Za-z0-9._/@:-]+$/.test(
    argument,
  );
}

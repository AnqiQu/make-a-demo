import { createPrismaEnginePrefetchCommand } from "./prisma-engine-prefetch";

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
  "--config.engine-strict=false",
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
  "--mode=skip-build",
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
 * execute while the sandbox has network access. A reseal failure never
 * displaces the install result: the close is retried once and a persistent
 * failure is attached as `resealError` so callers can fail closed.
 */
export async function runDependencyInstallThroughGate(input: {
  closeNetwork: () => Promise<void>;
  command: string;
  openNetwork: () => Promise<void>;
  runCommand: (command: string) => Promise<DependencyInstallCommandResult>;
  /** Repo-identity yarn generation (RepoProfile.yarnVariant); overrides flag inference. */
  yarnVariant?: "berry" | "classic";
}): Promise<
  | ({
      executedCommand: string;
      resealError?: string;
      status: "failed" | "succeeded";
    } & DependencyInstallCommandResult)
  | { reason: string; status: "denied" }
> {
  const decision = evaluateDependencyInstallCommand(input.command);
  if (decision.status === "denied") {
    return decision;
  }

  const command = withLifecycleScriptSuppression(
    input.command,
    input.yarnVariant,
  );
  await input.openNetwork();
  let result: DependencyInstallCommandResult;
  try {
    result = await input.runCommand(command);
    if (result.exitCode !== 0 && hasNetworkInstallFailureSignature(result)) {
      result = await input.runCommand(command);
    }
    if (result.exitCode === 0) {
      // Engine downloads the suppressed lifecycle scripts would have done
      // become impossible once the window reseals (N72b), so warming them
      // is part of the gated install itself. The command is best-effort by
      // construction — its result carries no install evidence.
      await input.runCommand(createPrismaEnginePrefetchCommand());
    }
  } catch (error) {
    await resealNetwork(input.closeNetwork);
    throw error;
  }

  const resealError = await resealNetwork(input.closeNetwork);
  return {
    ...result,
    // Failure evidence must name the command that ran, suppression flag
    // included — repair agents cannot reason about a flag they never see.
    executedCommand: command,
    status: result.exitCode === 0 ? "succeeded" : "failed",
    ...(resealError === undefined ? {} : { resealError }),
  };
}

async function resealNetwork(
  closeNetwork: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await closeNetwork();
    return undefined;
  } catch {
    try {
      await closeNetwork();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
 * The single tokenized view of a package-manager install command shared by
 * the install gate and lockfile reconciliation. Fields are positional facts
 * only — no allowlisting: `packageManager` and `subcommand` are whatever
 * tokens follow the optional `corepack` launcher, and `corepackPrefix` is the
 * launcher verbatim (with its original whitespace) so rebuilt commands keep
 * their exact spelling.
 */
export type ParsedInstallCommand = {
  /** Tokens after the subcommand — flags and arguments. */
  args: string[];
  /** The command with surrounding whitespace trimmed. */
  command: string;
  /** Verbatim `corepack` launcher prefix including its whitespace, or "". */
  corepackPrefix: string;
  /** Token after the optional `corepack` launcher. */
  packageManager: string | undefined;
  /** Token after the package manager, e.g. `install` or `ci`. */
  subcommand: string | undefined;
  /** Every whitespace-separated token of the trimmed command. */
  tokens: string[];
};

/**
 * Tokenizes an install command once for every gate and reconciliation check.
 * Parsing never rejects: callers decide what an absent or unrecognized
 * package manager or subcommand means for their own policy.
 */
export function parseInstallCommand(command: string): ParsedInstallCommand {
  const trimmed = command.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const managerIndex = tokens[0] === "corepack" ? 1 : 0;
  return {
    args: tokens.slice(managerIndex + 2),
    command: trimmed,
    corepackPrefix:
      managerIndex === 0 ? "" : (/^corepack\s+/.exec(trimmed)?.[0] ?? ""),
    packageManager: tokens[managerIndex],
    subcommand: tokens[managerIndex + 1],
    tokens,
  };
}

/**
 * Yarn Berry rejects `--ignore-scripts` and classic yarn rejects `--mode=...`.
 * The repository's own identity (RepoProfile.yarnVariant — packageManager pin
 * major, else yarnrc shape) is authoritative when known: agents write
 * berry-style flags against classic repos (excalidraw's pinned yarn@1 with
 * `--immutable`, 2026-08-08 matrix). Version-specific flags on the command
 * remain the fallback; a bare `yarn install` follows the run planner's Berry
 * convention.
 */
export function readYarnInstallVariant(
  command: string,
  repoVariant?: "berry" | "classic",
): "berry" | "classic" {
  if (repoVariant !== undefined) return repoVariant;
  return parseInstallCommand(command).tokens.some((token) =>
    classicYarnOnlyFlags.has(token),
  )
    ? "classic"
    : "berry";
}

/**
 * Builds the network-closed counterpart of `withLifecycleScriptSuppression`:
 * the command that runs the lifecycle work the gated install skipped, after
 * the window is resealed. It rebuilds dependencies through the manager's own
 * rebuild (which honors the repo's declared build allowlists) and runs the
 * root `postinstall` when the repo declares one. Returns undefined when the
 * manager offers neither — bun installs only run allowlisted trusted scripts,
 * and classic yarn has no offline rebuild — so callers skip the pass instead
 * of failing a working install. Callers must only run the result while the
 * submitted-code network is closed.
 */
export function createOfflineLifecycleCommand(input: {
  installCommand: string;
  /**
   * True when the repo's own package-manager config disables dependency
   * lifecycle scripts (RepoProfile.lifecycleScriptsDisabled). A real
   * install in such a repo runs no scripts, so the gated install skipped
   * nothing and the offline pass has no work — it is skipped entirely
   * (N160(2): outline's enableScripts: false).
   */
  lifecycleScriptsDisabled?: boolean;
  packageScripts: Record<string, string>;
  /** Repo-identity yarn generation (RepoProfile.yarnVariant); overrides flag inference. */
  yarnVariant?: "berry" | "classic";
}): string | undefined {
  if (input.lifecycleScriptsDisabled === true) {
    return undefined;
  }
  const parsed = parseInstallCommand(input.installCommand);
  const manager = parsed.packageManager;
  if (manager === undefined) {
    return undefined;
  }
  const isBerry =
    manager === "yarn" &&
    readYarnInstallVariant(input.installCommand, input.yarnVariant) === "berry";
  // The sealed sandbox network blocks packets, but the package manager only
  // sees a flaky network and retries: outline's `yarn rebuild` ground
  // through ECONNREFUSED for 9m28s per round (N160, 2026-08-20). Telling
  // the manager itself the network is off converts the same failure into a
  // fast rejection with a named cause. Every part of the chain carries the
  // prefix so a nested manager invocation inherits it. Classic yarn and bun
  // have no manager-level offline switch; the sealed network remains their
  // enforcement.
  const offline = isBerry
    ? "YARN_ENABLE_NETWORK=false "
    : manager === "npm" || manager === "pnpm"
      ? "npm_config_offline=true "
      : "";
  // An install that only passed via the engine-strict bypass retry leaves a
  // repo whose engine check would kill the rebuild the same way.
  const engineBypass = parsed.tokens.includes("--config.engine-strict=false")
    ? " --config.engine-strict=false"
    : "";
  const rebuild =
    manager === "npm"
      ? `${offline}npm rebuild`
      : manager === "pnpm"
        ? // Recursive: a bare `pnpm rebuild` at a workspace root exits 0
          // having rebuilt nothing, because members' dependencies are
          // outside the root project's scope. `-r` covers members and
          // behaves identically in single-project repos.
          `${offline}pnpm rebuild -r${engineBypass}`
        : isBerry
          ? `${offline}yarn rebuild`
          : undefined;
  const declaresPostinstall =
    (input.packageScripts.postinstall ?? "").trim().length > 0;
  // --if-present keeps the run a no-op when the install directory is a
  // workspace member whose own package.json lacks the root's postinstall.
  const postinstall = !declaresPostinstall
    ? undefined
    : manager === "npm" || manager === "pnpm"
      ? `${offline}${manager} run --if-present postinstall`
      : manager === "yarn" || manager === "bun"
        ? `${manager === "yarn" && isBerry ? offline : ""}${manager} run postinstall`
        : undefined;
  const parts = [rebuild, postinstall].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(" && ");
}

/**
 * True when a failed offline lifecycle pass was refused by the package
 * manager's own offline enforcement — the refusal `createOfflineLifecycleCommand`
 * itself provokes by disabling the manager's network. That failure is
 * harness-owned and deterministic: no repair candidate declared the command
 * and none can fix it, so callers must skip the pass and let preflight
 * measure the tree's real state instead of charging a repair round
 * (N160(3): outline lost three rounds to it, 2026-08-20). A package's build
 * error, or a lifecycle script's own download attempt against the sealed
 * network, must NOT match — those remain agent-repairable.
 */
export function isOfflineLifecycleNetworkRefusal(output: string): boolean {
  return /enableNetwork|Network access ha(?:s|ve) been disabled|ENOTCACHED|only-if-cached|ERR_PNPM_NO_OFFLINE/i.test(
    output,
  );
}

function withLifecycleScriptSuppression(
  command: string,
  yarnVariant?: "berry" | "classic",
): string {
  const parsed = parseInstallCommand(command);
  if (
    parsed.tokens.some(
      (token) => token === "--ignore-scripts" || token.startsWith("--mode="),
    )
  ) {
    return command;
  }

  const flag =
    parsed.packageManager === "yarn" &&
    readYarnInstallVariant(command, yarnVariant) === "berry"
      ? "--mode=skip-build"
      : "--ignore-scripts";
  return `${parsed.command} ${flag}`;
}

function isAllowedDependencyInstallCommand(command: string): boolean {
  const parsed = parseInstallCommand(command);
  if (parsed.command.length === 0 || hasShellSyntax(parsed.command)) {
    return false;
  }

  if (
    parsed.packageManager === undefined ||
    parsed.subcommand === undefined ||
    !allowedPackageManagers.has(parsed.packageManager)
  ) {
    return false;
  }

  if (!isInstallSubcommand(parsed.packageManager, parsed.subcommand)) {
    return false;
  }

  return parsed.args.every(isAllowedInstallArgument);
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

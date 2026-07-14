import type { RepoProfile, RunPlan } from "../schemas/artifacts";

export function synthesizeRunPlan(repoProfile: RepoProfile): RunPlan {
  const port = repoProfile.candidatePorts[0] ?? 3000;
  const startCommand =
    repoProfile.candidateStartCommands[0] ??
    fallbackStartCommand(repoProfile.packageManager, port);
  return {
    allowedPorts: [port],
    appDir: repoProfile.candidateAppDirs[0] ?? ".",
    assumptions: ["selected first profiled app directory"],
    ...optionalString(
      "buildCommand",
      isDevelopmentCommand(startCommand)
        ? undefined
        : repoProfile.candidateBuildCommands[0],
    ),
    env: { NODE_ENV: "development" },
    expectedLocalUrl: `http://127.0.0.1:${port}`,
    installCommand:
      repoProfile.candidateInstallCommands[0] ??
      fallbackInstallCommand(repoProfile.packageManager),
    localServices: [],
    riskFlags: readRiskFlags(repoProfile),
    runtime: readRuntime(repoProfile.packageManager),
    startCommand,
    validationExpectations: [
      "base URL loads under Runtime Network Lockdown",
      "at least one meaningful visible route is available",
    ],
  };
}

function isDevelopmentCommand(command: string): boolean {
  return /(?:^|\s)(?:run\s+)?dev(?:\s|$)/.test(command);
}

function readRiskFlags(repoProfile: RepoProfile): string[] {
  const flags: string[] = [];
  if (repoProfile.authHints.length > 0) {
    flags.push("auth packages may require local demo bypass");
  }
  if (repoProfile.externalServiceHints.length > 0) {
    flags.push("external services may require local mocks");
  }
  if (repoProfile.requiredEnvHints.length > 0) {
    flags.push("required env hints must be satisfied with local-only values");
  }
  if (repoProfile.securityWarnings.length > 0) {
    flags.push(...repoProfile.securityWarnings);
  }
  return flags;
}

function readRuntime(
  packageManager: RepoProfile["packageManager"],
): RunPlan["runtime"] {
  if (packageManager === "bun") {
    return "bun";
  }
  if (packageManager === "unknown") {
    return "unknown";
  }
  return "node";
}

function fallbackInstallCommand(packageManager: RepoProfile["packageManager"]) {
  switch (packageManager) {
    case "bun":
      return "bun install --frozen-lockfile";
    case "npm":
      return "npm ci --no-audit";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --immutable";
    case "unknown":
      return "npm ci --no-audit";
  }
}

function fallbackStartCommand(
  packageManager: RepoProfile["packageManager"],
  port: number,
) {
  const runner = packageManager === "unknown" ? "npm" : packageManager;
  return `${runner} start -- --host 127.0.0.1 --port ${port}`;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value.trim().length === 0
    ? {}
    : ({ [key]: value } as Partial<Record<K, string>>);
}

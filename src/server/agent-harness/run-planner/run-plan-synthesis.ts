import {
  type BrowserRuntimeScriptName,
  type RepoBrowserRuntimeCandidate,
  type RepoProfile,
  type RunPlan,
  type RuntimeTargetSelection,
  browserRuntimeScriptNames,
} from "../schemas/artifacts";
import { readFrameworkDefaultPort } from "./runtime-target-resolution";
import { RuntimeTargetSelectionRequiredError } from "./runtime-target-selection";

export function synthesizeRunPlan(
  repoProfile: RepoProfile,
  selectedTarget?: RuntimeTargetSelection,
): RunPlan {
  if (
    selectedTarget === undefined &&
    repoProfile.workspaces.isMonorepo &&
    (repoProfile.browserRuntimeCandidates?.length ?? 0) === 0
  ) {
    // A monorepo root is an orchestrator, not an app; running it would demo
    // the wrong thing. Without one evidence-backed candidate, fail closed.
    const packageDirs = repoProfile.candidateAppDirs.filter(
      (dir) => dir !== ".",
    );
    throw new RuntimeTargetSelectionRequiredError(
      "No package in this monorepo was proven to be a runnable browser application by screened evidence.",
      packageDirs.length > 0 ? packageDirs : repoProfile.candidateAppDirs,
    );
  }
  const onlyCandidate =
    repoProfile.browserRuntimeCandidates?.length === 1
      ? repoProfile.browserRuntimeCandidates[0]
      : undefined;
  const targetSelection =
    selectedTarget ??
    (onlyCandidate === undefined
      ? undefined
      : {
          evidencePaths: onlyCandidate.evidencePaths,
          reason: "The repository contains one runnable browser application.",
          role: "unknown" as const,
          source: "single-candidate" as const,
          targetId: onlyCandidate.dir,
        });
  const target = findSelectedTarget(repoProfile, targetSelection);
  const port =
    target?.ports[0] ??
    (target === undefined
      ? undefined
      : readFrameworkDefaultPort(Object.values(target.scripts).join("\n"))) ??
    repoProfile.candidatePorts[0] ??
    3000;
  const packageManager = target?.packageManager ?? repoProfile.packageManager;
  const startScript =
    target === undefined ? undefined : findStartScript(target);
  const startCommand =
    (startScript === undefined
      ? repoProfile.candidateStartCommands[0]
      : scriptCommand(packageManager, startScript)) ??
    fallbackStartCommand(packageManager, port);
  return {
    allowedPorts: [port],
    appDir: target?.dir ?? repoProfile.candidateAppDirs[0] ?? ".",
    assumptions: [
      targetSelection?.source === "single-candidate"
        ? "selected the only runnable browser application"
        : targetSelection === undefined
          ? "selected first profiled app directory"
          : targetSelection.reason,
    ],
    ...optionalString(
      "buildCommand",
      isDevelopmentCommand(startCommand)
        ? undefined
        : target?.scripts.build === undefined
          ? repoProfile.candidateBuildCommands[0]
          : scriptCommand(packageManager, "build"),
    ),
    env: { NODE_ENV: "development" },
    expectedLocalUrl: `http://127.0.0.1:${port}`,
    installCommand:
      target !== undefined &&
      (target.isWorkspace === false ||
        packageManager !== repoProfile.packageManager)
        ? fallbackInstallCommand(packageManager)
        : (repoProfile.candidateInstallCommands[0] ??
          fallbackInstallCommand(packageManager)),
    localServices: [],
    riskFlags: readRiskFlags(repoProfile),
    runtime: readRuntime(packageManager),
    startCommand,
    ...(targetSelection === undefined ? {} : { targetSelection }),
    validationExpectations: [
      "base URL loads under Runtime Network Lockdown",
      "at least one meaningful visible route is available",
    ],
  };
}

function findSelectedTarget(
  repoProfile: RepoProfile,
  selection: RuntimeTargetSelection | undefined,
): RepoBrowserRuntimeCandidate | undefined {
  if (selection === undefined) return undefined;
  const candidate = repoProfile.browserRuntimeCandidates?.find(
    ({ dir }) => dir === selection.targetId,
  );
  if (candidate === undefined) {
    throw new Error(
      `Selected runtime target ${selection.targetId} is not a profiled browser application.`,
    );
  }
  return candidate;
}

function findStartScript(
  target: RepoBrowserRuntimeCandidate,
): BrowserRuntimeScriptName | undefined {
  return browserRuntimeScriptNames.find(
    (name) => target.scripts[name] !== undefined,
  );
}

function scriptCommand(
  packageManager: RepoProfile["packageManager"],
  script: string,
): string {
  return `${packageManager === "unknown" ? "npm" : packageManager} run ${script}`;
}

function isDevelopmentCommand(command: string): boolean {
  return /(?:^|\s)(?:run\s+)?(?:dev|develop|serve)(?:\s|$)/.test(command);
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

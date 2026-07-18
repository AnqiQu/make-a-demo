import { posix } from "node:path";
import {
  type PreparationManifest,
  type RepoProfile,
  type RepoWorkspacePackage,
  type RunPlan,
  type ValidationReport,
  browserRuntimeScriptNames,
} from "../schemas/artifacts";

type RuntimeCommand = {
  command: string;
  cwd: string;
};

const scopedInstallManagers = new Set<RepoProfile["packageManager"]>([
  "bun",
  "npm",
  "pnpm",
]);

export type ResolvedRuntimeTarget = {
  baseUrl: string;
  build: RuntimeCommand | undefined;
  install: RuntimeCommand;
  ports: number[];
  start: RuntimeCommand;
  targetId: string;
};

/** Returns a static command configuration problem without executing the repo. */
export function findRuntimeConfigurationIssue(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
}): string | undefined {
  const commands = [
    input.preparationManifest.installCommandUsed,
    input.preparationManifest.buildCommandUsed,
    input.preparationManifest.startCommandUsed,
  ].filter((command): command is string => command !== undefined);
  if (
    commands.some((command) =>
      /^(?:(?:bun|yarn)\b.*\s--cwd|npm\b.*\s--prefix|pnpm\b.*\s(?:--dir|-C))\s+\S+/.test(
        command.trim(),
      ),
    )
  ) {
    return "Runtime commands must use the manifest working directory instead of a command-level working directory flag.";
  }
  for (const command of [
    input.preparationManifest.buildCommandUsed,
    input.preparationManifest.startCommandUsed,
  ]) {
    const scriptName =
      command === undefined ? undefined : readScriptName(command);
    if (scriptName === undefined) {
      continue;
    }
    const scripts =
      input.preparationManifest.appDir === "."
        ? input.repoProfile.packageScripts
        : input.repoProfile.workspacePackages?.find(
            ({ dir }) => dir === input.preparationManifest.appDir,
          )?.scripts;
    if (scripts?.[scriptName] === undefined) {
      return `Runtime script "${scriptName}" is not defined for ${input.preparationManifest.appDir}.`;
    }
  }
  return undefined;
}

function readScriptName(command: string): string | undefined {
  return /^(?:bun|pnpm|yarn|npm)\s+run\s+([^\s]+)/.exec(command.trim())?.[1];
}

/** Applies an unambiguous backend-owned target to the auditable manifest. */
export function resolvePreparationRuntime(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan?: RunPlan;
}): {
  preparationManifest: PreparationManifest;
  runtimeTarget: ResolvedRuntimeTarget | undefined;
} {
  const runtimeTarget = resolveRuntimeTarget(input);
  if (runtimeTarget === undefined) {
    return { preparationManifest: input.preparationManifest, runtimeTarget };
  }
  const { buildCommandUsed: _agentBuildCommand, ...manifest } =
    input.preparationManifest;
  return {
    preparationManifest: {
      ...manifest,
      appDir: runtimeTarget.start.cwd,
      baseUrl: runtimeTarget.baseUrl,
      ...(runtimeTarget.build === undefined
        ? {}
        : { buildCommandUsed: runtimeTarget.build.command }),
      installCommandUsed: runtimeTarget.install.command,
      ports: runtimeTarget.ports,
      startCommandUsed: runtimeTarget.start.command,
    },
    runtimeTarget,
  };
}

/**
 * Expands a focused install only when runtime output proves that a known
 * internal workspace is missing. Unknown registry packages remain agent work.
 */
export function expandPreparationInstallScopeForMissingWorkspace(input: {
  failureReport: ValidationReport;
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan?: RunPlan;
}): PreparationManifest | undefined {
  if (
    !["build failure", "start failure"].includes(
      input.failureReport.failureClassification ?? "",
    ) ||
    !input.repoProfile.workspaces.isMonorepo ||
    !scopedInstallManagers.has(input.repoProfile.packageManager) ||
    resolveRuntimeTarget(input) === undefined
  ) {
    return undefined;
  }
  const knownWorkspaceNames = new Set(
    (input.repoProfile.workspacePackages ?? []).flatMap(({ name }) =>
      name === undefined ? [] : [name],
    ),
  );
  const selectedWorkspaceNames = new Set(
    readSelectedWorkspaceNames(input.preparationManifest.installCommandUsed),
  );
  const missingWorkspaceNames = [
    ...input.failureReport.logsSummary.matchAll(
      /(?:can't resolve|cannot find (?:module|package)|could not resolve|failed to resolve import)[^"'`\r\n]*["'`]([^"'`\r\n]+)["'`]/gi,
    ),
  ]
    .map((match) => readPackageName(match[1] ?? ""))
    .filter(
      (name): name is string =>
        name !== undefined &&
        knownWorkspaceNames.has(name) &&
        !selectedWorkspaceNames.has(name),
    );
  if (missingWorkspaceNames.length === 0) {
    return undefined;
  }
  const scopeName =
    input.repoProfile.packageManager === "npm" ? "workspace" : "filter";
  return resolvePreparationRuntime({
    preparationManifest: {
      ...input.preparationManifest,
      installCommandUsed: `${input.preparationManifest.installCommandUsed}${[
        ...new Set(missingWorkspaceNames),
      ]
        .map((name) => ` --${scopeName}=${name}`)
        .join("")}`,
    },
    repoProfile: input.repoProfile,
    ...(input.runPlan === undefined ? {} : { runPlan: input.runPlan }),
  }).preparationManifest;
}

/** Resolves one prepared browser application to repository-backed commands. */
export function resolveRuntimeTarget(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan?: RunPlan;
}): ResolvedRuntimeTarget | undefined {
  const workspacePackage = findPreparedWorkspacePackage(input);
  if (workspacePackage === undefined) {
    return undefined;
  }
  const packageManager =
    workspacePackage.packageManager ?? input.repoProfile.packageManager;
  const baseInstallCommand =
    workspacePackage.isWorkspace === false ||
    packageManager !== input.repoProfile.packageManager
      ? createInstallCommand(packageManager)
      : (input.repoProfile.candidateInstallCommands[0] ??
        input.preparationManifest.installCommandUsed);
  const installCommand = createTargetInstallCommand(
    input.repoProfile,
    workspacePackage,
    baseInstallCommand,
    readSelectedWorkspaceNames(input.preparationManifest.installCommandUsed),
    packageManager,
  );
  const scopedInstall = installCommand !== baseInstallCommand;
  const preferPackageLocalCommands =
    scopedInstall || workspacePackage.isWorkspace === false;
  const start = findStartCommand(
    input.repoProfile,
    workspacePackage,
    preferPackageLocalCommands,
    packageManager,
  );
  if (start === undefined) {
    return undefined;
  }
  const port =
    start.port ??
    workspacePackage.ports[0] ??
    readFrameworkDefaultPort(
      workspacePackage.scripts[start.scriptName] ?? "",
    ) ??
    input.preparationManifest.ports[0] ??
    3000;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    build: ["dev", "develop", "serve"].includes(start.scriptName)
      ? undefined
      : findBuildCommand(
          input.repoProfile,
          workspacePackage,
          preferPackageLocalCommands,
          packageManager,
        ),
    install: {
      command: installCommand,
      cwd:
        workspacePackage.installDir ??
        findInstallDirectory(input.repoProfile, workspacePackage.dir),
    },
    ports: [port],
    start: { command: start.command, cwd: start.cwd },
    targetId: workspacePackage.dir,
  };
}

function createTargetInstallCommand(
  repoProfile: RepoProfile,
  workspacePackage: RepoWorkspacePackage,
  command: string,
  additionalWorkspaceNames: string[],
  packageManager: RepoProfile["packageManager"],
): string {
  if (
    !scopedInstallManagers.has(packageManager) ||
    !repoProfile.workspaces.isMonorepo ||
    workspacePackage.isWorkspace === false ||
    workspacePackage.dir === "." ||
    /(?:^|\s)--(?:filter|workspace)(?:=|\s)/.test(command)
  ) {
    return command;
  }
  const filters = readWorkspaceDependencyClosure(
    repoProfile,
    workspacePackage,
    additionalWorkspaceNames,
  ).map(readWorkspaceFilter);
  return filters.some((filter) => filter === undefined)
    ? command
    : `${command}${filters
        .map(
          (filter) =>
            ` --${packageManager === "npm" ? "workspace" : "filter"}=${filter}`,
        )
        .join("")}`;
}

function readWorkspaceDependencyClosure(
  repoProfile: RepoProfile,
  target: RepoWorkspacePackage,
  additionalWorkspaceNames: string[],
): RepoWorkspacePackage[] {
  const packagesByName = new Map(
    (repoProfile.workspacePackages ?? []).flatMap((workspacePackage) =>
      workspacePackage.name === undefined
        ? []
        : [[workspacePackage.name, workspacePackage] as const],
    ),
  );
  const closure: RepoWorkspacePackage[] = [];
  const queue = [
    target,
    ...additionalWorkspaceNames.flatMap((name) => {
      const workspacePackage = packagesByName.get(name);
      return workspacePackage === undefined ? [] : [workspacePackage];
    }),
  ];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const workspacePackage = queue.shift();
    if (workspacePackage === undefined || seen.has(workspacePackage.dir)) {
      continue;
    }
    seen.add(workspacePackage.dir);
    closure.push(workspacePackage);
    for (const dependency of workspacePackage.workspaceDependencies ?? []) {
      const dependencyPackage = packagesByName.get(dependency);
      if (dependencyPackage !== undefined) {
        queue.push(dependencyPackage);
      }
    }
  }
  return closure;
}

function readSelectedWorkspaceNames(command: string): string[] {
  return command.split(/\s+/).flatMap((argument) => {
    const match = /^--(?:filter|workspace)=([A-Za-z0-9._/@:-]+)$/.exec(
      argument,
    );
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function readPackageName(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined
      ? `${scope}/${name}`
      : undefined;
  }
  const [name] = specifier.split("/");
  return name?.length === 0 || specifier.startsWith(".") ? undefined : name;
}

function readWorkspaceFilter(
  workspacePackage: RepoWorkspacePackage,
): string | undefined {
  return [workspacePackage.name, `./${workspacePackage.dir}`].find(
    (candidate): candidate is string =>
      candidate !== undefined && /^[A-Za-z0-9._/@:-]+$/.test(candidate),
  );
}

/** Returns the conventional local port implied by a browser framework command. */
export function readFrameworkDefaultPort(command: string): number | undefined {
  if (/\b(?:vite|svelte-kit|qwik)\b/.test(command)) {
    return 5173;
  }
  if (/\bastro\b/.test(command)) {
    return 4321;
  }
  if (/\b(?:next|nuxt|react-scripts|remix)\b/.test(command)) {
    return 3000;
  }
  if (/\bng\s+serve\b/.test(command)) return 4200;
  if (/\bgatsby\b/.test(command)) return 8000;
  if (/\b(?:vue-cli-service|webpack(?:-dev-server)?)\b/.test(command)) {
    return 8080;
  }
  if (/\bparcel\b/.test(command)) return 1234;
  return undefined;
}

function findPreparedWorkspacePackage(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan?: RunPlan;
}): RepoWorkspacePackage | undefined {
  const lockedTargetId =
    input.runPlan?.targetSelection?.targetId ??
    (input.repoProfile.browserRuntimeCandidates?.some(
      ({ dir }) => dir === input.runPlan?.appDir,
    )
      ? input.runPlan?.appDir
      : undefined);
  if (lockedTargetId !== undefined) {
    return (
      input.repoProfile.workspacePackages?.find(
        ({ dir }) => dir === lockedTargetId,
      ) ??
      input.repoProfile.browserRuntimeCandidates?.find(
        ({ dir }) => dir === lockedTargetId,
      )
    );
  }
  const selected = new Set<RepoWorkspacePackage>();
  for (const feature of input.preparationManifest.productContext
    .featureInventory) {
    for (const path of feature.sourcePaths) {
      const candidates = (input.repoProfile.workspacePackages ?? [])
        .filter(
          ({ dir, scripts }) =>
            (path === dir || path.startsWith(`${dir}/`)) &&
            browserRuntimeScriptNames.some(
              (scriptName) => scripts[scriptName] !== undefined,
            ),
        )
        .sort((left, right) => right.dir.length - left.dir.length);
      if (candidates[0] !== undefined) {
        selected.add(candidates[0]);
      }
    }
  }
  return selected.size === 1 ? [...selected][0] : undefined;
}

function findStartCommand(
  repoProfile: RepoProfile,
  workspacePackage: RepoWorkspacePackage,
  preferWorkspaceLocal: boolean,
  packageManager: RepoProfile["packageManager"],
):
  | { command: string; cwd: string; port?: number; scriptName: string }
  | undefined {
  for (const scriptName of browserRuntimeScriptNames) {
    if (workspacePackage.scripts[scriptName] === undefined) {
      continue;
    }
    const rootScriptName = preferWorkspaceLocal
      ? undefined
      : findScopedRootScript(
          repoProfile.packageScripts,
          workspacePackage,
          scriptName,
        );
    if (rootScriptName !== undefined) {
      return {
        command: scriptCommand(packageManager, rootScriptName),
        cwd: ".",
        ...readCommandPort(repoProfile.packageScripts[rootScriptName] ?? ""),
        scriptName,
      };
    }
    return {
      command: scriptCommand(packageManager, scriptName),
      cwd: workspacePackage.dir,
      scriptName,
    };
  }
  return undefined;
}

function readCommandPort(command: string): { port?: number } {
  const value = Number(/(?:--port|-p)\s+(\d{2,5})/.exec(command)?.[1]);
  return Number.isInteger(value) && value > 0 && value <= 65_535
    ? { port: value }
    : {};
}

function findBuildCommand(
  repoProfile: RepoProfile,
  workspacePackage: RepoWorkspacePackage,
  preferWorkspaceLocal: boolean,
  packageManager: RepoProfile["packageManager"],
): RuntimeCommand | undefined {
  if (workspacePackage.scripts.build === undefined) {
    return undefined;
  }
  const rootScriptName = preferWorkspaceLocal
    ? undefined
    : findScopedRootScript(
        repoProfile.packageScripts,
        workspacePackage,
        "build",
      );
  return rootScriptName === undefined
    ? {
        command: scriptCommand(packageManager, "build"),
        cwd: workspacePackage.dir,
      }
    : {
        command: scriptCommand(packageManager, rootScriptName),
        cwd: ".",
      };
}

function findScopedRootScript(
  scripts: Record<string, string>,
  workspacePackage: RepoWorkspacePackage,
  operation: string,
): string | undefined {
  const shortName = posix.basename(workspacePackage.dir);
  const named = `${operation}:${shortName}`;
  if (scripts[named] !== undefined) {
    return named;
  }
  if (workspacePackage.name === undefined) {
    return undefined;
  }
  return Object.entries(scripts).find(
    ([name, command]) =>
      (name === operation || name.startsWith(`${operation}:`)) &&
      command.includes(workspacePackage.name as string),
  )?.[0];
}

function scriptCommand(
  packageManager: RepoProfile["packageManager"],
  scriptName: string,
): string {
  const runner = packageManager === "unknown" ? "npm" : packageManager;
  return `${runner} run ${scriptName}`;
}

function createInstallCommand(
  packageManager: RepoProfile["packageManager"],
): string {
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
      return "npm install --no-audit";
  }
}

function findInstallDirectory(
  repoProfile: RepoProfile,
  targetDir: string,
): string {
  const owners = repoProfile.lockfiles
    .map((lockfile) => posix.dirname(lockfile))
    .filter(
      (dir) =>
        dir === "." || targetDir === dir || targetDir.startsWith(`${dir}/`),
    )
    .sort((left, right) => right.length - left.length);
  return owners[0] ?? ".";
}

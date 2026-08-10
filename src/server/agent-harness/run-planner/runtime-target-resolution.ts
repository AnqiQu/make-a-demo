import { posix } from "node:path";
import {
  type PreparationManifest,
  type RepoProfile,
  type RepoWorkspacePackage,
  type RunPlan,
  type ValidationReport,
  browserRuntimeScriptNames,
} from "../schemas/artifacts";
import {
  createInstallCommand,
  createRunScriptCommand,
  isDevServerScriptBody,
  isTaskRunnerTargetScript,
  readCandidatePorts,
  readPackageName,
  readScriptPort,
} from "./package-commands";

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

/** Why no runtime target could be resolved, with the viable directories. */
export type UnresolvedRuntimeTarget = {
  candidateIds: string[];
  reason: string;
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
  unresolved?: UnresolvedRuntimeTarget;
} {
  const outcome = resolveRuntimeTargetOutcome(input);
  const runtimeTarget = outcome.target;
  if (runtimeTarget === undefined) {
    return {
      preparationManifest: input.preparationManifest,
      runtimeTarget,
      ...(outcome.unresolved === undefined
        ? {}
        : { unresolved: outcome.unresolved }),
    };
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
    !["build failure", "missing dependency", "start failure"].includes(
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
  const runtimeEvidence = [
    input.failureReport.logsSummary,
    ...input.failureReport.stderrExcerpts,
    ...input.failureReport.stdoutExcerpts,
  ].join("\n");
  const missingWorkspaceNames = [
    ...runtimeEvidence.matchAll(
      /(?:can't resolve|cannot find (?:module|package)|could not resolve|failed to resolve (?:import|entry for package))[^"'`\r\n]*["'`]([^"'`\r\n]+)["'`]/gi,
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
  return resolveRuntimeTargetOutcome(input).target;
}

function resolveRuntimeTargetOutcome(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan?: RunPlan;
}): { target?: ResolvedRuntimeTarget; unresolved?: UnresolvedRuntimeTarget } {
  const found = findPreparedWorkspacePackage(input);
  const workspacePackage = found.workspacePackage;
  if (workspacePackage === undefined) {
    return found.unresolved === undefined
      ? {}
      : { unresolved: found.unresolved };
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
    return {
      unresolved: {
        candidateIds: [workspacePackage.dir],
        reason: `Workspace ${workspacePackage.dir} declares no runnable browser start script.`,
      },
    };
  }
  const selectedScriptBody = workspacePackage.scripts[start.scriptName] ?? "";
  // Port evidence is scoped to the selected script: a port in a sibling
  // script (a static `serve`, a storybook) says nothing about where this
  // start command binds. The agent-declared manifest port ranks above the
  // framework-default table because the agent observed the running app, and
  // config files routinely override framework defaults — a repair that
  // corrects the port must be adoptable or the preflight loop cannot
  // converge.
  const port =
    start.port ??
    readScriptPort(selectedScriptBody) ??
    readCandidatePorts({ [start.scriptName]: selectedScriptBody })[0] ??
    input.preparationManifest.ports[0] ??
    readFrameworkDefaultPort(selectedScriptBody) ??
    3000;
  return {
    target: {
      baseUrl: `http://127.0.0.1:${port}`,
      build:
        (isDevServerScriptBody(selectedScriptBody) ??
        ["dev", "develop"].includes(start.scriptName))
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
    },
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
  if (filters.some((filter) => filter === undefined)) {
    return command;
  }
  // Filter-scoped installs skip the workspace root, whose package.json can
  // declare dependencies the selected app resolves through hoisting. npm is
  // exempt: it installs root dependencies regardless of --workspace flags.
  const rootFilter =
    packageManager !== "npm" &&
    repoProfile.rootPackageName !== undefined &&
    !filters.includes(repoProfile.rootPackageName)
      ? [repoProfile.rootPackageName]
      : [];
  return `${command}${[...filters, ...rootFilter]
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
      // A file-linked package outside the declared workspaces resolves by
      // path, so the root install cannot (and must not) filter for it.
      if (dependencyPackage?.isWorkspace !== false) {
        queue.push(
          ...(dependencyPackage === undefined ? [] : [dependencyPackage]),
        );
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
}): {
  unresolved?: UnresolvedRuntimeTarget;
  workspacePackage?: RepoWorkspacePackage;
} {
  const candidateIds = (input.repoProfile.browserRuntimeCandidates ?? []).map(
    ({ dir }) => dir,
  );
  const lockedTargetId =
    input.runPlan?.targetSelection?.targetId ??
    (input.repoProfile.browserRuntimeCandidates?.some(
      ({ dir }) => dir === input.runPlan?.appDir,
    )
      ? input.runPlan?.appDir
      : undefined);
  if (lockedTargetId !== undefined) {
    const workspacePackage =
      input.repoProfile.workspacePackages?.find(
        ({ dir }) => dir === lockedTargetId,
      ) ??
      input.repoProfile.browserRuntimeCandidates?.find(
        ({ dir }) => dir === lockedTargetId,
      );
    return workspacePackage === undefined
      ? {
          unresolved: {
            candidateIds,
            reason: `Locked runtime target ${lockedTargetId} is not a profiled workspace.`,
          },
        }
      : { workspacePackage };
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
  const [selectedPackage] = selected;
  if (selected.size === 1 && selectedPackage !== undefined) {
    return { workspacePackage: selectedPackage };
  }
  if (selected.size === 0) {
    return {
      unresolved: {
        candidateIds,
        reason: "No prepared feature source path maps to a runnable workspace.",
      },
    };
  }
  const spannedDirs = [...selected].map(({ dir }) => dir).sort();
  return {
    unresolved: {
      candidateIds: spannedDirs,
      reason: `Prepared feature source paths span multiple runnable workspaces: ${spannedDirs.join(", ")}.`,
    },
  };
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
      : findScopedRootScript(repoProfile, workspacePackage, scriptName);
    if (rootScriptName !== undefined) {
      const rootPort = readScriptPort(
        repoProfile.packageScripts[rootScriptName] ?? "",
      );
      return {
        command: createRunScriptCommand(packageManager, rootScriptName),
        cwd: ".",
        ...(rootPort === undefined ? {} : { port: rootPort }),
        scriptName,
      };
    }
    const scriptBody = workspacePackage.scripts[scriptName] ?? "";
    return {
      command: isTaskRunnerTargetScript(scriptBody)
        ? `npx ${scriptBody}`
        : createRunScriptCommand(packageManager, scriptName),
      cwd: workspacePackage.dir,
      scriptName,
    };
  }
  return undefined;
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
    : findScopedRootScript(repoProfile, workspacePackage, "build");
  return rootScriptName === undefined
    ? {
        command: createRunScriptCommand(packageManager, "build"),
        cwd: workspacePackage.dir,
      }
    : {
        command: createRunScriptCommand(packageManager, rootScriptName),
        cwd: ".",
      };
}

function findScopedRootScript(
  repoProfile: RepoProfile,
  workspacePackage: RepoWorkspacePackage,
  operation: string,
): string | undefined {
  const scripts = repoProfile.packageScripts;
  const otherWorkspaceNames = (repoProfile.workspacePackages ?? [])
    .map(({ name }) => name)
    .filter(
      (name): name is string =>
        name !== undefined && name !== workspacePackage.name,
    );
  const targetsAnotherWorkspace = (command: string) =>
    otherWorkspaceNames.some((name) => referencesPackageName(command, name));
  const shortName = posix.basename(workspacePackage.dir);
  const named = `${operation}:${shortName}`;
  const namedCommand = scripts[named];
  if (namedCommand !== undefined && !targetsAnotherWorkspace(namedCommand)) {
    return named;
  }
  if (workspacePackage.name === undefined) {
    return undefined;
  }
  return Object.entries(scripts).find(
    ([name, command]) =>
      (name === operation || name.startsWith(`${operation}:`)) &&
      referencesPackageName(command, workspacePackage.name as string) &&
      !targetsAnotherWorkspace(command),
  )?.[0];
}

/**
 * Whether a script command references a package name as a whole token. A name
 * that is a prefix or suffix of a longer name never matches, so `@a/web` does
 * not claim a script targeting `@a/web-admin`.
 */
function referencesPackageName(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![@/A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`).test(
    command,
  );
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

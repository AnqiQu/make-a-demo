import { posix } from "node:path";
import { escapeRegExp } from "../../shared/text/escape-regexp";
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
      /^(?:(?:bun|yarn)\b.*\s--cwd|npm\b.*\s--prefix|pnpm\b.*\s(?:--dir|-C))(?:=|\s+)\S+/.test(
        command.trim(),
      ),
    )
  ) {
    return "Runtime commands must use the manifest working directory instead of a command-level working directory flag.";
  }
  const knownWorkspaceNames = new Set(
    (input.repoProfile.workspacePackages ?? []).flatMap(({ name }) =>
      name === undefined ? [] : [name],
    ),
  );
  const runtimeScripts = readRuntimeScripts(
    input.preparationManifest.appDir,
    input.repoProfile,
  );
  const productionEntry =
    input.preparationManifest.buildCommandUsed === undefined &&
    input.preparationManifest.startCommandUsed !== undefined
      ? readResolvedProductionEntry(
          input.preparationManifest.startCommandUsed,
          runtimeScripts,
        )
      : undefined;
  if (productionEntry !== undefined) {
    return `Runtime-configuration error: startCommandUsed runs ${productionEntry} but no declared build produces it — declare the build that emits ${productionEntry}, or start the dev server instead.`;
  }
  for (const command of [
    input.preparationManifest.buildCommandUsed,
    input.preparationManifest.startCommandUsed,
  ]) {
    if (command === undefined) {
      continue;
    }
    const scriptName = readScriptName(command);
    if (
      scriptName !== undefined &&
      runtimeScripts?.[scriptName] === undefined
    ) {
      // A rejection that names only the invented script invites the next
      // invention: ghostfolio declared build:makeademo one wave and
      // build:demo two waves later, told only "not defined" both times
      // (N181). Enumerating what the package defines makes the retry a
      // copy, not a guess.
      return `Runtime script "${scriptName}" is not defined for ${input.preparationManifest.appDir}. ${
        runtimeScripts === undefined
          ? "No package manifest was profiled for that directory, so no run-script can execute there."
          : `The manifest may declare only these defined scripts, exactly as spelled: ${definedScriptSummary(runtimeScripts)}.`
      }`;
    }
    // The command may name a workspace directly, or run a script whose body
    // fans out through the task runner; scan both surfaces for a selector
    // that targets a package the repository does not contain.
    const scriptBody =
      scriptName === undefined ? undefined : runtimeScripts?.[scriptName];
    const absentPackage = readAbsentWorkspacePackage(
      [command, scriptBody]
        .filter((value): value is string => value !== undefined)
        .join(" "),
      knownWorkspaceNames,
    );
    if (absentPackage !== undefined) {
      return `Runtime command "${command}" selects workspace package ${absentPackage}, which does not exist in this repository. Run only workspace targets the checkout contains.`;
    }
  }
  return undefined;
}

function readScriptName(command: string): string | undefined {
  return /^(?:bun|pnpm|yarn|npm)\s+run\s+([^\s]+)/.exec(command.trim())?.[1];
}

function definedScriptSummary(scripts: Record<string, string>): string {
  const names = Object.keys(scripts);
  const shown = names.slice(0, 24).join(", ") || "(none)";
  const hidden = names.length - 24;
  return hidden > 0 ? `${shown} (and ${hidden} more)` : shown;
}

function readRuntimeScripts(
  appDir: string,
  repoProfile: RepoProfile,
): Record<string, string> | undefined {
  return appDir === "."
    ? repoProfile.packageScripts
    : repoProfile.workspacePackages?.find(({ dir }) => dir === appDir)?.scripts;
}

function readProductionEntry(command: string): string | undefined {
  return /^\s*(?:node|bun)\s+(?:--\S+\s+)*["']?((?:\.\/)?(?:\.next|\.output|build|dist|out)\/[^"'\s]+)/.exec(
    command,
  )?.[1];
}

function readResolvedProductionEntry(
  command: string,
  scripts: Record<string, string> | undefined,
): string | undefined {
  const resolvedCommand = resolveScriptCommand(command, scripts);
  return resolvedCommand === undefined
    ? undefined
    : readProductionEntry(resolvedCommand);
}

function resolveScriptCommand(
  command: string,
  scripts: Record<string, string> | undefined,
): string | undefined {
  const scriptName = readScriptName(command);
  return scriptName === undefined ? command : scripts?.[scriptName];
}

/**
 * A start whose resolved script references a path inside a conventional
 * build-output directory is production-entry-like even when the reference
 * sits mid-command (nodemon, concurrently — outline's `yarn run dev`). The
 * anchored production-entry regex misses those shapes, but the N148
 * runtime-configuration classifier resolves them and demands the build every
 * round — so the honored-build predicate must agree with the classifier or
 * repair never converges (N159).
 */
function consumesBuildOutput(command: string): boolean {
  return /(?<![\w.@-])(?:\.\/)?(?:\.next|\.output|build|dist|out)\/[^\s"']+/.test(
    command,
  );
}

/** Applies an unambiguous backend-owned target to the auditable manifest. */
export function resolvePreparationRuntime(input: {
  /** Authorize a safe graph build only after the repair ledger escalates it. */
  honorWorkspaceGraphBuild?: boolean;
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
  const { buildCommandUsed: agentBuildCommand, ...manifest } =
    input.preparationManifest;
  const resolvedStartCommand = resolveScriptCommand(
    runtimeTarget.start.command,
    readRuntimeScripts(runtimeTarget.start.cwd, input.repoProfile),
  );
  const startsFromProductionEntry =
    runtimeTarget.build === undefined &&
    resolvedStartCommand !== undefined &&
    (readProductionEntry(resolvedStartCommand) !== undefined ||
      consumesBuildOutput(resolvedStartCommand));
  const buildCommandUsed =
    runtimeTarget.build?.command ??
    readHonoredAgentBuildCommand(
      agentBuildCommand,
      input.repoProfile,
      runtimeTarget.targetId,
      startsFromProductionEntry,
      input.honorWorkspaceGraphBuild === true,
    );
  return {
    preparationManifest: {
      ...manifest,
      appDir: runtimeTarget.start.cwd,
      baseUrl: runtimeTarget.baseUrl,
      ...(buildCommandUsed === undefined ? {} : { buildCommandUsed }),
      installCommandUsed: runtimeTarget.install.command,
      ports: runtimeTarget.ports,
      startCommandUsed: runtimeTarget.start.command,
    },
    runtimeTarget,
  };
}

/**
 * The agent-authored runtime field resolution can safely honor instead of
 * replacing. A build that names a real workspace package supplies a sibling
 * output a dev server cannot rebuild (N131). A build paired with a resolved
 * production-entry start is also required: dropping it would emit the exact
 * start-without-build lifecycle rejected by runtime configuration validation
 * (N154). After repeated unbuilt-workspace failures, the orchestrator may
 * also authorize the repository's graph build (N155). Every exception stays
 * behind the absent-workspace selector check; anything else remains
 * backend-owned and is dropped.
 */
function readHonoredAgentBuildCommand(
  agentBuildCommand: string | undefined,
  repoProfile: RepoProfile,
  targetDir: string,
  startsFromProductionEntry: boolean,
  honorWorkspaceGraphBuild: boolean,
): string | undefined {
  if (agentBuildCommand === undefined) {
    return undefined;
  }
  const knownWorkspaceNames = new Set(
    (repoProfile.workspacePackages ?? []).flatMap(({ name }) =>
      name === undefined ? [] : [name],
    ),
  );
  const scriptName = readScriptName(agentBuildCommand);
  const scripts = readRuntimeScripts(targetDir, repoProfile);
  const surfaces = [
    agentBuildCommand,
    scriptName === undefined ? undefined : scripts?.[scriptName],
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  if (readAbsentWorkspacePackage(surfaces, knownWorkspaceNames) !== undefined) {
    return undefined;
  }
  if (startsFromProductionEntry) {
    return agentBuildCommand;
  }
  if (
    honorWorkspaceGraphBuild &&
    isWorkspaceGraphBuildCommand(agentBuildCommand, surfaces, {
      repoProfile,
      targetDir,
    })
  ) {
    return agentBuildCommand;
  }
  // Unnamed workspace packages are hinted by directory, and pnpm-style path
  // filters spell directories as `./<dir>` — both count as naming a target.
  const referenceIdentifiers = [
    ...knownWorkspaceNames,
    ...(repoProfile.workspacePackages ?? []).flatMap(({ dir }) =>
      dir === "." ? [] : [dir, `./${dir}`],
    ),
  ];
  return referenceIdentifiers.some((identifier) =>
    referencesPackageName(surfaces, identifier),
  )
    ? agentBuildCommand
    : undefined;
}

function isWorkspaceGraphBuildCommand(
  command: string,
  resolvedSurfaces: string,
  input: { repoProfile: RepoProfile; targetDir: string },
): boolean {
  const expected = createWorkspaceGraphBuildCommand(input);
  if (expected !== undefined && command.trim() === expected) {
    return true;
  }
  if (
    input.targetDir === "." &&
    ["build", "prepare"].some(
      (scriptName) =>
        readScriptName(command) === scriptName &&
        input.repoProfile.packageScripts[scriptName] !== undefined,
    )
  ) {
    return true;
  }
  return (
    /(?:^|\s)pnpm\s+(?=[^\n]*(?:-r|--recursive)(?:\s|$))(?=[^\n]*(?:run\s+)?\b(?:build|prepare)(?:\s|$))/.test(
      resolvedSurfaces,
    ) ||
    /(?:^|\s)(?:npx\s+)?turbo\s+(?:run\s+)?(?:build|prepare)(?:\s|$)/.test(
      resolvedSurfaces,
    ) ||
    /(?:^|\s)(?:npx\s+)?nx\s+run-many\b(?=[^\n]*(?:--target(?:=|\s+)|-t\s+)(?:build|prepare)(?:\s|$))/.test(
      resolvedSurfaces,
    )
  );
}

/**
 * Returns one repository-backed workspace graph build for a selected app.
 * The command uses only profiled package identities, scopes to the declared
 * dependency closure when complete filters exist, and never changes cwd in
 * the command. Undefined means the profile exposes no safe graph runner.
 */
export function createWorkspaceGraphBuildCommand(input: {
  repoProfile: RepoProfile;
  targetDir: string;
}): string | undefined {
  if (!input.repoProfile.workspaces.isMonorepo) {
    return undefined;
  }
  const target =
    input.repoProfile.workspacePackages?.find(
      ({ dir }) => dir === input.targetDir,
    ) ??
    input.repoProfile.browserRuntimeCandidates?.find(
      ({ dir }) => dir === input.targetDir,
    );
  if (target === undefined) {
    return undefined;
  }
  if (target.dir === ".") {
    const rootScript = ["build", "prepare"].find(
      (scriptName) =>
        input.repoProfile.packageScripts[scriptName] !== undefined,
    );
    if (rootScript !== undefined) {
      return createRunScriptCommand(
        input.repoProfile.packageManager,
        rootScript,
      );
    }
  }

  const graphPackages =
    target.workspaceDependencies === undefined
      ? undefined
      : readWorkspaceDependencyClosure(input.repoProfile, target, []);
  const graphRunnerScripts = [
    ...Object.values(input.repoProfile.packageScripts),
    ...Object.values(target.scripts),
  ].join("\n");
  const graphTask = ["build", "prepare"].find((scriptName) =>
    (graphPackages ?? input.repoProfile.workspacePackages ?? []).some(
      ({ scripts }) => scripts[scriptName] !== undefined,
    ),
  );
  if (graphTask === undefined) {
    return undefined;
  }
  const graphTaskPackages = graphPackages?.filter(
    ({ scripts }) => scripts[graphTask] !== undefined,
  );

  if (/\bturbo(?:\s+run)?\b/.test(graphRunnerScripts)) {
    const filters = readNamedGraphFilters(graphTaskPackages);
    return `npx turbo run ${graphTask}${filters
      .map((filter) => ` --filter=${filter}`)
      .join("")}`;
  }
  if (/\bnx\s+(?:run|run-many)\b/.test(graphRunnerScripts)) {
    const projects = readNamedGraphFilters(graphTaskPackages);
    return `npx nx run-many --target=${graphTask}${
      projects.length === 0 ? " --all" : ` --projects=${projects.join(",")}`
    }`;
  }
  if (input.repoProfile.packageManager === "pnpm") {
    const targetFilter =
      target.workspaceDependencies === undefined
        ? undefined
        : readWorkspaceFilter(target);
    return `pnpm --recursive${
      targetFilter === undefined ? "" : ` --filter=${targetFilter}...`
    } run ${graphTask}`;
  }
  return undefined;
}

function readNamedGraphFilters(
  graphPackages: RepoWorkspacePackage[] | undefined,
): string[] {
  if (
    graphPackages === undefined ||
    graphPackages.some(({ name }) => name === undefined)
  ) {
    return [];
  }
  return graphPackages.map(({ name }) => name as string).sort();
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
  const workspaceNames = (repoProfile.workspacePackages ?? []).flatMap(
    ({ name }) => (name === undefined ? [] : [name]),
  );
  const otherWorkspaceNames = workspaceNames.filter(
    (name) => name !== workspacePackage.name,
  );
  const knownWorkspaceNames = new Set(workspaceNames);
  const unusableRootScript = (command: string) =>
    otherWorkspaceNames.some((name) => referencesPackageName(command, name)) ||
    readAbsentWorkspacePackage(command, knownWorkspaceNames) !== undefined;
  const shortName = posix.basename(workspacePackage.dir);
  const named = `${operation}:${shortName}`;
  const namedCommand = scripts[named];
  if (namedCommand !== undefined && !unusableRootScript(namedCommand)) {
    return named;
  }
  if (workspacePackage.name === undefined) {
    return undefined;
  }
  return Object.entries(scripts).find(
    ([name, command]) =>
      (name === operation || name.startsWith(`${operation}:`)) &&
      referencesPackageName(command, workspacePackage.name as string) &&
      !unusableRootScript(command),
  )?.[0];
}

/**
 * Whether a command selects a workspace package the repository does not
 * contain. Task-runner fan-out scripts (turbo/pnpm `--filter`, lerna
 * `--scope`, nx `--project`) validate every selector before launching, so a
 * script naming a package absent from the workspace set — a proprietary
 * sibling stripped from an OSS checkout, as with cal.com's `dev:all` reaching
 * for `@calcom/website` — aborts before the real app can bind. Returns the
 * first offending package name so callers can name it in a repair message.
 *
 * A selector is judged absent only when it names the repository's own
 * namespace yet matches no workspace: a scoped name is judged when it shares a
 * scope with a known workspace, an unscoped name only when the repo actually
 * uses unscoped workspace names and the name matches neither a full workspace
 * name nor a workspace's short name (so `--filter=web` still resolves to
 * `@a/web`). Pnpm relationship markers are stripped before that check, while
 * registry dependencies of a foreign scope, path filters (`./pkg`), and
 * globs (`@a/*`) are never judged, so only a genuinely missing target trips
 * this.
 */
function readAbsentWorkspacePackage(
  command: string,
  knownWorkspaceNames: ReadonlySet<string>,
): string | undefined {
  const readScope = (name: string) => /^(@[A-Za-z0-9._-]+)\//.exec(name)?.[1];
  const shortNameOf = (name: string) =>
    name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const knownScopes = new Set(
    [...knownWorkspaceNames].flatMap((name) => {
      const scope = readScope(name);
      return scope === undefined ? [] : [scope];
    }),
  );
  const knownShortNames = new Set([...knownWorkspaceNames].map(shortNameOf));
  const repoUsesUnscopedNames = [...knownWorkspaceNames].some(
    (name) => !name.startsWith("@"),
  );
  for (const match of command.matchAll(
    /--(?:filter|workspace|scope|projects?)[=\s]+["']?([^"'\s]+)["']?/g,
  )) {
    // Nx accepts a comma-delimited --projects list. Every project remains an
    // independent selector for the same absent-workspace safety invariant.
    for (const rawSelector of (match[1] ?? "").split(",")) {
      // Pnpm relationship markers (`web...`, `...web`) change graph breadth;
      // their base remains a literal selector and must still resolve.
      const selector = rawSelector
        .replace(/^\.\.\./, "")
        .replace(/\.\.\.$/, "");
      if (selector.length === 0 || selector.includes("...")) {
        continue;
      }
      const scope = readScope(selector);
      if (scope !== undefined) {
        // A clean scoped name only; a scoped glob (`@a/*`) or extra segment is
        // not a literal package selector.
        if (!/^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(selector)) {
          continue;
        }
        if (knownScopes.has(scope) && !knownWorkspaceNames.has(selector)) {
          return selector;
        }
        continue;
      }
      // A bare identifier only; anything with a slash is a path filter and
      // anything with glob/pattern punctuation is not a literal name.
      if (!/^[A-Za-z0-9._-]+$/.test(selector)) {
        continue;
      }
      if (
        repoUsesUnscopedNames &&
        !knownWorkspaceNames.has(selector) &&
        !knownShortNames.has(selector)
      ) {
        return selector;
      }
    }
  }
  return undefined;
}

/**
 * Whether a script command references a package name as a whole token. A name
 * that is a prefix or suffix of a longer name never matches, so `@a/web` does
 * not claim a script targeting `@a/web-admin`.
 */
function referencesPackageName(command: string, name: string): boolean {
  return new RegExp(
    `(?<![@/A-Za-z0-9._-])${escapeRegExp(name)}(?![A-Za-z0-9._-])`,
  ).test(command);
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

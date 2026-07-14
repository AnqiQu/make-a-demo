import { posix } from "node:path";
import type {
  PreparationManifest,
  RepoProfile,
  RepoWorkspacePackage,
} from "../schemas/artifacts";

type RuntimeCommand = {
  command: string;
  cwd: string;
};

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

/** Resolves one prepared browser application to repository-backed commands. */
export function resolveRuntimeTarget(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
}): ResolvedRuntimeTarget | undefined {
  const workspacePackage = findPreparedWorkspacePackage(input);
  if (workspacePackage === undefined) {
    return undefined;
  }
  const start = findStartCommand(input.repoProfile, workspacePackage);
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
    build:
      start.scriptName === "dev"
        ? undefined
        : findBuildCommand(input.repoProfile, workspacePackage),
    install: {
      command:
        input.repoProfile.candidateInstallCommands[0] ??
        input.preparationManifest.installCommandUsed,
      cwd: findInstallDirectory(input.repoProfile, workspacePackage.dir),
    },
    ports: [port],
    start: { command: start.command, cwd: start.cwd },
    targetId: workspacePackage.dir,
  };
}

function readFrameworkDefaultPort(command: string): number | undefined {
  if (/\b(?:vite|svelte-kit)\b/.test(command)) {
    return 5173;
  }
  if (/\bastro\b/.test(command)) {
    return 4321;
  }
  if (/\b(?:next|nuxt|remix)\b/.test(command)) {
    return 3000;
  }
  return undefined;
}

function findPreparedWorkspacePackage(input: {
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
}): RepoWorkspacePackage | undefined {
  const selected = new Set<RepoWorkspacePackage>();
  for (const feature of input.preparationManifest.productContext
    .featureInventory) {
    for (const path of feature.sourcePaths) {
      const candidates = (input.repoProfile.workspacePackages ?? [])
        .filter(
          ({ dir, scripts }) =>
            (path === dir || path.startsWith(`${dir}/`)) &&
            ["dev", "start", "preview"].some(
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
):
  | { command: string; cwd: string; port?: number; scriptName: string }
  | undefined {
  for (const scriptName of ["dev", "start", "preview"]) {
    if (workspacePackage.scripts[scriptName] === undefined) {
      continue;
    }
    const rootScriptName = findScopedRootScript(
      repoProfile.packageScripts,
      workspacePackage,
      scriptName,
    );
    if (rootScriptName !== undefined) {
      return {
        command: scriptCommand(repoProfile.packageManager, rootScriptName),
        cwd: ".",
        ...readCommandPort(repoProfile.packageScripts[rootScriptName] ?? ""),
        scriptName,
      };
    }
    return {
      command: scriptCommand(repoProfile.packageManager, scriptName),
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
): RuntimeCommand | undefined {
  if (workspacePackage.scripts.build === undefined) {
    return undefined;
  }
  const rootScriptName = findScopedRootScript(
    repoProfile.packageScripts,
    workspacePackage,
    "build",
  );
  return rootScriptName === undefined
    ? {
        command: scriptCommand(repoProfile.packageManager, "build"),
        cwd: workspacePackage.dir,
      }
    : {
        command: scriptCommand(repoProfile.packageManager, rootScriptName),
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

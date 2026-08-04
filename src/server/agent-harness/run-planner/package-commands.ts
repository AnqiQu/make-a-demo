import type { PackageManager } from "../schemas/artifacts";

/**
 * The one shared reading of package scripts for the run planner and the repo
 * profiler: which port a script binds, whether its body is a dev server or a
 * static file server, how to invoke a script or an install for each package
 * manager, and how a module specifier maps to a package name. Implementations
 * must stay framework-agnostic: they may recognize well-known tools, but must
 * never special-case a single repository's conventions.
 */

const scriptPortPattern =
  /(?:--port|-p)(?:=|\s+)(\d{2,5})|(?:^|\s)PORT=(\d{2,5})|(?:^|\s)-l(?:=|\s+)(\d{2,5})/g;

/**
 * Reads the port a script binds: `--port`/`-p` (space or equals form),
 * a leading `PORT=` assignment, or a static server's `-l` listen flag.
 * The last match wins, mirroring how CLIs let later flags override.
 */
export function readScriptPort(script: string): number | undefined {
  const matches = [...script.matchAll(scriptPortPattern)];
  const last = matches.at(-1);
  const value = Number(last?.[1] ?? last?.[2] ?? last?.[3]);
  return Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : undefined;
}

/** Collects every port mentioned across a package's scripts, ascending. */
export function readCandidatePorts(scripts: Record<string, string>): number[] {
  const ports = new Set<number>();
  for (const script of Object.values(scripts)) {
    for (const match of script.matchAll(scriptPortPattern)) {
      const port = Number(match[1] ?? match[2] ?? match[3]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        ports.add(port);
      }
    }
    for (const match of script.matchAll(
      /(?:localhost|127\.0\.0\.1):(\d{2,5})/g,
    )) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        ports.add(port);
      }
    }
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * Invokes a package script through `<pm> run <script>` for every manager.
 * The `run` form is mandatory: bare `bun build` or `yarn build` invoke
 * builtin tools of the same name instead of the package's script.
 */
export function createRunScriptCommand(
  packageManager: PackageManager,
  scriptName: string,
): string {
  return `${packageManager === "unknown" ? "npm" : packageManager} run ${scriptName}`;
}

/**
 * The deterministic lockfile-respecting install for each package manager.
 * An unknown manager gets a plain `npm install`: without a known lockfile,
 * `npm ci` would refuse to run at all.
 */
export function createInstallCommand(packageManager: PackageManager): string {
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

/**
 * Classifies a script body: `true` for a recognized dev server (no build
 * step needed), `false` for a recognized static file server (a build must
 * run first), `undefined` when the body proves neither. Callers decide the
 * undefined case from the script name.
 */
export function isDevServerScriptBody(body: string): boolean | undefined {
  if (
    isStaticFileServerBody(body) ||
    /\bvite\s+preview\b/.test(body) ||
    /\bnext\s+start\b/.test(body)
  ) {
    return false;
  }
  if (
    /\b(?:next|nuxt|nuxi|remix|astro|qwik|gatsby|svelte-kit|solid-start|vinxi|turbo(?:\s+run)?)\s+dev(?:elop)?\b/.test(
      body,
    ) ||
    /\bvite\b(?!\s+(?:build|preview|optimize))/.test(body) ||
    /\bwebpack(?:-dev-server)?\s+serve\b|\bwebpack-dev-server\b/.test(body) ||
    /\bng\s+serve\b/.test(body) ||
    /\breact-scripts\s+start\b/.test(body) ||
    /\bvue-cli-service\s+serve\b/.test(body) ||
    /\bparcel\b(?!\s+build)/.test(body)
  ) {
    return true;
  }
  return undefined;
}

/**
 * A static file server must be the command itself, not an argument: `serve`
 * in `vue-cli-service serve` or `webpack serve` names a dev-server mode.
 */
function isStaticFileServerBody(body: string): boolean {
  return body.split(/&&|\|\||[;|]/).some((segment) => {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
    const command =
      tokens[0] === "npx" || tokens[0] === "bunx" ? tokens[1] : tokens[0];
    return ["http-server", "serve", "sirv"].includes(command ?? "");
  });
}

/** Maps a module specifier to its package name; relative paths map to none. */
export function readPackageName(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined
      ? `${scope}/${name}`
      : undefined;
  }
  const [name] = specifier.split("/");
  return name?.length === 0 || specifier.startsWith(".") ? undefined : name;
}

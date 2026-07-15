import { posix } from "node:path";
import type { PackageManager, RepoProfile } from "../schemas/artifacts";

type RepoProfileFile = {
  path: string;
  text?: string;
};

type PackageRecord = {
  dependencies: Record<string, string>;
  dir: string;
  json: Record<string, unknown>;
  name?: string;
  packageManagerDeclaration?: PackageManager;
  scripts: Record<string, string>;
};

export type RepoProfileInput = {
  commitSha?: string;
  files: RepoProfileFile[];
  quarantinedEnvironmentKeys?: string[];
  repoUrl: string;
  rootDir?: string;
};

const lockfileManagers: Array<[string, RepoProfile["packageManager"]]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const frameworkPackages = [
  ["@remix-run/react", "remix"],
  ["astro", "astro"],
  ["next", "next"],
  ["react", "react"],
  ["svelte", "svelte"],
  ["vite", "vite"],
  ["vue", "vue"],
] as const;

const authPackagePattern = /clerk|auth|oauth/i;
const externalServicePackages = [
  "airtable",
  "firebase",
  "openai",
  "resend",
  "sendgrid",
  "stripe",
  "supabase",
];

export function profileRepo(input: RepoProfileInput): RepoProfile {
  const files = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  const paths = new Set(files.map((file) => file.path));
  const packages = readPackages(files);
  const rootPackage = packages.find(({ dir }) => dir === ".");
  const workspacePatterns = [
    ...readWorkspacePatterns(rootPackage?.json.workspaces),
    ...readPnpmWorkspacePatterns(files),
  ].filter((pattern, index, patterns) => patterns.indexOf(pattern) === index);
  const lockfiles = [...paths]
    .filter((path) => lockfileManager(path) !== undefined)
    .sort();
  const primaryPackage = selectPrimaryPackage(packages);
  const packageManager =
    primaryPackage === undefined
      ? "unknown"
      : resolvePackageManager(primaryPackage, lockfiles, workspacePatterns);
  const packageJson = primaryPackage?.json;
  const packageScripts = primaryPackage?.scripts ?? {};
  const dependencies = Object.assign(
    {},
    ...packages.map((entry) => entry.dependencies),
  );
  const workspacePackages = readWorkspacePackages(
    files,
    packages,
    lockfiles,
    workspacePatterns,
  );
  const candidatePorts = readCandidatePorts(packageScripts);
  const envExamples = files
    .filter((file) => /^\.env(?:\..+)?$/.test(posix.basename(file.path)))
    .map((file) => file.path);

  return {
    authHints: Object.keys(dependencies).filter((name) =>
      authPackagePattern.test(name),
    ),
    candidateAppDirs: readCandidateAppDirs(files),
    candidateBuildCommands: readScriptCommands(packageManager, packageScripts, [
      "build",
    ]),
    candidateInstallCommands: [createInstallCommand(packageManager)].filter(
      (command) => command.length > 0,
    ),
    candidatePorts,
    candidateStartCommands: readScriptCommands(packageManager, packageScripts, [
      "dev",
      "start",
      "preview",
    ]),
    ...optionalString("commitSha", input.commitSha),
    confidence: {
      assumptions: createAssumptions(
        packageManager,
        dependencies,
        packageScripts,
      ),
      overall: calculateConfidence(packageJson, paths, packageScripts),
    },
    detectedFrameworks: detectFrameworks(dependencies),
    dockerHints: files
      .filter(
        (file) =>
          file.path === "Dockerfile" || file.path.endsWith("/Dockerfile"),
      )
      .map((file) => file.path),
    envExamples,
    externalServiceHints: Object.keys(dependencies).filter((name) =>
      externalServicePackages.includes(name.toLowerCase()),
    ),
    lockfiles,
    packageManager,
    packageScripts,
    repoUrl: input.repoUrl,
    requiredEnvHints: [
      ...new Set([
        ...readEnvKeys(files),
        ...(input.quarantinedEnvironmentKeys ?? []).filter((key) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
        ),
      ]),
    ].sort(),
    rootDir: input.rootDir ?? "/workspace",
    securityWarnings: packages.flatMap((entry) =>
      entry.scripts.postinstall === undefined
        ? []
        : [
            entry.dir === "."
              ? "package script postinstall runs during install"
              : `package script postinstall in ${entry.dir}/package.json runs during install`,
          ],
    ),
    unsupportedReasons:
      packages.length === 0
        ? ["package.json is required for JavaScript/TypeScript repos"]
        : [],
    workspaces: {
      isMonorepo: workspacePatterns.length > 0,
      packageDirectories: workspacePatterns,
    },
    workspacePackages,
  };
}

function readWorkspacePackages(
  files: RepoProfileFile[],
  packages: PackageRecord[],
  lockfiles: string[],
  workspacePatterns: string[],
) {
  const nestedPackages = packages.flatMap((packageRecord) => {
    if (packageRecord.dir === ".") return [];
    const scripts = packageRecord.scripts;
    const runtimeScripts = Object.fromEntries(
      Object.entries(scripts).filter(([name]) =>
        ["build", "dev", "preview", "start"].includes(name),
      ),
    );
    const isWorkspace = matchesWorkspacePatterns(
      packageRecord.dir,
      workspacePatterns,
    );
    return [
      {
        declaredDependencies: Object.keys(packageRecord.dependencies),
        dir: packageRecord.dir,
        installDir: isWorkspace ? "." : packageRecord.dir,
        isWorkspace,
        ...(packageRecord.name === undefined
          ? {}
          : { name: packageRecord.name }),
        packageManager: resolvePackageManager(
          packageRecord,
          lockfiles,
          workspacePatterns,
        ),
        ports: readCandidatePorts(runtimeScripts),
        scripts: runtimeScripts,
      },
    ];
  });
  const workspaceNames = new Set(
    nestedPackages
      .map(({ name }) => name)
      .filter((name): name is string => name !== undefined),
  );
  return nestedPackages.map(({ declaredDependencies, ...workspacePackage }) => {
    const observedDependencies = files
      .filter(
        ({ path, text }) =>
          text !== undefined &&
          path.startsWith(`${workspacePackage.dir}/`) &&
          isSourceModulePath(path),
      )
      .flatMap(({ text }) => readModuleSpecifiers(text ?? ""));
    const workspaceDependencies = [
      ...new Set([...declaredDependencies, ...observedDependencies]),
    ]
      .map(readPackageName)
      .filter(
        (name): name is string =>
          name !== undefined &&
          name !== workspacePackage.name &&
          workspaceNames.has(name),
      )
      .sort();
    return {
      ...workspacePackage,
      ...(workspaceDependencies.length === 0 ? {} : { workspaceDependencies }),
    };
  });
}

function isSourceModulePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|astro|svelte|vue)$/.test(path);
}

function readModuleSpecifiers(source: string): string[] {
  return [
    /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\sfrom\s*["'`]([^"'`\r\n]+)["'`]/g,
    /\bimport\s*["'`]([^"'`\r\n]+)["'`]/g,
    /\b(?:import|require)\s*\(\s*["'`]([^"'`\r\n]+)["'`]\s*\)/g,
  ].flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
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

function readPackages(files: RepoProfileFile[]): PackageRecord[] {
  return files.flatMap((file) => {
    if (file.path !== "package.json" && !file.path.endsWith("/package.json")) {
      return [];
    }
    const json = readJsonObject(file.text);
    if (json === undefined) return [];
    const dir = file.path === "package.json" ? "." : posix.dirname(file.path);
    const name =
      typeof json.name === "string" && json.name.trim().length > 0
        ? json.name
        : undefined;
    return [
      {
        dependencies: {
          ...readDependencyRecord(json.dependencies),
          ...readDependencyRecord(json.devDependencies),
          ...readDependencyRecord(json.optionalDependencies),
          ...readDependencyRecord(json.peerDependencies),
        },
        dir,
        json,
        ...(name === undefined ? {} : { name }),
        ...readPackageManagerDeclaration(json.packageManager),
        scripts: readScripts(json.scripts),
      },
    ];
  });
}

function selectPrimaryPackage(
  packages: PackageRecord[],
): PackageRecord | undefined {
  const hasRuntimeScript = ({ scripts }: PackageRecord) =>
    ["dev", "start", "preview"].some((name) => scripts[name] !== undefined);
  return (
    packages.find((entry) => entry.dir === "." && hasRuntimeScript(entry)) ??
    packages.find(hasRuntimeScript) ??
    packages.find(({ dir }) => dir === ".") ??
    packages[0]
  );
}

function resolvePackageManager(
  packageRecord: PackageRecord,
  lockfiles: string[],
  workspacePatterns: string[],
): PackageManager {
  const installDir = matchesWorkspacePatterns(
    packageRecord.dir,
    workspacePatterns,
  )
    ? "."
    : packageRecord.dir;
  const ownedLockfile = lockfiles.find(
    (lockfile) => posix.dirname(lockfile) === installDir,
  );
  return (
    (ownedLockfile === undefined
      ? undefined
      : lockfileManager(ownedLockfile)) ??
    packageRecord.packageManagerDeclaration ??
    "npm"
  );
}

function lockfileManager(path: string): PackageManager | undefined {
  const filename = posix.basename(path);
  return lockfileManagers.find(([lockfile]) => lockfile === filename)?.[1];
}

function readPackageManagerDeclaration(
  value: unknown,
): Pick<PackageRecord, "packageManagerDeclaration"> {
  if (typeof value !== "string") return {};
  const name = /^([a-z]+)@/i.exec(value)?.[1]?.toLowerCase();
  return ["bun", "npm", "pnpm", "yarn"].includes(name ?? "")
    ? { packageManagerDeclaration: name as PackageManager }
    : {};
}

function readPnpmWorkspacePatterns(files: RepoProfileFile[]): string[] {
  const text = files.find(({ path }) => path === "pnpm-workspace.yaml")?.text;
  if (text === undefined) return [];
  const packagesBlock =
    /(?:^|\n)packages\s*:\s*\n((?:[ \t]+-[^\n]*(?:\n|$))+)/.exec(text)?.[1];
  if (packagesBlock === undefined) return [];
  return [
    ...packagesBlock.matchAll(
      /^[ \t]+-[ \t]+["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter((pattern): pattern is string =>
      pattern === undefined ? false : pattern.length > 0,
    );
}

function matchesWorkspacePatterns(dir: string, patterns: string[]): boolean {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = (excluded ? rawPattern.slice(1) : rawPattern).replace(
      /^\.\//,
      "",
    );
    if (globMatches(pattern, dir)) included = !excluded;
  }
  return included;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escaped
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function createInstallCommand(packageManager: RepoProfile["packageManager"]) {
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
      return "";
  }
}

function readScriptCommands(
  packageManager: RepoProfile["packageManager"],
  scripts: Record<string, string>,
  names: string[],
): string[] {
  if (packageManager === "unknown") {
    return [];
  }

  return names
    .filter((name) => scripts[name] !== undefined)
    .map((name) =>
      createScriptCommand(packageManager, name, scripts[name] ?? ""),
    );
}

function createScriptCommand(
  packageManager: Exclude<RepoProfile["packageManager"], "unknown">,
  name: string,
  script: string,
): string {
  const port = readScriptPort(script);
  if (packageManager === "npm") {
    return `npm run ${name}${port === undefined ? "" : ` -- --port ${port}`}`;
  }
  return `${packageManager} ${name}${port === undefined ? "" : ` --port ${port}`}`;
}

function readScriptPort(script: string): string | undefined {
  const match = /(?:--port|-p)\s+(\d{2,5})/.exec(script);
  return match?.[1];
}

function readCandidatePorts(scripts: Record<string, string>): number[] {
  const ports = new Set<number>();
  for (const script of Object.values(scripts)) {
    for (const pattern of [
      /(?:--port|-p)\s+(\d{2,5})/g,
      /localhost:(\d{2,5})/g,
      /127\.0\.0\.1:(\d{2,5})/g,
    ]) {
      for (const match of script.matchAll(pattern)) {
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) {
          ports.add(port);
        }
      }
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function readCandidateAppDirs(files: RepoProfileFile[]): string[] {
  const dirs = new Set<string>();
  if (files.some((file) => file.path === "package.json")) {
    dirs.add(".");
  }
  for (const file of files) {
    if (file.path !== "package.json" && file.path.endsWith("/package.json")) {
      dirs.add(file.path.slice(0, -"/package.json".length));
    }
  }
  return [...dirs];
}

function readEnvKeys(files: RepoProfileFile[]): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (!/^\.env(?:\..+)?$/.test(posix.basename(file.path))) {
      continue;
    }
    for (const line of (file.text ?? "").split("\n")) {
      const match = /^([A-Z0-9_]+)\s*=/.exec(line.trim());
      if (match?.[1] !== undefined) {
        keys.add(match[1]);
      }
    }
  }
  return [...keys].sort();
}

function detectFrameworks(dependencies: Record<string, string>): string[] {
  const names = new Set(Object.keys(dependencies));
  return frameworkPackages
    .filter(([packageName]) => names.has(packageName))
    .map(([, framework]) => framework);
}

function readScripts(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function readDependencyRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      typeof entryValue === "string" ? entryValue : "",
    ]),
  );
}

function readWorkspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const packages = (value as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      return packages.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  }

  return [];
}

function createAssumptions(
  packageManager: RepoProfile["packageManager"],
  dependencies: Record<string, string>,
  scripts: Record<string, string>,
): string[] {
  const assumptions: string[] = [];
  if (packageManager !== "unknown") {
    assumptions.push(`${packageManager} is the package manager`);
  }
  if (Object.keys(dependencies).length > 0) {
    assumptions.push("package dependencies describe the web app stack");
  }
  if (scripts.dev !== undefined || scripts.start !== undefined) {
    assumptions.push("package scripts expose a local app start command");
  }
  return assumptions;
}

function calculateConfidence(
  packageJson: Record<string, unknown> | undefined,
  paths: Set<string>,
  scripts: Record<string, string>,
): number {
  let score = 0.25;
  if (packageJson !== undefined) {
    score += 0.25;
  }
  if (
    [...paths].some((path) =>
      lockfileManagers.some(
        ([lockfile]) => path === lockfile || path.endsWith(`/${lockfile}`),
      ),
    )
  ) {
    score += 0.2;
  }
  if (scripts.dev !== undefined || scripts.start !== undefined) {
    score += 0.2;
  }
  if (scripts.build !== undefined) {
    score += 0.1;
  }
  return Math.min(1, Number(score.toFixed(2)));
}

function readJsonObject(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value.trim().length === 0
    ? {}
    : ({ [key]: value } as Partial<Record<K, string>>);
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

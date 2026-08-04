import { posix } from "node:path";
import {
  isEnvironmentFileName,
  normalizeRepoPath,
  readEnvironmentAssignmentKeys,
} from "../repo-security/secret-predicates";
import {
  createInstallCommand,
  createRunScriptCommand,
  readCandidatePorts,
  readPackageName,
  readScriptPort,
} from "../run-planner/package-commands";
import {
  type PackageManager,
  type RepoProfile,
  browserRuntimeScriptNames,
} from "../schemas/artifacts";

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
  ["@angular/core", "angular"],
  ["@builder.io/qwik", "qwik"],
  ["@remix-run/react", "remix"],
  ["@sveltejs/kit", "svelte"],
  ["astro", "astro"],
  ["gatsby", "gatsby"],
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["preact", "preact"],
  ["react", "react"],
  ["solid-js", "solid"],
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
    path: normalizeRepoPath(file.path),
  }));
  const paths = new Set(files.map((file) => file.path));
  const packages = readPackages(files);
  const rootPackage = packages.find(({ dir }) => dir === ".");
  const workspacePatterns = [
    ...readWorkspacePatterns(rootPackage?.json.workspaces),
    ...readPnpmWorkspacePatterns(files),
    ...readLernaWorkspacePatterns(files),
  ].filter((pattern, index, patterns) => patterns.indexOf(pattern) === index);
  const lockfiles = [...paths]
    .filter((path) => lockfileManager(path) !== undefined)
    .sort();
  const primaryPackage = selectPrimaryPackage(packages);
  const packageManagerDecision =
    primaryPackage === undefined
      ? undefined
      : decidePackageManager(
          primaryPackage,
          packages,
          lockfiles,
          workspacePatterns,
        );
  const packageManager = packageManagerDecision?.packageManager ?? "unknown";
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
  const browserRuntimeCandidates = readBrowserRuntimeCandidates(
    files,
    packages,
    workspacePackages,
    packageManager,
  );
  const candidatePorts = readCandidatePorts(packageScripts);
  const envExamples = files
    .filter((file) => isEnvironmentFileName(file.path))
    .map((file) => file.path);

  return {
    authHints: Object.keys(dependencies).filter((name) =>
      authPackagePattern.test(name),
    ),
    browserRuntimeCandidates,
    candidateAppDirs: readCandidateAppDirs(files),
    candidateBuildCommands: readScriptCommands(packageManager, packageScripts, [
      "build",
    ]),
    candidateInstallCommands:
      packageManager === "unknown"
        ? []
        : [createInstallCommand(packageManager)],
    candidatePorts,
    candidateStartCommands: readScriptCommands(packageManager, packageScripts, [
      ...browserRuntimeScriptNames,
    ]),
    ...optionalString("commitSha", input.commitSha),
    confidence: {
      assumptions: [
        ...createAssumptions(packageManager, dependencies, packageScripts),
        ...(packageManagerDecision?.conflict === undefined
          ? []
          : [packageManagerDecision.conflict]),
      ],
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
    ...optionalString(
      "rootPackageName",
      typeof rootPackage?.json.name === "string" &&
        rootPackage.json.name.trim().length > 0
        ? rootPackage.json.name
        : undefined,
    ),
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

function readBrowserRuntimeCandidates(
  files: RepoProfileFile[],
  packages: PackageRecord[],
  workspacePackages: NonNullable<RepoProfile["workspacePackages"]>,
  rootPackageManager: PackageManager,
): NonNullable<RepoProfile["browserRuntimeCandidates"]> {
  const workspacePackagesByDir = new Map(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.dir,
      workspacePackage,
    ]),
  );
  return packages.flatMap((packageRecord) => {
    if (
      !browserRuntimeScriptNames.some(
        (script) => packageRecord.scripts[script] !== undefined,
      )
    ) {
      return [];
    }
    const workspacePackage = workspacePackagesByDir.get(packageRecord.dir);
    const packagePath =
      packageRecord.dir === "."
        ? "package.json"
        : `${packageRecord.dir}/package.json`;
    const browserEvidencePaths = files
      .map(({ path }) => path)
      .filter(
        (path) =>
          path !== packagePath &&
          isOwnedByPackage(path, packageRecord.dir, packages) &&
          (isBrowserRuntimeEvidencePath(path) ||
            isStrongCustomBrowserEvidencePath(path)),
      )
      .sort();
    if (browserEvidencePaths.length === 0) return [];
    const evidencePaths = [packagePath, ...browserEvidencePaths].slice(0, 16);
    const detectedFrameworks = detectBrowserFrameworks(packageRecord);
    if (
      detectedFrameworks.length === 0 &&
      !browserEvidencePaths.some(isStrongCustomBrowserEvidencePath)
    ) {
      return [];
    }
    const frameworks =
      detectedFrameworks.length === 0 ? ["custom-web"] : detectedFrameworks;
    return [
      {
        dir: packageRecord.dir,
        evidencePaths,
        frameworks,
        ...(workspacePackage?.installDir === undefined
          ? { installDir: packageRecord.dir }
          : { installDir: workspacePackage.installDir }),
        isWorkspace: workspacePackage?.isWorkspace ?? false,
        ...(packageRecord.name === undefined
          ? {}
          : { name: packageRecord.name }),
        packageManager: workspacePackage?.packageManager ?? rootPackageManager,
        ports: readCandidatePorts(packageRecord.scripts),
        scripts: Object.fromEntries(
          Object.entries(packageRecord.scripts).filter(([name]) =>
            isRuntimePackageScript(name),
          ),
        ),
        ...(workspacePackage?.workspaceDependencies === undefined
          ? {}
          : {
              workspaceDependencies: workspacePackage.workspaceDependencies,
            }),
      },
    ];
  });
}

function detectBrowserFrameworks(packageRecord: PackageRecord): string[] {
  const frameworks = new Set(detectFrameworks(packageRecord.dependencies));
  const scripts = Object.values(packageRecord.scripts).join("\n");
  for (const [pattern, framework] of [
    [/\bng\s+(?:build|serve)\b/, "angular"],
    [/\bastro\b/, "astro"],
    [/\bgatsby\b/, "gatsby"],
    [/\bnext\b/, "next"],
    [/\bnuxt\b/, "nuxt"],
    [/\b(?:parcel|webpack(?:-dev-server)?)\b/, "web-bundler"],
    [/\bqwik\b/, "qwik"],
    [/\breact-scripts\b/, "react"],
    [/\bremix\b/, "remix"],
    [/\bsvelte-kit\b/, "svelte"],
    [/\bvite\b/, "vite"],
    [/\bvue-cli-service\b/, "vue"],
  ] as const) {
    if (pattern.test(scripts)) frameworks.add(framework);
  }
  return [...frameworks];
}

function isOwnedByPackage(
  path: string,
  directory: string,
  packages: PackageRecord[],
): boolean {
  if (
    directory !== "." &&
    path !== directory &&
    !path.startsWith(`${directory}/`)
  ) {
    return false;
  }
  return !packages.some(
    ({ dir }) =>
      dir !== "." &&
      dir !== directory &&
      (directory === "." || dir.startsWith(`${directory}/`)) &&
      (path === dir || path.startsWith(`${dir}/`)),
  );
}

function isBrowserRuntimeEvidencePath(path: string): boolean {
  return (
    /(?:^|\/)(?:app|pages|routes|screens|src|views)\/.*\.(?:html|js|jsx|mjs|mts|svelte|ts|tsx|vue)$/i.test(
      path,
    ) ||
    /(?:^|\/)(?:index\.html|astro\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|svelte\.config\.[cm]?[jt]s)$/i.test(
      path,
    )
  );
}

function isStrongCustomBrowserEvidencePath(path: string): boolean {
  return (
    /\.(?:html|jsx|tsx|svelte|vue)$/i.test(path) ||
    /(?:^|\/)(?:app|client|pages|routes|screens|views)\/.*\.[cm]?[jt]s$/i.test(
      path,
    ) ||
    /\.(?:component|page|view)\.[cm]?[jt]s$/i.test(path)
  );
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
      Object.entries(scripts).filter(([name]) => isRuntimePackageScript(name)),
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
        packageManager: decidePackageManager(
          packageRecord,
          packages,
          lockfiles,
          workspacePatterns,
        ).packageManager,
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

function isRuntimePackageScript(name: string): boolean {
  return (
    name === "build" ||
    (browserRuntimeScriptNames as readonly string[]).includes(name)
  );
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
    browserRuntimeScriptNames.some((name) => scripts[name] !== undefined);
  return (
    packages.find((entry) => entry.dir === "." && hasRuntimeScript(entry)) ??
    packages.find(hasRuntimeScript) ??
    packages.find(({ dir }) => dir === ".") ??
    packages[0]
  );
}

const lockfileManagerPreference: PackageManager[] = [
  "bun",
  "pnpm",
  "yarn",
  "npm",
];

type PackageManagerDecision = {
  /** Present when conflicting lockfiles forced a preference tiebreak. */
  conflict?: string;
  packageManager: PackageManager;
};

/**
 * Precedence: the package's own `packageManager` declaration, a single owned
 * lockfile, the nearest ancestor declaration, then a preference tiebreak among
 * conflicting lockfiles — recorded as an assumption, never chosen silently.
 */
function decidePackageManager(
  packageRecord: PackageRecord,
  packages: PackageRecord[],
  lockfiles: string[],
  workspacePatterns: string[],
): PackageManagerDecision {
  if (packageRecord.packageManagerDeclaration !== undefined) {
    return { packageManager: packageRecord.packageManagerDeclaration };
  }
  const installDir = matchesWorkspacePatterns(
    packageRecord.dir,
    workspacePatterns,
  )
    ? "."
    : packageRecord.dir;
  const ownedLockfiles = lockfiles.filter(
    (lockfile) => posix.dirname(lockfile) === installDir,
  );
  const ownedManagers = [
    ...new Set(
      ownedLockfiles
        .map(lockfileManager)
        .filter((manager): manager is PackageManager => manager !== undefined),
    ),
  ];
  if (ownedManagers.length === 1 && ownedManagers[0] !== undefined) {
    return { packageManager: ownedManagers[0] };
  }
  const ancestorDeclaration = findAncestorPackageManagerDeclaration(
    packageRecord.dir,
    packages,
  );
  if (ancestorDeclaration !== undefined) {
    return { packageManager: ancestorDeclaration };
  }
  const tiebreak = lockfileManagerPreference.find((manager) =>
    ownedManagers.includes(manager),
  );
  if (tiebreak !== undefined) {
    return {
      conflict: `conflicting lockfiles (${ownedLockfiles
        .map((lockfile) => posix.basename(lockfile))
        .sort()
        .join(", ")}) resolved to ${tiebreak} by manager preference`,
      packageManager: tiebreak,
    };
  }
  return { packageManager: "npm" };
}

function findAncestorPackageManagerDeclaration(
  dir: string,
  packages: PackageRecord[],
): PackageManager | undefined {
  let current = dir;
  while (current !== ".") {
    current = posix.dirname(current);
    const declaration = packages.find(
      (packageRecord) => packageRecord.dir === current,
    )?.packageManagerDeclaration;
    if (declaration !== undefined) {
      return declaration;
    }
  }
  return undefined;
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
    /(?:^|\n)packages\s*:\s*\n((?:[ \t]*-[^\n]*(?:\n|$))+)/.exec(text)?.[1];
  if (packagesBlock === undefined) return [];
  return [
    ...packagesBlock.matchAll(
      /^[ \t]*-[ \t]+["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter((pattern): pattern is string =>
      pattern === undefined ? false : pattern.length > 0,
    );
}

function readLernaWorkspacePatterns(files: RepoProfileFile[]): string[] {
  const json = readJsonObject(
    files.find(({ path }) => path === "lerna.json")?.text,
  );
  const packages = json?.packages;
  return Array.isArray(packages)
    ? packages.filter((entry): entry is string => typeof entry === "string")
    : [];
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
  const escaped = pattern.replace(/[.+^$()|[\]\\]/g, "\\$&");
  const expression = escaped
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*")
    .replace(
      /\{([^{}]*)\}/g,
      (_, body: string) => `(?:${body.split(",").join("|")})`,
    );
  return new RegExp(`^${expression}$`).test(value);
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
  const command = createRunScriptCommand(packageManager, name);
  if (port === undefined) {
    return command;
  }
  return packageManager === "npm"
    ? `${command} -- --port ${port}`
    : `${command} --port ${port}`;
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
    if (!isEnvironmentFileName(file.path)) {
      continue;
    }
    for (const key of readEnvironmentAssignmentKeys(file.text)) {
      keys.add(key);
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

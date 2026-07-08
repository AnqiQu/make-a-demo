import type { RepoProfile } from "../schemas/artifacts";

type RepoProfileFile = {
  path: string;
  text?: string;
};

export type RepoProfileInput = {
  commitSha?: string;
  files: RepoProfileFile[];
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
  const packageManager = detectPackageManager(paths);
  const packageJson = readJsonObject(
    files.find((file) => file.path === "package.json")?.text,
  );
  const packageScripts = readScripts(packageJson?.scripts);
  const dependencies = {
    ...readDependencyRecord(packageJson?.dependencies),
    ...readDependencyRecord(packageJson?.devDependencies),
  };
  const workspacePatterns = readWorkspacePatterns(packageJson?.workspaces);
  const candidatePorts = readCandidatePorts(packageScripts);
  const envExamples = files
    .filter((file) => /^\.env(?:\..+)?$/.test(file.path))
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
    lockfiles: [...paths].filter((path) =>
      lockfileManagers.some(([lockfile]) => lockfile === path),
    ),
    packageManager,
    packageScripts,
    repoUrl: input.repoUrl,
    requiredEnvHints: readEnvKeys(files),
    rootDir: input.rootDir ?? "/workspace",
    securityWarnings:
      packageScripts.postinstall === undefined
        ? []
        : ["package script postinstall runs during install"],
    unsupportedReasons:
      packageJson === undefined
        ? ["package.json is required for JavaScript/TypeScript repos"]
        : [],
    workspaces: {
      isMonorepo: workspacePatterns.length > 0,
      packageDirectories: workspacePatterns,
    },
  };
}

function detectPackageManager(
  paths: Set<string>,
): RepoProfile["packageManager"] {
  for (const [lockfile, packageManager] of lockfileManagers) {
    if (paths.has(lockfile)) {
      return packageManager;
    }
  }
  return paths.has("package.json") ? "npm" : "unknown";
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
    .map(
      (name) =>
        `${packageManager} ${name}${readPortSuffix(scripts[name] ?? "")}`,
    );
}

function readPortSuffix(script: string): string {
  const match = /(?:--port|-p)\s+(\d{2,5})/.exec(script);
  return match?.[1] === undefined ? "" : ` --port ${match[1]}`;
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
    if (!/^\.env(?:\..+)?$/.test(file.path)) {
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
    [...paths].some((path) => lockfileManagers.some(([lock]) => lock === path))
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

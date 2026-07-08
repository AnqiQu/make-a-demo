type StaticRepoSecurityFile = {
  path: string;
  text?: string;
};

export type StaticRepoSecurityInput = {
  files: StaticRepoSecurityFile[];
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
};

export type StaticRepoSecurityResult = {
  rejections: string[];
  status: "passed" | "rejected";
  warnings: string[];
};

const LARGE_REPO_FILE_COUNT = 20_000;
const LARGE_REPO_SIZE_BYTES = 500_000_000;
const lockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const secretFileNames = new Set(["id_ed25519", "id_rsa"]);
const safeEnvFileSuffixes = new Set(["example", "sample", "template"]);
const externalServicePackages = [
  "airtable",
  "aws-sdk",
  "firebase",
  "openai",
  "resend",
  "sendgrid",
  "stripe",
  "supabase",
];

export function screenStaticRepoSecurity(
  input: StaticRepoSecurityInput,
): StaticRepoSecurityResult {
  const files = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  const paths = new Set(files.map((file) => file.path));
  const rejections: string[] = [];
  const warnings: string[] = [];

  if (!paths.has("package.json")) {
    rejections.push("package.json is required for JavaScript/TypeScript repos");
  }

  for (const file of files) {
    inspectFileSecurity(file, rejections, warnings);
  }

  const packageJson = files.find((file) => file.path === "package.json");
  if (packageJson?.text !== undefined) {
    inspectPackageJson(packageJson.text, rejections, warnings);
  }

  if (![...paths].some((path) => lockfiles.has(path))) {
    warnings.push(
      "repo has no lockfile; dependency installation may be less deterministic",
    );
  }

  if (
    input.repoStats.fileCount > LARGE_REPO_FILE_COUNT ||
    input.repoStats.sizeBytes > LARGE_REPO_SIZE_BYTES
  ) {
    warnings.push(
      "repo size or file count may degrade agent exploration quality",
    );
  }

  return {
    rejections,
    status: rejections.length === 0 ? "passed" : "rejected",
    warnings,
  };
}

function inspectFileSecurity(
  file: StaticRepoSecurityFile,
  rejections: string[],
  warnings: string[],
): void {
  const filename = file.path.split("/").at(-1) ?? file.path;
  if (isCommittedSecretFile(filename)) {
    rejections.push(`repo contains committed secret file ${file.path}`);
  }

  if (isPrivateKeyPath(filename) || isPrivateKeyText(file.text)) {
    rejections.push(`repo contains private key material in ${file.path}`);
  }

  if (
    /^Dockerfile$|\/Dockerfile$/.test(file.path) &&
    /sudo|--privileged/.test(file.text ?? "")
  ) {
    warnings.push("Dockerfile requests privileged operations");
  }
}

function isCommittedSecretFile(filename: string): boolean {
  if (!filename.startsWith(".env")) {
    return false;
  }

  const suffix = filename.slice(".env.".length);
  return !safeEnvFileSuffixes.has(suffix);
}

function isPrivateKeyPath(filename: string): boolean {
  return secretFileNames.has(filename);
}

function isPrivateKeyText(text: string | undefined): boolean {
  return /-----BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----/.test(
    text ?? "",
  );
}

function inspectPackageJson(
  text: string,
  rejections: string[],
  warnings: string[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejections.push("package.json must be valid JSON");
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    rejections.push("package.json must be an object");
    return;
  }

  const packageRecord = parsed as Record<string, unknown>;
  inspectScripts(packageRecord.scripts, rejections, warnings);
  inspectDependencies(packageRecord.dependencies, warnings);
  inspectDependencies(packageRecord.devDependencies, warnings);
}

function inspectScripts(
  scripts: unknown,
  rejections: string[],
  warnings: string[],
): void {
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    return;
  }

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }

    if (
      /rm\s+-rf\s+\//.test(command) ||
      /mkfs|forkbomb|crypto.?miner/i.test(command)
    ) {
      rejections.push(`package script ${name} contains a destructive command`);
    }

    if (name === "postinstall") {
      warnings.push(
        "package script postinstall may run setup code during dependency installation",
      );
    }
  }
}

function inspectDependencies(dependencies: unknown, warnings: string[]): void {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    return;
  }

  for (const name of Object.keys(dependencies)) {
    if (/clerk|auth|oauth/i.test(name)) {
      warnings.push(
        `auth package ${name} may require local demo bypass or mocks`,
      );
    }

    if (externalServicePackages.includes(name.toLowerCase())) {
      warnings.push(`external service package ${name} may require local mocks`);
    }
  }
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

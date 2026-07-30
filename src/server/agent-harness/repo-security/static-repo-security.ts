import { posix } from "node:path";
import {
  containsPrivateKeyMaterial,
  isEnvironmentSecretFileName,
  isPrivateKeyFileName,
} from "./secret-predicates";
import type { SecretQuarantineManifest } from "./secret-quarantine";

type StaticRepoSecurityFile = {
  path: string;
  symlinkTarget?: string;
  text?: string;
};

export type StaticRepoSecurityInput = {
  files: StaticRepoSecurityFile[];
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
  secretQuarantineManifest?: SecretQuarantineManifest;
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
  const quarantinedPaths = new Set(
    input.secretQuarantineManifest?.entries.map((entry) =>
      normalizePath(entry.path),
    ) ?? [],
  );
  const rejections: string[] = [];
  const warnings: string[] = [];

  const packageJsonFiles = files.filter(
    (file) =>
      file.path === "package.json" || file.path.endsWith("/package.json"),
  );
  if (packageJsonFiles.length === 0) {
    rejections.push("package.json is required for JavaScript/TypeScript repos");
  }

  for (const file of files) {
    inspectFileSecurity(file, quarantinedPaths, rejections, warnings);
  }

  for (const packageJson of packageJsonFiles) {
    if (packageJson.text !== undefined) {
      inspectPackageJson(
        packageJson.path,
        packageJson.text,
        rejections,
        warnings,
      );
    }
  }

  if (
    ![...paths].some((path) => lockfiles.has(path.split("/").at(-1) ?? path))
  ) {
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
  quarantinedPaths: ReadonlySet<string>,
  rejections: string[],
  warnings: string[],
): void {
  const filename = file.path.split("/").at(-1) ?? file.path;
  if (
    file.symlinkTarget !== undefined &&
    symlinkEscapesRepo(file.path, file.symlinkTarget)
  ) {
    rejections.push(`repo symlink ${file.path} escapes the repository`);
  }
  const containsSecretMaterial =
    isCommittedSecretFile(filename) ||
    isPrivateKeyPath(filename) ||
    containsPrivateKeyMaterial(file.text);
  if (containsSecretMaterial) {
    if (quarantinedPaths.has(file.path)) {
      warnings.push(
        `repo secret file ${file.path} was quarantined before agent or runtime execution`,
      );
    } else if (isCommittedSecretFile(filename)) {
      rejections.push(`repo contains committed secret file ${file.path}`);
    } else {
      rejections.push(`repo contains private key material in ${file.path}`);
    }
  }

  if (
    /^Dockerfile$|\/Dockerfile$/.test(file.path) &&
    /sudo|--privileged/.test(file.text ?? "")
  ) {
    warnings.push("Dockerfile requests privileged operations");
  }
}

function symlinkEscapesRepo(path: string, target: string): boolean {
  if (posix.isAbsolute(target)) return true;
  const resolvedTarget = posix.normalize(
    posix.join(posix.dirname(path), target),
  );
  return resolvedTarget === ".." || resolvedTarget.startsWith("../");
}

function isCommittedSecretFile(filename: string): boolean {
  return isEnvironmentSecretFileName(filename);
}

function isPrivateKeyPath(filename: string): boolean {
  return isPrivateKeyFileName(filename);
}

function inspectPackageJson(
  path: string,
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
  inspectScripts(path, packageRecord.scripts, rejections, warnings);
  inspectDependencies(packageRecord.dependencies, warnings);
  inspectDependencies(packageRecord.devDependencies, warnings);
}

function inspectScripts(
  packageJsonPath: string,
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
      const location =
        packageJsonPath === "package.json" ? "" : ` in ${packageJsonPath}`;
      rejections.push(
        `package script ${name}${location} contains a destructive command`,
      );
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

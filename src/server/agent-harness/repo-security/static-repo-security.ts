import { posix } from "node:path";
import {
  containsPrivateKeyMaterial,
  isCredentialRegistryConfig,
  isEnvironmentSecretFileName,
  isPrivateKeyFileName,
  looksLikeEnvironmentAssignments,
  normalizeRepoPath,
} from "./secret-predicates";
import type { SecretQuarantineManifest } from "./secret-quarantine";

type StaticRepoSecurityFile = {
  path: string;
  /** False when the snapshot could not read the file for text screening. */
  scanned?: boolean;
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
    path: normalizeRepoPath(file.path),
  }));
  const paths = new Set(files.map((file) => file.path));
  const quarantinedPaths = new Set(
    input.secretQuarantineManifest?.entries.map((entry) =>
      normalizeRepoPath(entry.path),
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

  const symlinkTargets = new Map(
    files.flatMap((file) =>
      file.symlinkTarget === undefined
        ? []
        : [[file.path, file.symlinkTarget] as const],
    ),
  );
  for (const file of files) {
    inspectFileSecurity(
      file,
      quarantinedPaths,
      symlinkTargets,
      rejections,
      warnings,
    );
  }

  for (const packageJson of packageJsonFiles) {
    if (packageJson.text !== undefined) {
      inspectPackageJson(
        packageJson.path,
        packageJson.text,
        rejections,
        warnings,
      );
    } else if (packageJson.scanned === false) {
      rejections.push(
        `${packageJson.path} is too large to screen for destructive scripts`,
      );
    }
  }

  for (const file of files) {
    if (file.scanned === false && !file.path.endsWith("package.json")) {
      warnings.push(
        `repo file ${file.path} was not content-screened for secrets (file size or repo scan budget)`,
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
  symlinkTargets: ReadonlyMap<string, string>,
  rejections: string[],
  warnings: string[],
): void {
  const filename = file.path.split("/").at(-1) ?? file.path;
  if (
    file.symlinkTarget !== undefined &&
    symlinkEscapesRepo(file.path, file.symlinkTarget, symlinkTargets)
  ) {
    rejections.push(`repo symlink ${file.path} escapes the repository`);
  }
  // Quarantine membership is itself the evidence: quarantined files arrive
  // text-stripped, so content predicates cannot re-derive their secretness.
  if (quarantinedPaths.has(file.path)) {
    warnings.push(
      `repo secret file ${file.path} was quarantined before agent or runtime execution`,
    );
  } else if (
    isEnvironmentSecretFileName(filename) ||
    isCredentialRegistryConfig(filename, file.text) ||
    looksLikeEnvironmentAssignments(file.text)
  ) {
    rejections.push(`repo contains committed secret file ${file.path}`);
  } else if (
    isPrivateKeyFileName(filename) ||
    containsPrivateKeyMaterial(file.text)
  ) {
    rejections.push(`repo contains private key material in ${file.path}`);
  }

  if (
    /^Dockerfile$|\/Dockerfile$/.test(file.path) &&
    /sudo|--privileged/.test(file.text ?? "")
  ) {
    warnings.push("Dockerfile requests privileged operations");
  }
}

const maxSymlinkResolutionDepth = 40;

/**
 * Resolves a symlink target component-by-component against the archive's own
 * entry set, following known in-repo symlinks, so an upward hop through an
 * aliased directory cannot lexically hide an escape. Returns undefined when
 * the target is absolute, leaves the repository root at any step, or cannot
 * be resolved within the depth bound (cycles fail closed).
 */
function resolveRepoSymlinkTarget(
  baseComponents: readonly string[],
  target: string,
  symlinkTargets: ReadonlyMap<string, string>,
  depth: number,
): string[] | undefined {
  if (depth <= 0 || posix.isAbsolute(target)) return undefined;
  const resolved = [...baseComponents];
  for (const component of target.split(/[\\/]/)) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    resolved.push(component);
    const linkTarget = symlinkTargets.get(resolved.join("/"));
    if (linkTarget === undefined) continue;
    const linkResolution = resolveRepoSymlinkTarget(
      resolved.slice(0, -1),
      linkTarget,
      symlinkTargets,
      depth - 1,
    );
    if (linkResolution === undefined) return undefined;
    resolved.length = 0;
    resolved.push(...linkResolution);
  }
  return resolved;
}

function symlinkEscapesRepo(
  path: string,
  target: string,
  symlinkTargets: ReadonlyMap<string, string>,
): boolean {
  const baseComponents = path
    .split("/")
    .slice(0, -1)
    .filter((component) => component.length > 0);
  return (
    resolveRepoSymlinkTarget(
      baseComponents,
      target,
      symlinkTargets,
      maxSymlinkResolutionDepth,
    ) === undefined
  );
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
      /rm\s+-(?:rf|fr)\s+\/(?:\s|$)/.test(command) ||
      /\bmkfs\.\w+|forkbomb|crypto.?miner/i.test(command)
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

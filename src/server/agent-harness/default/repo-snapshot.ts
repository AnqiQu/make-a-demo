import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { readErrorMessage } from "../../shared/text/read-error-message";
import {
  containsPrivateKeyMaterial,
  isCredentialRegistryConfig,
  isEnvironmentFileName,
  isSecretInspectionPath,
  registryConfigFileNames,
} from "../repo-security/secret-predicates";
import {
  type SecretQuarantineManifest,
  quarantineRepoSecrets,
} from "../repo-security/secret-quarantine";
import { assertSafeGithubRepoUrl } from "./github-repo-url";

export type RepoSourceArchive = {
  commitSha: string;
  path: string;
  sha256: string;
  /** Exact compressed archive size used for pre-sandbox resource selection. */
  sizeBytes: number;
};

export type RepoSnapshot = {
  commitSha: string;
  files: Array<{
    path: string;
    /** False when the file was too large for text-based screening. */
    scanned?: boolean;
    symlinkTarget?: string;
    text?: string;
  }>;
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
  secretQuarantineManifest: SecretQuarantineManifest;
  sourceArchive: RepoSourceArchive;
};

export type RepoSnapshotLogger = (
  event: string,
  fields?: Record<string, unknown>,
) => Promise<void>;

type RepoCloneCredential = {
  password: string;
  username: "x-access-token";
};

/**
 * Git operations used to create a screened repository snapshot. Implementations
 * must archive the requested commit exactly and must not place credentials in
 * repository URLs, command arguments, logs, or the resulting archive.
 */
export interface RepoSnapshotGit {
  archiveRevision(input: {
    archivePath: string;
    checkoutPath: string;
    commitSha: string;
    excludedPaths?: string[];
  }): Promise<void>;
  clone(input: {
    checkoutPath: string;
    credential?: RepoCloneCredential;
    repoUrl: string;
    /** Kill the clone after this long; defaults to five minutes. */
    timeoutMs?: number;
  }): Promise<void>;
  readHead(checkoutPath: string): Promise<string>;
}

/** Supplies short-lived GitHub App credentials for private repository reads. */
export interface GithubInstallationTokenProvider {
  createInstallationToken(installationId: string): Promise<string>;
}

export type RepoSnapshotDependencies = {
  /** Total bytes of file content the walk may read; defaults to 256 MiB. */
  contentScanBudgetBytes?: number;
  git?: RepoSnapshotGit;
  installationTokenProvider?: GithubInstallationTokenProvider;
};

const maxReadableFileBytes = 128 * 1024;
// Package manifests decide screening rejections, so they get a raised cap
// instead of silently arriving unscanned.
const maxReadablePackageManifestBytes = 1024 * 1024;
const defaultContentScanBudgetBytes = 256 * 1024 * 1024;
const defaultCloneTimeoutMs = 300_000;
const ignoredDirectoryNames = new Set([".git"]);
// Vendored and build-output trees keep name-based secret detection but skip
// content inspection: their records stay in the walk so quarantine can still
// exclude committed secrets by filename, without unbounded read work.
const contentInspectionExcludedDirectoryNames = new Set([
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const privateKeyScanTailLength = 128;
const privateKeySentinel = "-----BEGIN PRIVATE KEY-----";
// Only names not already admitted by isEnvironmentFileName or a readable
// extension belong here: lockfiles, workspace config, and the compose files
// that carry the data-service declarations servicesRequired detection reads
// (N122).
const readableFileNames = new Set([
  "bun.lock",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
]);
const readableExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  // Prisma schemas carry the datasource provider servicesRequired detection
  // reads (N122).
  ".prisma",
  ".ts",
  ".tsx",
  ".txt",
]);

/** Fails closed when a screened repository archive changed after screening. */
export async function assertRepoSourceArchiveIntegrity(
  sourceArchive: RepoSourceArchive,
): Promise<void> {
  const actualSha256 = await sha256File(sourceArchive.path);
  if (actualSha256 !== sourceArchive.sha256) {
    throw new Error(
      `Screened repository archive integrity check failed for commit ${sourceArchive.commitSha}.`,
    );
  }
}

export async function readGithubRepoSnapshot(
  input: {
    githubInstallationId?: string;
    log: RepoSnapshotLogger;
    repoUrl: string;
    runDirectory: string;
  },
  dependencies: RepoSnapshotDependencies = {},
): Promise<RepoSnapshot> {
  assertSafeGithubRepoUrl(input.repoUrl);

  const git = dependencies.git ?? defaultRepoSnapshotGit;
  const runDirectory = resolve(input.runDirectory);
  const checkoutPath = join(runDirectory, "repo-snapshot");
  // Gzip-compressed: the archive crosses the developer uplink to the sandbox,
  // and source trees compress several-fold — twenty's uncompressed 294MB tar
  // could not finish inside the upload attempt timeout on a contended uplink
  // (2026-08-13T23-23 matrix).
  const archivePath = join(runDirectory, "screened-repo.tar.gz");
  const credential = await createRepoCloneCredential({
    ...(input.githubInstallationId === undefined
      ? {}
      : { githubInstallationId: input.githubInstallationId }),
    ...(dependencies.installationTokenProvider === undefined
      ? {}
      : {
          installationTokenProvider: dependencies.installationTokenProvider,
        }),
  });
  await input.log("repo.clone.started", { checkoutPath });
  let snapshotComplete = false;
  try {
    try {
      await git.clone({
        checkoutPath,
        ...(credential === undefined ? {} : { credential }),
        repoUrl: input.repoUrl,
      });
    } catch (error) {
      // The report row truncates to one line; the durable log must carry
      // git's whole stderr, whose trailing fatal: line names the real cause
      // (calcom and ghostfolio's mid-transfer exit-128s, 2026-08-13T23-23).
      await input.log("repo.clone.failed", {
        error: readErrorMessage(error),
      });
      throw error;
    }
    const commitSha = readCommitSha(await git.readHead(checkoutPath));
    await input.log("repo.clone.succeeded", { commitSha });
    const repoFiles = await readRepoFiles(
      checkoutPath,
      dependencies.contentScanBudgetBytes ?? defaultContentScanBudgetBytes,
    );
    const quarantine = quarantineRepoSecrets(repoFiles.files);
    await git.archiveRevision({
      archivePath,
      checkoutPath,
      commitSha,
      ...(quarantine.excludedPaths.length === 0
        ? {}
        : { excludedPaths: quarantine.excludedPaths }),
    });
    await assertArchiveExcludesQuarantinedPaths(
      archivePath,
      quarantine.excludedPaths,
    );
    const sourceArchive = {
      commitSha,
      path: archivePath,
      sha256: await sha256File(archivePath),
      sizeBytes: (await stat(archivePath)).size,
    };
    await input.log("repo.archive.succeeded", {
      commitSha,
      path: archivePath,
      quarantinedFileCount: quarantine.manifest.entries.length,
      sha256: sourceArchive.sha256,
      sizeBytes: sourceArchive.sizeBytes,
    });
    snapshotComplete = true;
    return {
      commitSha,
      files: quarantine.files,
      repoStats: repoFiles.repoStats,
      secretQuarantineManifest: quarantine.manifest,
      sourceArchive,
    };
  } finally {
    await rm(checkoutPath, { force: true, recursive: true });
    if (!snapshotComplete) {
      await rm(archivePath, { force: true });
    }
  }
}

/**
 * Fails closed when the archive that reaches agents and the runtime still
 * contains any quarantined path. This is the one assertion on the one
 * mechanism that removes secrets; it must read the real tar members.
 */
async function assertArchiveExcludesQuarantinedPaths(
  archivePath: string,
  excludedPaths: string[],
): Promise<void> {
  if (excludedPaths.length === 0) return;
  const members = new Set(
    (await readTarMemberPaths(archivePath)).map((member) =>
      member.replace(/^\.\//, ""),
    ),
  );
  const leaked = excludedPaths.filter((path) => members.has(path));
  if (leaked.length > 0) {
    throw new Error(
      `Screened repository archive still contains quarantined path(s): ${leaked.join(", ")}.`,
    );
  }
}

async function readTarMemberPaths(archivePath: string): Promise<string[]> {
  // The archive is gzip-compressed, so members are parsed from a sequential
  // gunzip stream instead of random-access file reads.
  const tar = Buffer.concat(await readGunzippedChunks(archivePath));
  const members: string[] = [];
  let position = 0;
  let overrideName: string | undefined;
  for (;;) {
    const header = tar.subarray(position, position + 512);
    if (header.length < 512 || header.every((byte) => byte === 0)) break;
    position += 512;
    const size = Number.parseInt(
      header.toString("ascii", 124, 136).replaceAll("\0", " ").trim() || "0",
      8,
    );
    const dataBytes = Math.ceil(size / 512) * 512;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "L" || typeflag === "x" || typeflag === "g") {
      const text = tar.subarray(position, position + size).toString("utf8");
      if (typeflag === "L") {
        overrideName = text.replace(/\0+$/, "");
      } else if (typeflag === "x") {
        overrideName =
          /(?:^|\n)\d+ path=([^\n]+)\n/.exec(text)?.[1] ?? overrideName;
      }
    } else {
      const rawName = header.toString("utf8", 0, 100).split("\0", 1)[0] ?? "";
      const prefix = header.toString("utf8", 345, 500).split("\0", 1)[0] ?? "";
      members.push(
        overrideName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName),
      );
      overrideName = undefined;
    }
    position += dataBytes;
  }
  return members;
}

async function readGunzippedChunks(archivePath: string): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(archivePath).pipe(createGunzip());
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks;
}

export const defaultRepoSnapshotGit: RepoSnapshotGit = {
  async archiveRevision(input) {
    const excludedPathspecs = (input.excludedPaths ?? []).map(
      (path) => `:(exclude,top,literal)${path}`,
    );
    await runCommand("git", [
      "-C",
      input.checkoutPath,
      "archive",
      "--format=tar.gz",
      "--output",
      input.archivePath,
      input.commitSha,
      ...(excludedPathspecs.length === 0
        ? []
        : ["--", ".", ...excludedPathspecs]),
    ]);
  },
  async clone(input) {
    await runCommand(
      "git",
      ["clone", "--depth", "1", "--no-tags", input.repoUrl, input.checkoutPath],
      {
        env:
          input.credential === undefined
            ? { GIT_TERMINAL_PROMPT: "0" }
            : createGitCredentialEnvironment(input.credential),
        timeoutMs: input.timeoutMs ?? defaultCloneTimeoutMs,
      },
    );
  },
  async readHead(checkoutPath) {
    return (await runCommand("git", ["-C", checkoutPath, "rev-parse", "HEAD"]))
      .stdout;
  },
};

async function readRepoFiles(
  root: string,
  contentScanBudgetBytes: number,
): Promise<{
  files: Array<{
    path: string;
    scanned?: boolean;
    symlinkTarget?: string;
    text?: string;
  }>;
  repoStats: { fileCount: number; sizeBytes: number };
}> {
  const files: Array<{
    path: string;
    scanned?: boolean;
    symlinkTarget?: string;
    text?: string;
  }> = [];
  let fileCount = 0;
  let sizeBytes = 0;
  let remainingContentScanBytes = contentScanBudgetBytes;

  async function visit(
    directory: string,
    relativeDirectory = "",
    contentExcluded = false,
  ) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          await visit(
            join(directory, entry.name),
            join(relativeDirectory, entry.name),
            contentExcluded ||
              contentInspectionExcludedDirectoryNames.has(entry.name),
          );
        }
        continue;
      }

      const relativePath = join(relativeDirectory, entry.name).replaceAll(
        "\\",
        "/",
      );
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const fileStat = await lstat(absolutePath);
        fileCount += 1;
        sizeBytes += fileStat.size;
        files.push({
          path: relativePath,
          symlinkTarget: await readlink(absolutePath),
        });
        continue;
      }
      if (!entry.isFile()) continue;

      const fileStat = await stat(absolutePath);
      fileCount += 1;
      sizeBytes += fileStat.size;
      if (contentExcluded && !isSecretNamedPath(relativePath)) {
        files.push({ path: relativePath });
        continue;
      }
      // Package manifests are exempt from the cumulative budget: they carry
      // the destructive-script screen, are individually size-capped below,
      // and a large repo must not push its own manifests past the budget.
      if (
        fileStat.size > remainingContentScanBytes &&
        !isPackageManifestPath(relativePath)
      ) {
        files.push({ path: relativePath, scanned: false });
        continue;
      }
      remainingContentScanBytes -= fileStat.size;
      const { scanned, text } = await readFileTextIfUseful(
        absolutePath,
        relativePath,
        fileStat.size,
      );
      files.push({
        path: relativePath,
        ...(text === undefined ? {} : { text }),
        ...(scanned ? {} : { scanned: false }),
      });
    }
  }

  await visit(root);
  return { files, repoStats: { fileCount, sizeBytes } };
}

/**
 * Filenames whose secret handling must survive content-inspection exclusion:
 * quarantine still needs their text for environment-key hints and
 * credential-content checks. `isCredentialRegistryConfig` with undefined text
 * is the name-only registry-config test.
 */
function isSecretNamedPath(relativePath: string): boolean {
  return (
    isEnvironmentFileName(relativePath) ||
    isSecretInspectionPath(relativePath) ||
    isCredentialRegistryConfig(relativePath, undefined)
  );
}

async function readFileTextIfUseful(
  path: string,
  relativePath: string,
  sizeBytes: number,
): Promise<{ scanned: boolean; text?: string }> {
  const readableBytes = isPackageManifestPath(relativePath)
    ? maxReadablePackageManifestBytes
    : maxReadableFileBytes;
  if (sizeBytes <= readableBytes) {
    const text = await readFile(path, "utf8");
    return isUsefulTextPath(relativePath) || containsPrivateKeyMaterial(text)
      ? { scanned: true, text }
      : { scanned: true };
  }
  if (await fileContainsPrivateKeyMaterial(path)) {
    return { scanned: true, text: privateKeySentinel };
  }
  // The private-key stream ran, but text-based screening was skipped, so a
  // path the screen would have read must not pass silently.
  return { scanned: !isUsefulTextPath(relativePath) };
}

function isPackageManifestPath(relativePath: string): boolean {
  // project.json is nx's per-package manifest: run targets for nx-managed
  // apps live there instead of package.json scripts, so the profiler needs
  // its text with the same budget guarantees as package.json.
  const name = basename(relativePath);
  return name === "package.json" || name === "project.json";
}

function isUsefulTextPath(relativePath: string): boolean {
  return (
    isEnvironmentFileName(relativePath) ||
    registryConfigFileNames.has(basename(relativePath)) ||
    readableFileNames.has(basename(relativePath)) ||
    readableExtensions.has(extname(relativePath)) ||
    isSecretInspectionPath(relativePath)
  );
}

async function fileContainsPrivateKeyMaterial(path: string): Promise<boolean> {
  let tail = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const sample = tail + chunk;
    if (containsPrivateKeyMaterial(sample)) return true;
    tail = sample.slice(-privateKeyScanTailLength);
  }
  return false;
}

async function createRepoCloneCredential(input: {
  githubInstallationId?: string;
  installationTokenProvider?: GithubInstallationTokenProvider;
}): Promise<RepoCloneCredential | undefined> {
  if (input.githubInstallationId === undefined) {
    return undefined;
  }
  if (input.installationTokenProvider === undefined) {
    throw new Error(
      "A GitHub installation token provider is required for private repository snapshots.",
    );
  }

  return {
    password: await input.installationTokenProvider.createInstallationToken(
      input.githubInstallationId,
    ),
    username: "x-access-token",
  };
}

function createGitCredentialEnvironment(
  credential: RepoCloneCredential,
): Record<string, string> {
  const authorization = Buffer.from(
    `${credential.username}:${credential.password}`,
  ).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function readCommitSha(value: string): string {
  const commitSha = value.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
    throw new Error("GitHub repository HEAD did not resolve to a commit SHA.");
  }
  return commitSha;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function runCommand(
  command: string,
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number },
) {
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    // Detached so a timeout can kill the whole process group: git spawns
    // helpers (git-remote-http) that would otherwise survive and hold pipes.
    const child = spawn(command, args, {
      detached: true,
      ...(options?.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
            reject(
              new Error(
                `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms.`,
              ),
            );
          }, options.timeoutMs);
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) return;
      const result = { stderr: stderr.join(""), stdout: stdout.join("") };
      if (exitCode !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit ${exitCode}: ${
              result.stderr || result.stdout
            }`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

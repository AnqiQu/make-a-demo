import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { assertSafeGithubRepoUrl } from "./github-repo-url";

export type RepoSourceArchive = {
  commitSha: string;
  path: string;
  sha256: string;
};

export type RepoSnapshot = {
  commitSha: string;
  files: Array<{ path: string; text?: string }>;
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
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
  }): Promise<void>;
  clone(input: {
    checkoutPath: string;
    credential?: RepoCloneCredential;
    repoUrl: string;
  }): Promise<void>;
  readHead(checkoutPath: string): Promise<string>;
}

/** Supplies short-lived GitHub App credentials for private repository reads. */
export interface GithubInstallationTokenProvider {
  createInstallationToken(installationId: string): Promise<string>;
}

export type RepoSnapshotDependencies = {
  git?: RepoSnapshotGit;
  installationTokenProvider?: GithubInstallationTokenProvider;
};

const maxReadableFileBytes = 128 * 1024;
const ignoredDirectoryNames = new Set([
  ".git",
  ".makeademo",
  ".next",
  ".turbo",
  ".vercel",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const readableFileNames = new Set([
  ".env",
  ".env.example",
  "astro.config.mjs",
  "bun.lock",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.js",
  "vite.config.ts",
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
  const archivePath = join(runDirectory, "screened-repo.tar");
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
    await git.clone({
      checkoutPath,
      ...(credential === undefined ? {} : { credential }),
      repoUrl: input.repoUrl,
    });
    const commitSha = readCommitSha(await git.readHead(checkoutPath));
    await input.log("repo.clone.succeeded", { commitSha });
    const files = await readRepoFiles(checkoutPath);
    await git.archiveRevision({ archivePath, checkoutPath, commitSha });
    const sourceArchive = {
      commitSha,
      path: archivePath,
      sha256: await sha256File(archivePath),
    };
    await input.log("repo.archive.succeeded", {
      commitSha,
      path: archivePath,
      sha256: sourceArchive.sha256,
    });
    snapshotComplete = true;
    return { commitSha, ...files, sourceArchive };
  } finally {
    await rm(checkoutPath, { force: true, recursive: true });
    if (!snapshotComplete) {
      await rm(archivePath, { force: true });
    }
  }
}

const defaultRepoSnapshotGit: RepoSnapshotGit = {
  async archiveRevision(input) {
    await runCommand("git", [
      "-C",
      input.checkoutPath,
      "archive",
      "--format=tar",
      "--output",
      input.archivePath,
      input.commitSha,
    ]);
  },
  async clone(input) {
    await runCommand(
      "git",
      ["clone", "--depth", "1", input.repoUrl, input.checkoutPath],
      input.credential === undefined
        ? undefined
        : { env: createGitCredentialEnvironment(input.credential) },
    );
  },
  async readHead(checkoutPath) {
    return (await runCommand("git", ["-C", checkoutPath, "rev-parse", "HEAD"]))
      .stdout;
  },
};

async function readRepoFiles(root: string): Promise<{
  files: Array<{ path: string; text?: string }>;
  repoStats: { fileCount: number; sizeBytes: number };
}> {
  const files: Array<{ path: string; text?: string }> = [];
  let fileCount = 0;
  let sizeBytes = 0;

  async function visit(directory: string, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          await visit(
            join(directory, entry.name),
            join(relativeDirectory, entry.name),
          );
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = join(relativeDirectory, entry.name).replaceAll(
        "\\",
        "/",
      );
      const absolutePath = join(directory, entry.name);
      const fileStat = await stat(absolutePath);
      fileCount += 1;
      sizeBytes += fileStat.size;
      const text = await readFileTextIfUseful(absolutePath, relativePath);
      files.push(
        text === undefined
          ? { path: relativePath }
          : { path: relativePath, text },
      );
    }
  }

  await visit(root);
  return { files, repoStats: { fileCount, sizeBytes } };
}

async function readFileTextIfUseful(
  path: string,
  relativePath: string,
): Promise<string | undefined> {
  const fileStat = await stat(path);
  if (fileStat.size > maxReadableFileBytes) {
    return undefined;
  }
  if (
    !readableFileNames.has(basename(relativePath)) &&
    !readableExtensions.has(extname(relativePath))
  ) {
    return undefined;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
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
  options?: { env: Record<string, string> },
) {
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options?.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => {
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

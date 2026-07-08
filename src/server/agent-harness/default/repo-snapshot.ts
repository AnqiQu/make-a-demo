import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type RepoSnapshot = {
  commitSha?: string;
  files: Array<{ path: string; text?: string }>;
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
};

export type RepoSnapshotLogger = (
  event: string,
  fields?: Record<string, unknown>,
) => Promise<void>;

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

export async function readGithubRepoSnapshot(input: {
  log: RepoSnapshotLogger;
  repoUrl: string;
  runDirectory: string;
}): Promise<RepoSnapshot> {
  assertGithubRepoUrl(input.repoUrl);

  const checkoutPath = join(input.runDirectory, "repo-snapshot");
  await input.log("repo.clone.started", { checkoutPath });
  await runCommand("git", [
    "clone",
    "--depth",
    "1",
    input.repoUrl,
    checkoutPath,
  ]);
  const commitSha = (
    await runCommand("git", ["-C", checkoutPath, "rev-parse", "HEAD"])
  ).stdout.trim();
  await input.log("repo.clone.succeeded", { commitSha });
  return {
    commitSha,
    ...(await readRepoFiles(checkoutPath)),
  };
}

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

function runCommand(command: string, args: string[]) {
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

function assertGithubRepoUrl(repoUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error("GitHub repo URL must be a valid https://github.com URL.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parts.length < 2
  ) {
    throw new Error(
      "GitHub repo URL must be a valid https://github.com owner/repo URL.",
    );
  }
}

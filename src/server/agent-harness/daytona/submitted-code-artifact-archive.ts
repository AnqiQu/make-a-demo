import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { executeSubmittedCode } from "./submitted-code-execution";
import type { AgentHarnessWorkspace } from "./workspace.interface";

const archiveTransferCommandTimeoutMs = 30_000;

/**
 * Uploads several local files through one submitted-code artifact transfer and
 * extracts them into the requested remote directory.
 */
export async function uploadSubmittedCodeArchive(input: {
  archiveName: string;
  compression?: "gzip" | "none";
  entries: string[];
  localDirectory: string;
  remoteDirectory: string;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  assertSafeArchiveName(input.archiveName);
  assertSafeArchiveEntries(input.entries);
  const uploadFiles = input.workspace.uploadSubmittedCodeFiles?.bind(
    input.workspace,
  );
  if (uploadFiles === undefined) {
    throw new Error("Submitted-code artifact upload support is required.");
  }
  const localArchivePath = join(input.localDirectory, input.archiveName);
  const remoteArchivePath = `${input.remoteDirectory}/${input.archiveName}`;
  await createLocalArchive({
    archivePath: localArchivePath,
    compression: input.compression ?? "gzip",
    directory: input.localDirectory,
    entries: input.entries,
  });
  const directoryCreation = await executeSubmittedCode(
    input.workspace,
    `mkdir -p ${shellQuote(input.remoteDirectory)}`,
    { timeoutMs: archiveTransferCommandTimeoutMs },
  );
  if (directoryCreation.exitCode !== 0) {
    throw new Error(
      `Failed to create submitted-code archive directory ${input.remoteDirectory}.\n${formatCommandOutput(directoryCreation)}`,
    );
  }
  await uploadFiles([
    { destinationPath: remoteArchivePath, sourcePath: localArchivePath },
  ]);
  const extraction = await executeSubmittedCode(
    input.workspace,
    [
      `tar ${input.compression === "none" ? "-xf" : "-xzf"} ${shellQuote(remoteArchivePath)} -C ${shellQuote(input.remoteDirectory)}`,
      `rm -f ${shellQuote(remoteArchivePath)}`,
    ].join(" && "),
    { timeoutMs: archiveTransferCommandTimeoutMs },
  );
  if (extraction.exitCode !== 0) {
    throw new Error(
      `Failed to extract submitted-code input archive ${remoteArchivePath}.\n${formatCommandOutput(extraction)}`,
    );
  }
  await rm(localArchivePath, { force: true });
}

/**
 * Archives remote submitted-code artifacts, transfers one file, and extracts
 * it into a local directory.
 */
export async function downloadSubmittedCodeArchive(input: {
  archiveName: string;
  compression?: "gzip" | "none";
  entries: string[];
  localDirectory: string;
  remoteDirectory: string;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  assertSafeArchiveName(input.archiveName);
  assertSafeArchiveEntries(input.entries);
  const downloadFiles = input.workspace.downloadSubmittedCodeFiles?.bind(
    input.workspace,
  );
  if (downloadFiles === undefined) {
    throw new Error("Submitted-code artifact download support is required.");
  }
  await mkdir(input.localDirectory, { recursive: true });
  const localArchivePath = join(input.localDirectory, input.archiveName);
  const remoteArchivePath = `${input.remoteDirectory}/${input.archiveName}`;
  const creation = await executeSubmittedCode(
    input.workspace,
    [
      `rm -f ${shellQuote(remoteArchivePath)}`,
      `tar ${input.compression === "none" ? "-cf" : "-czf"} ${shellQuote(remoteArchivePath)} -C ${shellQuote(input.remoteDirectory)} -- ${input.entries.map(shellQuote).join(" ")}`,
    ].join(" && "),
    { timeoutMs: archiveTransferCommandTimeoutMs },
  );
  if (creation.exitCode !== 0) {
    throw new Error(
      `Failed to create submitted-code output archive ${remoteArchivePath}.\n${formatCommandOutput(creation)}`,
    );
  }
  await downloadFiles([
    { destinationPath: localArchivePath, sourcePath: remoteArchivePath },
  ]);
  await extractLocalArchive({
    archivePath: localArchivePath,
    compression: input.compression ?? "gzip",
    directory: input.localDirectory,
  });
  await rm(localArchivePath, { force: true });
  await executeSubmittedCode(
    input.workspace,
    `rm -f ${shellQuote(remoteArchivePath)}`,
    { timeoutMs: archiveTransferCommandTimeoutMs },
  );
}

async function createLocalArchive(input: {
  archivePath: string;
  compression: "gzip" | "none";
  directory: string;
  entries: string[];
}): Promise<void> {
  await runLocalTar([
    input.compression === "none" ? "-cf" : "-czf",
    input.archivePath,
    "-C",
    input.directory,
    "--",
    ...input.entries,
  ]);
}

async function extractLocalArchive(input: {
  archivePath: string;
  compression: "gzip" | "none";
  directory: string;
}): Promise<void> {
  await runLocalTar([
    input.compression === "none" ? "-xf" : "-xzf",
    input.archivePath,
    "-C",
    input.directory,
  ]);
}

async function runLocalTar(args: string[]): Promise<void> {
  const result = await new Promise<{
    exitCode: number | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr }));
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Local artifact archive command failed with exit code ${result.exitCode}: ${result.stderr}`,
    );
  }
}

function formatCommandOutput(result: { stderr: string; stdout: string }) {
  return [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSafeArchiveName(value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/")
  ) {
    throw new Error(`Unsafe submitted-code archive name: ${value}`);
  }
}

function assertSafeArchiveEntries(entries: string[]): void {
  if (entries.length === 0) {
    throw new Error("Submitted-code artifact archive must not be empty.");
  }
  for (const entry of entries) {
    const segments = entry.split("/");
    if (
      entry.startsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      throw new Error(`Unsafe submitted-code archive entry: ${entry}`);
    }
  }
}

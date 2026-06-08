import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { readDemoBrief } from "../../pipeline/01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../../pipeline/01-context-gathering/supporting-documents";
import type { RepoSecurityInput } from "../../pipeline/02-repo-security-screen/repo-security-screen";
import { OpenCodeRepoPreparationAgent } from "../integrations/agents/opencode-repo-preparation-agent";
import { DockerSandboxRunner } from "../integrations/sandbox/docker-sandbox-runner";
import { runPipelineJob } from "./pipeline-orchestrator";
import { collectStage1CliOptions } from "./stage1-cli-interactive";
import { parseStage1CliArgs } from "./stage1-cli-options";
import { createStage1PipelineDependencies } from "./stage1-pipeline";

const options = await readOptions(process.argv.slice(2));
const workspaceDirectory = join(options.workspaceRoot, options.workspaceId);

process.stderr.write("[pipeline] clone: started\n");
await rm(workspaceDirectory, { force: true, recursive: true });
await mkdir(options.workspaceRoot, { recursive: true });
await runCommand("git", [
  "clone",
  "--depth",
  "1",
  options.repoUrl,
  workspaceDirectory,
]);
process.stderr.write("[pipeline] clone: succeeded\n");

const repoSecurity = await readRepoSecurityInput(workspaceDirectory);
const normalizedSupportingDocuments = await Promise.all(
  options.docs.map(async (docPath) => {
    const contents = await readFile(docPath, "utf8");
    const stats = await stat(docPath);
    const source = readSupportingDocumentUpload({
      artifactId: `local-doc:${docPath}`,
      fileName: basename(docPath),
      mimeType: inferTextMimeType(docPath),
      sizeBytes: stats.size,
    });

    return normalizeSupportingDocument({ contents, source });
  }),
);

const repoPreparationAgent = new OpenCodeRepoPreparationAgent({
  directory: workspaceDirectory,
  modelID: options.modelID,
  onProgress: (line) => process.stderr.write(`${line}\n`),
  providerID: options.providerID,
});

const result = await runPipelineJob(
  {
    demoBrief: readDemoBrief({ keyProductFeatures: options.features }),
    normalizedSupportingDocuments,
    repoSecurity,
    repoUrl: options.repoUrl,
    workspaceId: options.workspaceId,
  },
  createStage1PipelineDependencies({
    repoPreparationAgent,
    sandboxRunner: new DockerSandboxRunner({
      workspaceRoot: options.workspaceRoot,
    }),
  }),
  {
    onProgress: (event) =>
      process.stderr.write(`[pipeline] ${event.stage}: ${event.status}\n`),
  },
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (result.status !== "succeeded") {
  process.exitCode = 1;
}

async function readOptions(args: string[]) {
  if (args.length > 0) {
    return parseStage1CliArgs(args);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await collectStage1CliOptions({
      prompt: (question) => readline.question(question),
      write: (message) => process.stdout.write(`${message}\n`),
    });
  } finally {
    readline.close();
  }
}

async function readRepoSecurityInput(
  workspaceDirectory: string,
): Promise<RepoSecurityInput> {
  const entries = await readdir(workspaceDirectory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = entry.name;
        const fullPath = join(workspaceDirectory, path);
        const stats = await stat(fullPath);
        const text = shouldReadForSecurity(path)
          ? await readFile(fullPath, "utf8")
          : undefined;

        return text === undefined
          ? { path }
          : { path, text, sizeBytes: stats.size };
      }),
  );
  const repoStats = await calculateRepoStats(workspaceDirectory);

  return { files, repoStats };
}

async function calculateRepoStats(directory: string) {
  let fileCount = 0;
  let sizeBytes = 0;

  async function walk(currentDirectory: string) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stats = await stat(fullPath);
        fileCount += 1;
        sizeBytes += stats.size;
      }
    }
  }

  await walk(directory);
  return { fileCount, sizeBytes };
}

function shouldReadForSecurity(path: string): boolean {
  return (
    path === "package.json" || path.startsWith(".env") || path.endsWith(".sh")
  );
}

function inferTextMimeType(path: string): string {
  if (path.endsWith(".md")) {
    return "text/markdown";
  }

  if (path.endsWith(".json")) {
    return "application/json";
  }

  if (path.endsWith(".csv")) {
    return "text/csv";
  }

  return "text/plain";
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    stdio: "inherit",
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${exitCode}`);
  }
}

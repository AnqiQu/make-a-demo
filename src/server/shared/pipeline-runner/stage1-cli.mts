import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";

import { readDemoBrief } from "../../pipeline/01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../../pipeline/01-context-gathering/supporting-documents";
import type { RepoSecurityInput } from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { PreparationWorkspaceProvider } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { createRepoPreparationAgent } from "../integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../integrations/sandbox/daytona-sandbox-runner";
import { runPipelineJob } from "./pipeline-orchestrator";
import { collectStage1CliOptions } from "./stage1-cli-interactive";
import { parseStage1CliArgs } from "./stage1-cli-options";
import { createStage1PipelineDependencies } from "./stage1-pipeline";
import { readRepoSecurityInput } from "./stage1-repo-security";

const options = await readOptions(process.argv.slice(2));
const daytonaApiKey = process.env.DAYTONA_API_KEY;

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for Daytona Stage 1 runs.");
}

const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(options.daytonaSnapshot === undefined
    ? {}
    : { snapshot: options.daytonaSnapshot }),
});
const repoSecurity = await readRepoSecurityInput(
  sandboxProvider,
  options.repoUrl,
);
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

const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(options.daytonaSnapshot === undefined
    ? {}
    : { daytonaSnapshot: options.daytonaSnapshot }),
  modelID: options.modelID,
  providerApiKey: readProviderApiKey(options.providerID),
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
    sandboxRunner: new DaytonaSandboxRunner(),
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
  provider: PreparationWorkspaceProvider,
  repoUrl: string,
): Promise<RepoSecurityInput> {
  const handle = await provider.create();

  try {
    process.stderr.write("[pipeline] daytona clone: started\n");
    await handle.workspace.setOutboundNetworkAccess(true);
    const cloneResult = await handle.workspace.execute(
      `mkdir -p /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && git clone --depth 1 ${shellQuote(repoUrl)} /workspace`,
    );
    await handle.workspace.setOutboundNetworkAccess(false);
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `Daytona git clone failed: ${[cloneResult.stderr, cloneResult.stdout].filter((line) => line.length > 0).join("\n")}`,
      );
    }
    process.stderr.write("[pipeline] daytona clone: succeeded\n");

    const statsResult = await handle.workspace.execute(
      "find /workspace -path /workspace/.git -prune -o -path /workspace/node_modules -prune -o -type f -printf '%P\\t%s\\n'",
    );
    if (statsResult.exitCode !== 0) {
      throw new Error(`Daytona repo stats failed: ${statsResult.stderr}`);
    }

    const fileStats = statsResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [path = "", size = "0"] = line.split("\t");
        return { path, sizeBytes: Number(size) };
      });
    const files = await Promise.all(
      fileStats.map(async (file) => {
        if (!shouldReadForSecurity(file.path)) {
          return { path: file.path };
        }

        const textResult = await handle.workspace.execute(
          `cat ${shellQuote(`/workspace/${file.path}`)}`,
        );

        return {
          path: file.path,
          text: textResult.stdout,
        };
      }),
    );

    return {
      files,
      repoStats: {
        fileCount: fileStats.length,
        sizeBytes: fileStats.reduce((sum, file) => sum + file.sizeBytes, 0),
      },
    };
  } finally {
    await handle.destroy();
  }
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

function readProviderApiKey(providerID: string): string {
  if (providerID !== "openai") {
    throw new Error(`Unsupported Repo Preparation provider: ${providerID}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY is required for OpenAI Repo Preparation.");
  }

  return apiKey;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

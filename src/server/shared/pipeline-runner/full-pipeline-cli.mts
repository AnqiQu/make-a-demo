import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";

import { readDemoBrief } from "../../pipeline/01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../../pipeline/01-context-gathering/supporting-documents";
import { createRepoPreparationAgent } from "../integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../integrations/sandbox/daytona-sandbox-runner";
import { runFullPipelineJob } from "./full-pipeline-runner";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { collectStage1CliOptions } from "./stage1-cli-interactive";
import { parseStage1CliArgs } from "./stage1-cli-options";
import { createStage1PipelineDependencies } from "./stage1-pipeline";
import { readRepoSecurityInput } from "./stage1-repo-security";

const { outputRoot, stage1Args } = readFullPipelineArgs(process.argv.slice(2));
const options = await readOptions(stage1Args);
const daytonaApiKey = process.env.DAYTONA_API_KEY;

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for full pipeline runs.");
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
const openCodeOutput = createOpenCodeOutputStream({
  write: (text) => process.stdout.write(text),
});
const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(options.daytonaSnapshot === undefined
    ? {}
    : { daytonaSnapshot: options.daytonaSnapshot }),
  modelID: options.modelID,
  onStderr: (chunk) => process.stderr.write(chunk),
  onStdout: (chunk) => openCodeOutput.write(chunk),
  providerApiKey: readProviderApiKey(options.providerID),
  providerID: options.providerID,
});

const result = await runFullPipelineJob(
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
    ...(outputRoot === undefined ? {} : { outputRoot }),
    onProgress: (event) =>
      process.stderr.write(`[pipeline] ${event.stage}: ${event.status}\n`),
  },
);

process.stdout.write("[pipeline] footage-capture: succeeded\n");
process.stdout.write("[pipeline] compositing: succeeded\n");
process.stdout.write(
  `Video: ${result.finalVideo.outputVideoPath ?? result.finalVideo.viewUrl}\n`,
);
process.stdout.write(`View URL: ${result.finalVideo.viewUrl}\n`);
process.stdout.write(`Manifest: ${result.finalVideo.manifestPath}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readFullPipelineArgs(args: string[]) {
  const stage1Args: string[] = [];
  let outputRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--output-root") {
      outputRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    stage1Args.push(arg);
  }

  return outputRoot === undefined ? { stage1Args } : { outputRoot, stage1Args };
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

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }

  return value;
}

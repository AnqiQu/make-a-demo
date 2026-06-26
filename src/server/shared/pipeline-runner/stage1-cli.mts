import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";

import { readDemoBrief } from "../../pipeline/01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../../pipeline/01-context-gathering/supporting-documents";
import { DaytonaOpenCodeAgent } from "../integrations/agents/daytona-opencode-agent";
import { DaytonaSdkPreparationWorkspaceProvider } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../integrations/sandbox/daytona-sandbox-runner";
import {
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../logging/pipeline-event-logger";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { runPipelineJob } from "./pipeline-orchestrator";
import { collectStage1CliOptions } from "./stage1-cli-interactive";
import {
  parseStage1CliArgs,
  readStage1CliDefaults,
} from "./stage1-cli-options";
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
const cliLogger = createPipelineEventLogger({
  base: { component: "stage1-cli" },
  sinks: [
    createPrettyPipelineLogSink({
      write: (text) => process.stderr.write(text),
    }),
  ],
});
const repoSecurity = await readRepoSecurityInput(
  sandboxProvider,
  options.repoUrl,
  { logger: cliLogger.child({ component: "repo-security-screen" }) },
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

const openCodeAgent = new DaytonaOpenCodeAgent({
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

const result = await runPipelineJob(
  {
    demoBrief: readDemoBrief({ keyProductFeatures: options.features }),
    normalizedSupportingDocuments,
    repoSecurity,
    repoUrl: options.repoUrl,
    workspaceId: options.workspaceId,
  },
  createStage1PipelineDependencies({
    repoPreparationAgent: openCodeAgent,
    sandboxRunner: new DaytonaSandboxRunner(),
    scriptGenerationAgent: openCodeAgent,
  }),
  {
    onProgress: async (event) => {
      await cliLogger.info(
        {
          event: "stage-progress",
          message: `${event.stage} ${event.status}.`,
          stage: event.stage,
          status: event.status,
        },
        `${event.stage} ${event.status}.`,
      );
    },
  },
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (result.status !== "succeeded") {
  process.exitCode = 1;
}

async function readOptions(args: string[]) {
  const defaults = readStage1CliDefaults();
  if (args.length > 0) {
    return parseStage1CliArgs(args, defaults);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await collectStage1CliOptions(
      {
        prompt: (question) => readline.question(question),
        write: (message) => process.stdout.write(`${message}\n`),
      },
      defaults,
    );
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

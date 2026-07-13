import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { DaytonaOpenCodeScriptGeneration } from "../../shared/integrations/agents/daytona-opencode-script-generation";
import { ensureOpenCodeProviderDaytonaSecret } from "../../shared/integrations/agents/opencode-provider-secrets";
import {
  createRepoPreparationAgent,
  readRepoPreparationTimeoutMsFromEnv,
} from "../../shared/integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../../shared/integrations/sandbox/daytona-sandbox-runner";
import {
  createFilePipelineLogSink,
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../../shared/logging/pipeline-event-logger";
import { readDemoBrief } from "../01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../01-context-gathering/supporting-documents";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { runPipelineJob } from "./pipeline-orchestrator";
import { collectPreCaptureCliOptions } from "./pre-capture-cli-interactive";
import { parsePreCaptureCliArgs } from "./pre-capture-cli-options";
import { createPreCapturePipelineDependencies } from "./pre-capture-pipeline";
import { readRepoSecurityInput } from "./pre-capture-repo-security";

const options = await readOptions(process.argv.slice(2));
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const cliLogSink = createPrettyPipelineLogSink({
  write: (text) => process.stderr.write(text),
});
const preCaptureRunDirectory = join(
  ".makeademo-pre-capture-runs",
  createRunId(),
);
const localPipelineLogSink = createFilePipelineLogSink(
  join(preCaptureRunDirectory, "pipeline-log.jsonl"),
);
const daytonaSnapshot = readOptionalEnv("MAKEADEMO_DAYTONA_SNAPSHOT");
const daytonaSubmittedCodeSnapshot = readOptionalEnv(
  "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
);

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for Daytona pre-capture runs.");
}

const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
  sandboxLogSinks: [cliLogSink],
});
const cliLogger = createPipelineEventLogger({
  base: { component: "pre-capture-cli" },
  sinks: [cliLogSink, localPipelineLogSink],
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
const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
  daytonaApiKey,
  logger: cliLogger.child({ component: "opencode-provider-secrets" }),
  providerID: options.providerID,
});
const repoPreparationTimeoutMs = readRepoPreparationTimeoutMsFromEnv();

const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  modelID: options.modelID,
  logger: cliLogger.child({ component: "repo-preparation-agent" }),
  onStderr: (chunk) => process.stderr.write(chunk),
  onStdout: (chunk) => openCodeOutput.write(chunk),
  providerID: options.providerID,
  providerSecretName,
  ...(repoPreparationTimeoutMs === undefined
    ? {}
    : { repoPreparationTimeoutMs }),
});
const scriptGenerationAgent = new DaytonaOpenCodeScriptGeneration({
  logger: cliLogger.child({ component: "script-generation-agent" }),
  modelID: options.modelID,
  onStderr: (chunk) => process.stderr.write(chunk),
  onStdout: (chunk) => openCodeOutput.write(chunk),
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
  createPreCapturePipelineDependencies({
    capturePathRepairer: scriptGenerationAgent,
    repoPreparationAgent,
    sandboxRunner: new DaytonaSandboxRunner(),
    scriptGenerationAgent,
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
  if (args.length > 0) {
    return parsePreCaptureCliArgs(args);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await collectPreCaptureCliOptions({
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

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function createRunId() {
  return `pre-capture-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

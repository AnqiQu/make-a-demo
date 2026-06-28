import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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
import { createDaytonaFreshCaptureStatePreparer } from "./fresh-capture-state";
import { runFullPipelineJob } from "./full-pipeline-runner";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { createOpenCodeRawOutputLog } from "./opencode-raw-output-log";
import { collectStage1CliOptions } from "./stage1-cli-interactive";
import {
  parseStage1CliArgs,
  readStage1CliDefaults,
} from "./stage1-cli-options";
import { createStage1PipelineDependencies } from "./stage1-pipeline";
import { readRepoSecurityInput } from "./stage1-repo-security";

const { outputRoot, stage1Args } = readFullPipelineArgs(process.argv.slice(2));
const options = await readOptions(stage1Args);
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const fullPipelineOutputRoot = outputRoot ?? ".makeademo-full-pipeline-runs";
const runId = createRunId();
const runDirectory = join(fullPipelineOutputRoot, runId);
const rawOpenCodeLog = createOpenCodeRawOutputLog({
  logPath: join(runDirectory, "opencode-raw-output.jsonl"),
});
const cliLogSink = createPrettyPipelineLogSink({
  write: (text) => process.stdout.write(text),
});

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for full pipeline runs.");
}

const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(options.daytonaSnapshot === undefined
    ? {}
    : { snapshot: options.daytonaSnapshot }),
  sandboxLogSinks: [cliLogSink],
});
const cliLogger = createPipelineEventLogger({
  base: { component: "full-pipeline-cli" },
  sinks: [cliLogSink],
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
  onStderr: (chunk) => {
    rawOpenCodeLog.write("stderr", chunk);
    process.stderr.write(chunk);
  },
  onStdout: (chunk) => {
    rawOpenCodeLog.write("stdout", chunk);
    openCodeOutput.write(chunk);
  },
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
    repoPreparationAgent: openCodeAgent,
    sandboxRunner: new DaytonaSandboxRunner(),
    scriptGenerationAgent: openCodeAgent,
  }),
  {
    logSinks: [cliLogSink],
    outputRoot: fullPipelineOutputRoot,
    prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
    rawOpenCodeLogPath: rawOpenCodeLog.logPath,
    reviewDraftComposite:
      openCodeAgent.reviewDraftComposite.bind(openCodeAgent),
    runId,
  },
).finally(async () => {
  await rawOpenCodeLog.close();
});

process.stdout.write("\nFull pipeline complete.\n");
process.stdout.write(
  `Final video: ${result.finalVideo.outputVideoPath ?? result.finalVideo.viewUrl}\n`,
);
process.stdout.write(`Generated script: ${result.scriptPath}\n`);
process.stdout.write(
  `Capture manifest: ${result.captureManifest.manifestPath}\n`,
);
process.stdout.write(`Composite manifest: ${result.finalVideo.manifestPath}\n`);
process.stdout.write(`Log: ${result.logPath}\n`);
process.stdout.write(`Raw OpenCode log: ${rawOpenCodeLog.logPath}\n`);
process.stdout.write(`Result JSON: ${result.resultPath}\n`);

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

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }

  return value;
}

function createRunId() {
  return `full-pipeline-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

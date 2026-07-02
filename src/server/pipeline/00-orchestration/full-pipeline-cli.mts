import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { DaytonaOpenCodeScriptGeneration } from "../../shared/integrations/agents/daytona-opencode-script-generation";
import { ensureOpenCodeProviderDaytonaSecret } from "../../shared/integrations/agents/opencode-provider-secrets";
import { createRepoPreparationAgent } from "../../shared/integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../../shared/integrations/sandbox/daytona-sandbox-runner";
import {
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../../shared/logging/pipeline-event-logger";
import { readDemoBrief } from "../01-context-gathering/intake/project-intake";
import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "../01-context-gathering/supporting-documents";
import { createDaytonaFreshCaptureStatePreparer } from "./fresh-capture-state";
import { runFullPipelineJob } from "./full-pipeline-runner";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { createOpenCodeRawOutputLog } from "./opencode-raw-output-log";
import { collectPreCaptureCliOptions } from "./pre-capture-cli-interactive";
import { parsePreCaptureCliArgs } from "./pre-capture-cli-options";
import { createPreCapturePipelineDependencies } from "./pre-capture-pipeline";
import { readRepoSecurityInput } from "./pre-capture-repo-security";

const { outputRoot, preCaptureArgs } = readFullPipelineArgs(
  process.argv.slice(2),
);
const options = await readOptions(preCaptureArgs);
const daytonaApiKey = process.env.DAYTONA_API_KEY;
const daytonaSnapshot = readOptionalEnv("MAKEADEMO_DAYTONA_SNAPSHOT");
const daytonaSubmittedCodeSnapshot = readOptionalEnv(
  "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
);
const fullPipelineOutputRoot = outputRoot ?? ".makeademo-full-pipeline-runs";
const runId = createRunId();
const runDirectory = join(fullPipelineOutputRoot, runId);
const rawOpenCodeLog = createOpenCodeRawOutputLog({
  logPath: join(runDirectory, "opencode-raw-output.jsonl"),
});
const cliLogSink = createPrettyPipelineLogSink({
  write: (text) => process.stdout.write(text),
});
const scriptGenerationRawOpenCodeLog = createOpenCodeRawOutputLog({
  logPath: join(runDirectory, "script-generation-opencode-raw-output.jsonl"),
});
scriptGenerationRawOpenCodeLog.write(
  "stdout",
  `${JSON.stringify({
    runDirectory,
    source: "makeademo",
    text: "Script Generation raw log initialized.",
    type: "text",
  })}\n`,
);

if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for full pipeline runs.");
}

const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
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
const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
  daytonaApiKey,
  providerID: options.providerID,
});
const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  modelID: options.modelID,
  onStderr: (chunk) => {
    rawOpenCodeLog.write("stderr", chunk);
    process.stderr.write(chunk);
  },
  onStdout: (chunk) => {
    rawOpenCodeLog.write("stdout", chunk);
    openCodeOutput.write(chunk);
  },
  providerID: options.providerID,
  providerSecretName,
});
const scriptGenerationAgent = new DaytonaOpenCodeScriptGeneration({
  modelID: options.modelID,
  onStderr: (chunk) => {
    rawOpenCodeLog.write("stderr", chunk);
    scriptGenerationRawOpenCodeLog.write("stderr", chunk);
    process.stderr.write(chunk);
  },
  onStdout: (chunk) => {
    rawOpenCodeLog.write("stdout", chunk);
    scriptGenerationRawOpenCodeLog.write("stdout", chunk);
    openCodeOutput.write(chunk);
  },
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
  createPreCapturePipelineDependencies({
    capturePathRepairer: scriptGenerationAgent,
    repoPreparationAgent,
    sandboxRunner: new DaytonaSandboxRunner(),
    scriptGenerationAgent,
  }),
  {
    logSinks: [cliLogSink],
    outputRoot: fullPipelineOutputRoot,
    prepareFreshCaptureState: createDaytonaFreshCaptureStatePreparer(),
    rawOpenCodeLogPath: rawOpenCodeLog.logPath,
    reviewDraftComposite: scriptGenerationAgent.reviewDraftComposite.bind(
      scriptGenerationAgent,
    ),
    runId,
    scriptGenerationRawOpenCodeLogPath: scriptGenerationRawOpenCodeLog.logPath,
  },
).finally(async () => {
  await Promise.all([
    rawOpenCodeLog.close(),
    scriptGenerationRawOpenCodeLog.close(),
  ]);
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
process.stdout.write(
  `Script Generation raw OpenCode log: ${scriptGenerationRawOpenCodeLog.logPath}\n`,
);
process.stdout.write(`Result JSON: ${result.resultPath}\n`);

function readFullPipelineArgs(args: string[]) {
  const preCaptureArgs: string[] = [];
  let outputRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--output-root") {
      outputRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    preCaptureArgs.push(arg);
  }

  return outputRoot === undefined
    ? { preCaptureArgs }
    : { outputRoot, preCaptureArgs };
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

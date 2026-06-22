import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DaytonaOpenCodeScriptGenerationAgent } from "../integrations/agents/daytona-opencode-script-generation-agent";
import { createDaytonaSdkPreparationWorkspaceHandle } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { createOpenCodeOutputStream } from "./opencode-output-stream";
import { createOpenCodeRawOutputLog } from "./opencode-raw-output-log";
import {
  type ScriptGenerationResumeFile,
  runScriptGenerationResume,
} from "./script-generation-resume-runner";

const options = readArgs(process.argv.slice(2));
const resume = readResumeFile(await readFile(options.resumePath, "utf8"));
const daytonaApiKey = process.env.DAYTONA_API_KEY;
if (daytonaApiKey === undefined || daytonaApiKey === "") {
  throw new Error("DAYTONA_API_KEY is required for Script Generation resume.");
}

const rawOpenCodeLog = createOpenCodeRawOutputLog({
  logPath: join(
    resume.runDirectory,
    "script-generation-opencode-raw-output.jsonl",
  ),
});
rawOpenCodeLog.write(
  "stdout",
  `${JSON.stringify({
    resumePath: options.resumePath,
    source: "makeademo",
    text: "Script Generation resume raw log initialized.",
    type: "text",
  })}\n`,
);
const openCodeOutput = createOpenCodeOutputStream({
  write: (text) => process.stdout.write(text),
});
const preparationWorkspace = await createDaytonaSdkPreparationWorkspaceHandle({
  apiKey: daytonaApiKey,
  sandboxId: resume.preparationWorkspaceId,
});
const scriptGenerationAgent = new DaytonaOpenCodeScriptGenerationAgent({
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

const result = await runScriptGenerationResume(
  resume,
  { preparationWorkspace, scriptGenerationAgent },
  { rawOpenCodeLogPath: rawOpenCodeLog.logPath },
).finally(async () => {
  await rawOpenCodeLog.close();
});

process.stdout.write("\nScript Generation complete.\n");
process.stdout.write(`Generated script: ${result.scriptPath}\n`);
process.stdout.write(`Raw OpenCode log: ${rawOpenCodeLog.logPath}\n`);
process.stdout.write(`Title: ${result.scriptPackage.title}\n`);
process.stdout.write(`Scenes: ${countScenes(result.scriptPackage)}\n`);

function readArgs(args: string[]) {
  let modelID = "gpt-5.5";
  let providerID = "openai";
  let resumePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--resume") {
      resumePath = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--model") {
      modelID = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      providerID = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown Script Generation resume option: ${arg}`);
  }

  if (resumePath === undefined) {
    throw new Error("scriptgen:run requires --resume <path>.");
  }

  return { modelID, providerID, resumePath };
}

function readResumeFile(contents: string): ScriptGenerationResumeFile {
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null) {
    throw new Error("Script Generation resume file must be a JSON object.");
  }
  const resume = value as Partial<ScriptGenerationResumeFile>;
  if (
    typeof resume.opencodeSessionID !== "string" ||
    typeof resume.preparationWorkspaceId !== "string" ||
    typeof resume.repoUrl !== "string" ||
    typeof resume.runDirectory !== "string" ||
    resume.demoBrief === undefined ||
    resume.preparationManifest === undefined
  ) {
    throw new Error(
      "Script Generation resume file is missing required fields.",
    );
  }

  return {
    demoBrief: resume.demoBrief,
    normalizedSupportingDocuments: resume.normalizedSupportingDocuments ?? [],
    opencodeSessionID: resume.opencodeSessionID,
    preparationManifest: resume.preparationManifest,
    preparationWorkspaceId: resume.preparationWorkspaceId,
    repoUrl: resume.repoUrl,
    runDirectory: resume.runDirectory,
  };
}

function readProviderApiKey(providerID: string): string {
  if (providerID !== "openai") {
    throw new Error(`Unsupported Script Generation provider: ${providerID}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY is required for OpenAI Script Generation.");
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

function countScenes(scriptPackage: { scenes: unknown[] }) {
  return scriptPackage.scenes.length;
}

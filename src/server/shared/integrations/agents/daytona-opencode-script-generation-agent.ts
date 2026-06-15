import type {
  AgenticScriptGenerationInput,
  ScriptGenerationAgent,
} from "../../../pipeline/05-script-generation/script-generation-agent.interface";
import { assertCaptureReadyScriptQuality } from "../../../pipeline/05-script-generation/script-package-quality";
import type { VideoScriptPackage } from "../../../pipeline/05-script-generation/video-script-package";
import { parseVideoScriptPackage } from "../../../pipeline/06-capture/video-script-package.schema";
import type { CaptureReadyVideoScriptPackage } from "../../../pipeline/06-capture/video-script-package.schema";
import { appendDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const makeADemoOpenCodeConfigDirectory = `${makeADemoArtifactDirectory}/opencode`;
const scriptPackagePath = `${makeADemoArtifactDirectory}/video-script-package.json`;

export type DaytonaOpenCodeScriptGenerationAgentOptions = {
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerApiKey: string;
  providerID: string;
  maxAttempts?: number;
};

export class DaytonaOpenCodeScriptGenerationAgent
  implements ScriptGenerationAgent
{
  private readonly maxAttempts: number;
  private readonly modelID: string;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly providerApiKey: string;
  private readonly providerID: string;

  constructor(options: DaytonaOpenCodeScriptGenerationAgentOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.modelID = options.modelID;
    this.onStderr = options.onStderr;
    this.onStdout = options.onStdout;
    this.providerApiKey = options.providerApiKey;
    this.providerID = options.providerID;
  }

  async generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<VideoScriptPackage> {
    let prompt = createScriptGenerationPrompt(input);
    let lastFailure =
      "Script Generation did not produce a valid script package.";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.writeStatus(
        `Script Generation OpenCode attempt ${attempt} starting in session ${input.opencodeSessionID}.`,
      );
      await removePreviousScriptPackage(input);
      const outputWrites: Promise<void>[] = [];
      const result = await input.preparationWorkspace.workspace.execute(
        createOpenCodeRunCommand({
          model: `${this.providerID}/${this.modelID}`,
          prompt,
          sessionID: input.opencodeSessionID,
        }),
        removeUndefinedOptions({
          env: createOpenCodeEnv({
            providerApiKey: this.providerApiKey,
            providerID: this.providerID,
          }),
          onStderr: (chunk) => {
            this.onStderr?.(chunk);
            outputWrites.push(
              appendDaytonaOpenCodeActivityLog(
                input.preparationWorkspace.workspace,
                {
                  attempt,
                  channel: "stderr",
                  raw: chunk,
                  stage: "script-generation",
                },
              ),
            );
          },
          onStdout: (chunk) => {
            this.onStdout?.(chunk);
            outputWrites.push(
              appendDaytonaOpenCodeActivityLog(
                input.preparationWorkspace.workspace,
                {
                  attempt,
                  channel: "stdout",
                  raw: chunk,
                  stage: "script-generation",
                },
              ),
            );
          },
        }),
      );
      await Promise.all(outputWrites);

      if (result.exitCode !== 0) {
        lastFailure = `OpenCode Script Generation exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`;
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} failed before artifact validation.`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        continue;
      }

      const artifact = await readScriptPackageArtifact(input);
      if (artifact.status === "failed") {
        lastFailure = artifact.reason;
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} did not produce a readable artifact: ${artifact.reason}`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        continue;
      }

      try {
        parseVideoScriptPackage(artifact.value);
        assertCaptureReadyScriptQuality(
          artifact.value as CaptureReadyVideoScriptPackage,
        );
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced a valid script package.`,
        );
        return attachPipelineMetadata(
          artifact.value as CaptureReadyVideoScriptPackage,
          input,
        );
      } catch (error) {
        lastFailure = readErrorMessage(error);
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced an invalid artifact: ${lastFailure}`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
      }
    }

    throw new Error(lastFailure);
  }

  private writeStatus(message: string): void {
    this.onStdout?.(
      `${JSON.stringify({
        source: "makeademo",
        text: message,
        type: "text",
      })}\n`,
    );
  }
}

async function removePreviousScriptPackage(
  input: AgenticScriptGenerationInput,
): Promise<void> {
  await input.preparationWorkspace.workspace.execute(
    `rm -f ${shellQuote(scriptPackagePath)}`,
  );
}

async function readScriptPackageArtifact(
  input: AgenticScriptGenerationInput,
): Promise<
  { status: "succeeded"; value: unknown } | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(scriptPackagePath)}; then node -e ${shellQuote(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(scriptPackagePath)}, "utf8"))`)}; else exit 1; fi`,
  );
  if (result.exitCode !== 0) {
    return {
      reason: `OpenCode did not write ${scriptPackagePath}.`,
      status: "failed",
    };
  }

  try {
    return { status: "succeeded", value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      reason: `Script package artifact is not valid JSON: ${readErrorMessage(error)}`,
      status: "failed",
    };
  }
}

function attachPipelineMetadata(
  scriptPackage: CaptureReadyVideoScriptPackage,
  input: AgenticScriptGenerationInput,
): VideoScriptPackage {
  const exploration = {
    assumptions: input.preparationManifest.assumptions,
    productSurfaces: input.preparationManifest.scriptGenerationContext,
    summary: input.preparationManifest.setupSummary,
  };
  const demoPlan = {
    featureOrder: input.demoBrief.keyProductFeatures,
    narrative: scriptPackage.title,
    risks: input.preparationManifest.risks,
  };

  return {
    ...scriptPackage,
    assumptions: exploration.assumptions,
    demoPlan,
    exploration,
    validation: input.validation,
  };
}

function createOpenCodeRunCommand(input: {
  model: string;
  prompt: string;
  sessionID: string;
}): string {
  return [
    "opencode run",
    "--dangerously-skip-permissions",
    "--format json",
    "--dir /workspace",
    `--session ${shellQuote(input.sessionID)}`,
    `--model ${shellQuote(input.model)}`,
    shellQuote(input.prompt),
  ].join(" ");
}

function removeUndefinedOptions(input: {
  env: Record<string, string>;
  onStderr: ((chunk: string) => void) | undefined;
  onStdout: ((chunk: string) => void) | undefined;
}) {
  return {
    env: input.env,
    ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
    ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
  };
}

function createOpenCodeEnv(input: {
  providerApiKey: string;
  providerID: string;
}): Record<string, string> {
  return {
    [readProviderApiKeyEnvName(input.providerID)]: input.providerApiKey,
    OPENCODE_CONFIG_DIR: makeADemoOpenCodeConfigDirectory,
    OPENCODE_ENABLE_EXA: "1",
  };
}

function readProviderApiKeyEnvName(providerID: string): string {
  if (providerID === "openai") {
    return "OPENAI_API_KEY";
  }

  throw new Error(`Unsupported Script Generation provider: ${providerID}`);
}

function createScriptGenerationPrompt(
  input: AgenticScriptGenerationInput,
): string {
  return [
    "# MakeADemo Script Generation",
    "",
    "Repo Preparation and Project Validation have passed in this same OpenCode session.",
    "The prepared app is now frozen: do not modify application source, package files, lockfiles, or runtime setup.",
    `Write exactly one artifact: ${scriptPackagePath}.`,
    "",
    "## Goal",
    "Explore the validated prepared repo enough to create a capture-ready Video Script Package with real browser interactions for the requested features.",
    "Use your existing session context from preparation, but inspect relevant routes, components, fixtures, and docs when needed.",
    "",
    "## Hard Requirements",
    "- Output JSON matching the capture-ready Video Script Package schema.",
    "- Every demonstrated feature must have a playwright-recording scene.",
    "- Playwright scripts must use the provided `baseUrl` variable, not hardcoded preview URLs.",
    "- Demonstrate real user flows with route changes, clicks, fills, presses, selectOption calls, or feature-specific assertions.",
    "- Do not emit placeholder scripts that only load the page, wait, smoke-check body text, or set inert DOM attributes.",
    "- Keep scripts deterministic and short enough for capture.",
    "- Do not call Repo Preparation tools. Do not request dependency installs. Do not run backend validation.",
    "",
    "## Artifact Path",
    scriptPackagePath,
    "",
    "## Pipeline Context",
    "```json",
    JSON.stringify(
      {
        demoBrief: input.demoBrief,
        normalizedSupportingDocuments: input.normalizedSupportingDocuments,
        preparationManifest: input.preparationManifest,
        repoUrl: input.repoUrl,
        validation: input.validation,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function createScriptGenerationRepairPrompt(reason: string): string {
  return [
    "# MakeADemo Script Generation Repair",
    "",
    `The previous Script Generation output was rejected: ${reason}`,
    "Repair the script package and overwrite `/workspace/.makeademo/video-script-package.json`.",
    "Do not modify app source. Include real user interactions and feature-specific assertions.",
  ].join("\n");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

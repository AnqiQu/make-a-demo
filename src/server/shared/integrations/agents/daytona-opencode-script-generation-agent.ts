import { readPreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type {
  AgenticScriptGenerationInput,
  ScriptGenerationAgent,
} from "../../../pipeline/04-script-generation/script-generation-agent.interface";
import { assertCaptureReadyScriptQuality } from "../../../pipeline/04-script-generation/script-package-quality";
import type { VideoScriptPackage } from "../../../pipeline/04-script-generation/video-script-package";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
  CapturePathRepairer,
} from "../../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import { parseVideoScriptPackage } from "../../../pipeline/06-footage-capture/video-script-package.schema";
import type { CaptureReadyVideoScriptPackage } from "../../../pipeline/06-footage-capture/video-script-package.schema";
import { writeDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const makeADemoOpenCodeConfigDirectory = `${makeADemoArtifactDirectory}/opencode`;
const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
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
  implements CapturePathRepairer, ScriptGenerationAgent
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
      await writeScriptGenerationSandboxLog(input, {
        attempt,
        event: "script-generation.opencode-attempt.started",
        opencodeSessionID: input.opencodeSessionID,
      });
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
              writeDaytonaOpenCodeActivityLog(
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
              writeDaytonaOpenCodeActivityLog(
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
        await writeScriptGenerationSandboxLog(input, {
          attempt,
          event: "script-generation.opencode-attempt.failed",
          exitCode: result.exitCode,
          reason: lastFailure,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} failed before artifact validation.`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        continue;
      }

      const artifact = await readScriptPackageArtifact(input);
      if (artifact.status === "failed") {
        lastFailure = artifact.reason;
        await writeScriptGenerationSandboxLog(input, {
          attempt,
          event: "script-generation.artifact.missing",
          reason: lastFailure,
        });
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
        await writeScriptGenerationSandboxLog(input, {
          attempt,
          event: "script-generation.script-package.succeeded",
          scriptId: (artifact.value as CaptureReadyVideoScriptPackage).scriptId,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced a valid script package.`,
        );
        return attachPipelineMetadata(
          artifact.value as CaptureReadyVideoScriptPackage,
          input,
        );
      } catch (error) {
        lastFailure = readErrorMessage(error);
        await writeScriptGenerationSandboxLog(input, {
          attempt,
          event: "script-generation.script-package.invalid",
          reason: lastFailure,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced an invalid artifact: ${lastFailure}`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
      }
    }

    throw new Error(lastFailure);
  }

  async repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult> {
    if (input.opencodeSessionID === undefined) {
      throw new Error("Capture Path repair requires an OpenCode session ID.");
    }
    if (input.preparationWorkspace === undefined) {
      throw new Error("Capture Path repair requires the prepared workspace.");
    }
    const preparationWorkspace = input.preparationWorkspace;

    await writeRepairSandboxLog(input, {
      attempt: input.attempt,
      event: "capture-path-repair.opencode-attempt.started",
      failedSceneId: input.failure.failedSceneId,
      opencodeSessionID: input.opencodeSessionID,
    });
    this.writeStatus(
      `Capture Path repair attempt ${input.attempt} starting in session ${input.opencodeSessionID}.`,
    );

    const outputWrites: Promise<void>[] = [];
    const result = await preparationWorkspace.workspace.execute(
      createOpenCodeRunCommand({
        model: `${this.providerID}/${this.modelID}`,
        prompt: createCapturePathRepairPrompt(input),
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
            writeDaytonaOpenCodeActivityLog(preparationWorkspace.workspace, {
              attempt: input.attempt,
              channel: "stderr",
              raw: chunk,
              stage: "capture-path-repair",
            }),
          );
        },
        onStdout: (chunk) => {
          this.onStdout?.(chunk);
          outputWrites.push(
            writeDaytonaOpenCodeActivityLog(preparationWorkspace.workspace, {
              attempt: input.attempt,
              channel: "stdout",
              raw: chunk,
              stage: "capture-path-repair",
            }),
          );
        },
      }),
    );
    await Promise.all(outputWrites);

    if (result.exitCode !== 0) {
      const reason = `OpenCode Capture Path repair exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`;
      await writeRepairSandboxLog(input, {
        attempt: input.attempt,
        event: "capture-path-repair.opencode-attempt.failed",
        exitCode: result.exitCode,
        reason,
      });
      throw new Error(reason);
    }

    const [manifestArtifact, scriptArtifact] = await Promise.all([
      readPreparationManifestArtifact({ preparationWorkspace }),
      readScriptPackageArtifact({ preparationWorkspace }),
    ]);
    if (scriptArtifact.status === "failed") {
      await writeRepairSandboxLog(input, {
        attempt: input.attempt,
        event: "capture-path-repair.artifact.missing",
        reason: scriptArtifact.reason,
      });
      throw new Error(scriptArtifact.reason);
    }

    const preparationManifest =
      manifestArtifact.status === "succeeded"
        ? manifestArtifact.value
        : input.preparationManifest;

    try {
      parseVideoScriptPackage(scriptArtifact.value);
      assertCaptureReadyScriptQuality(
        scriptArtifact.value as CaptureReadyVideoScriptPackage,
      );
    } catch (error) {
      const reason = readErrorMessage(error);
      await writeRepairSandboxLog(input, {
        attempt: input.attempt,
        event: "capture-path-repair.script-package.invalid",
        reason,
      });
      throw new Error(reason);
    }

    await writeRepairSandboxLog(input, {
      attempt: input.attempt,
      event: "capture-path-repair.script-package.succeeded",
      scriptId: (scriptArtifact.value as CaptureReadyVideoScriptPackage)
        .scriptId,
    });
    this.writeStatus(
      `Capture Path repair attempt ${input.attempt} produced a script package for revalidation.`,
    );

    return {
      preparationManifest,
      videoScriptPackage: attachPipelineMetadata(
        scriptArtifact.value as CaptureReadyVideoScriptPackage,
        {
          demoBrief: {
            keyProductFeatures: input.videoScriptPackage.demoPlan.featureOrder,
          },
          normalizedSupportingDocuments: [],
          opencodeSessionID: input.opencodeSessionID,
          preparationManifest,
          preparationWorkspace,
          repoUrl: input.repoUrl,
        },
      ),
    };
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

async function writeRepairSandboxLog(
  input: Parameters<CapturePathRepairer["repairCapturePathFailure"]>[0],
  entry: Record<string, unknown>,
): Promise<void> {
  await input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...entry,
    repoUrl: input.repoUrl,
    stage: "capture-path-repair",
    workspaceId: input.preparationManifest.workspaceId,
  });
}

async function writeScriptGenerationSandboxLog(
  input: AgenticScriptGenerationInput,
  entry: Record<string, unknown>,
): Promise<void> {
  await input.preparationWorkspace.workspace.writeSandboxLog?.({
    ...entry,
    repoUrl: input.repoUrl,
    stage: "script-generation",
    workspaceId: input.preparationManifest.workspaceId,
  });
}

async function removePreviousScriptPackage(
  input: AgenticScriptGenerationInput,
): Promise<void> {
  await input.preparationWorkspace.workspace.execute(
    `rm -f ${shellQuote(scriptPackagePath)}`,
  );
}

async function readScriptPackageArtifact(
  input: Pick<AgenticScriptGenerationInput, "preparationWorkspace">,
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

async function readPreparationManifestArtifact(input: {
  preparationWorkspace: AgenticScriptGenerationInput["preparationWorkspace"];
}): Promise<
  | { status: "succeeded"; value: ReturnType<typeof readPreparationManifest> }
  | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(preparationManifestPath)}; then node -e ${shellQuote(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(preparationManifestPath)}, "utf8"))`)}; else exit 1; fi`,
  );
  if (result.exitCode !== 0) {
    return {
      reason: `OpenCode did not write ${preparationManifestPath}.`,
      status: "failed",
    };
  }

  try {
    return {
      status: "succeeded",
      value: readPreparationManifest(JSON.parse(result.stdout)),
    };
  } catch (error) {
    return {
      reason: `Preparation Manifest artifact is not valid: ${readErrorMessage(error)}`,
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
    "Repo Preparation has produced a deterministic prepared workspace in this same OpenCode session.",
    "Do not modify application source, package files, lockfiles, or runtime setup during Script Generation.",
    `Write exactly one artifact: ${scriptPackagePath}.`,
    "",
    "## Goal",
    "Explore the prepared repo enough to create a Video Script Package with real browser interactions for the requested features.",
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
    createScriptPackageSchemaPrompt(),
    "",
    "## Pipeline Context",
    "```json",
    JSON.stringify(
      {
        demoBrief: input.demoBrief,
        normalizedSupportingDocuments: input.normalizedSupportingDocuments,
        preparationManifest: input.preparationManifest,
        repoUrl: input.repoUrl,
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
    "",
    createScriptPackageSchemaPrompt(),
  ].join("\n");
}

function createCapturePathRepairPrompt(
  input: Parameters<CapturePathRepairer["repairCapturePathFailure"]>[0],
): string {
  return [
    "# MakeADemo Capture Path Repair",
    "",
    "Capture Path Validation failed for the Video Script Package you generated.",
    "Repair the prepared workspace, the Video Script Package, or both. The backend will rerun full Capture Path Validation after this attempt.",
    "",
    "## Hard Requirements",
    `- Overwrite ${scriptPackagePath} with the repaired Video Script Package JSON before finishing.`,
    `- If you change the prepared app command, URL, assumptions, risks, or workspace-change summary, update ${preparationManifestPath}.`,
    "- Keep Browser Actions deterministic and use only the provided `baseUrl` variable in Playwright scripts.",
    "- Do not run final Footage Capture. You may run fast local checks if useful.",
    "",
    "## Failure Evidence",
    "```json",
    truncateForPrompt(
      JSON.stringify(
        {
          attempt: input.attempt,
          failure: input.failure,
          currentScriptId: input.videoScriptPackage.scriptId,
        },
        null,
        2,
      ),
    ),
    "```",
    "",
    "## Current Preparation Manifest",
    "```json",
    JSON.stringify(input.preparationManifest, null, 2),
    "```",
    "",
    "## Current Video Script Package",
    "```json",
    truncateForPrompt(JSON.stringify(input.videoScriptPackage, null, 2)),
    "```",
    "",
    createScriptPackageSchemaPrompt(),
  ].join("\n");
}

function createScriptPackageSchemaPrompt(): string {
  return [
    "## Required Video Script Package Shape",
    "The artifact must be one JSON object with every required top-level field present.",
    "Use this exact shape, replacing example strings and scripts with repo-specific content:",
    "```json",
    JSON.stringify(
      {
        estimatedDurationSeconds: 18,
        format: "16:9",
        scriptId: "script_unique_demo_id",
        sections: [
          {
            id: "section_main_flow",
            scenes: [
              {
                description:
                  "Show the requested feature with real UI interactions.",
                durationSeconds: 6,
                events: [
                  "Navigate to the prepared app",
                  "Interact with the feature",
                  "Assert the feature result is visible",
                ],
                id: "scene_requested_feature",
                playwrightSceneId: "scene_requested_feature",
                playwrightScript:
                  "await page.goto(baseUrl);\nawait page.getByRole('button', { name: /example/i }).click();\nawait expect(page.getByText(/result/i)).toBeVisible();",
                type: "playwright-recording",
              },
            ],
            title: "Main flow",
          },
        ],
        title: "Concise demo title",
        version: 1,
      },
      null,
      2,
    ),
    "```",
    "Top-level `scriptId`, `title`, `format`, `version`, `estimatedDurationSeconds`, and non-empty `sections` are mandatory on every attempt.",
    'Each playwright scene must include `id`, `playwrightSceneId`, `type: "playwright-recording"`, `description`, positive `durationSeconds`, non-empty `events`, and non-empty `playwrightScript`.',
  ].join("\n");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateForPrompt(value: string): string {
  const maxLength = 20_000;
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

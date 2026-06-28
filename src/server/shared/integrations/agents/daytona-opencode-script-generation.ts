import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { readPreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { DemoScriptPackage } from "../../../pipeline/04-script-generation/demo-script-package";
import type {
  AgenticScriptGenerationInput,
  ScriptGenerationAgent,
} from "../../../pipeline/04-script-generation/script-generation-agent.interface";
import { assertCaptureReadyScriptQuality } from "../../../pipeline/04-script-generation/script-package-quality";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
  CapturePathRepairer,
} from "../../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import {
  type DemoScript,
  parseDemoScript,
} from "../../../pipeline/06-footage-capture/demo-script.schema";
import type {
  DraftCompositeReviewDecision,
  DraftCompositeReviewInput,
} from "../../pipeline-runner/full-pipeline-runner";
import { writeDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const makeADemoOpenCodeConfigDirectory = `${makeADemoArtifactDirectory}/opencode`;
const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
const demoScriptPath = `${makeADemoArtifactDirectory}/demo-script.json`;
const draftCompositeReviewPath = `${makeADemoArtifactDirectory}/draft-composite-review.json`;
const draftReviewDirectory = `${makeADemoArtifactDirectory}/draft-review`;

export type DaytonaOpenCodeScriptGenerationOptions = {
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerApiKey: string;
  providerID: string;
  maxAttempts?: number;
};

export class DaytonaOpenCodeScriptGeneration
  implements CapturePathRepairer, ScriptGenerationAgent
{
  private readonly maxAttempts: number;
  private readonly modelID: string;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly providerApiKey: string;
  private readonly providerID: string;

  constructor(options: DaytonaOpenCodeScriptGenerationOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.modelID = options.modelID;
    this.onStderr = options.onStderr;
    this.onStdout = options.onStdout;
    this.providerApiKey = options.providerApiKey;
    this.providerID = options.providerID;
  }

  async generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScriptPackage> {
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
        const retryReason = `OpenCode Script Generation exited with ${result.exitCode}.`;
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
        await writeScriptGenerationRetryLog(input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: retryReason,
        });
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
        await writeScriptGenerationRetryLog(input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: lastFailure,
        });
        continue;
      }

      try {
        const demoScript = parseDemoScript(artifact.value);
        assertCaptureReadyScriptQuality(demoScript);
        await writeScriptGenerationSandboxLog(input, {
          attempt,
          event: "script-generation.script-package.succeeded",
          scriptId: demoScript.scriptId,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced a valid Demo Script.`,
        );
        return attachPipelineMetadata(demoScript, input);
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
        await writeScriptGenerationRetryLog(input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: lastFailure,
        });
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
      const demoScript = parseDemoScript(scriptArtifact.value);
      assertCaptureReadyScriptQuality(demoScript);
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
      event: "capture-path-repair.demo-script.succeeded",
      scriptId: parseDemoScript(scriptArtifact.value).scriptId,
    });
    this.writeStatus(
      `Capture Path repair attempt ${input.attempt} produced a Demo Script for revalidation.`,
    );

    return {
      preparationManifest,
      demoScriptPackage: attachPipelineMetadata(
        parseDemoScript(scriptArtifact.value),
        {
          demoBrief: {
            keyProductFeatures: input.demoScriptPackage.demoPlan.featureOrder,
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

  async reviewDraftComposite(
    input: DraftCompositeReviewInput,
  ): Promise<DraftCompositeReviewDecision> {
    if (input.opencodeSessionID === undefined) {
      throw new Error(
        "Draft Composite review requires an OpenCode session ID.",
      );
    }
    if (input.preparationWorkspace === undefined) {
      throw new Error(
        "Draft Composite review requires the prepared workspace.",
      );
    }
    const preparationWorkspace = input.preparationWorkspace;

    await uploadDraftReviewFiles(input);
    const outputWrites: Promise<void>[] = [];
    const result = await preparationWorkspace.workspace.execute(
      createOpenCodeRunCommand({
        model: `${this.providerID}/${this.modelID}`,
        prompt: createDraftCompositeReviewPrompt(input),
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
              stage: "draft-composite-review",
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
              stage: "draft-composite-review",
            }),
          );
        },
      }),
    );
    await Promise.all(outputWrites);

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenCode Draft Composite review exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`,
      );
    }

    const artifact = await preparationWorkspace.workspace.execute(
      `cat ${shellQuote(draftCompositeReviewPath)}`,
    );
    if (artifact.exitCode !== 0) {
      throw new Error(
        `OpenCode Draft Composite review did not write ${draftCompositeReviewPath}: ${artifact.stderr}`,
      );
    }

    return parseDraftCompositeReviewDecision(artifact.stdout);
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

async function uploadDraftReviewFiles(input: DraftCompositeReviewInput) {
  if (input.preparationWorkspace === undefined) {
    return;
  }

  const paths = [
    input.derivedEvidence.rawDraftCompositePath,
    input.derivedEvidence.rawTakePath,
    ...input.derivedEvidence.contactSheetPaths,
    ...input.derivedEvidence.sampledFramePaths,
  ].filter((path): path is string => path !== undefined);
  const files = [];
  for (const sourcePath of paths) {
    if (await exists(sourcePath)) {
      files.push({
        destinationPath: `${draftReviewDirectory}/${basename(sourcePath)}`,
        sourcePath,
      });
    }
  }

  if (files.length > 0) {
    await input.preparationWorkspace.workspace.uploadFiles(files);
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseDraftCompositeReviewDecision(
  value: string,
): DraftCompositeReviewDecision {
  const record = JSON.parse(value) as Record<string, unknown>;
  if (record.decision === "accept") {
    return typeof record.reason === "string"
      ? { decision: "accept", reason: record.reason }
      : { decision: "accept" };
  }

  if (
    record.decision === "repair" &&
    typeof record.reason === "string" &&
    (record.repairScope === "demo-script" || record.repairScope === "workspace")
  ) {
    return {
      decision: "repair",
      reason: record.reason,
      repairScope: record.repairScope,
    };
  }

  throw new Error(
    "Draft Composite review artifact must contain accept or repair decision.",
  );
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

async function writeScriptGenerationRetryLog(
  input: AgenticScriptGenerationInput,
  retry: { attempt: number; maxAttempts: number; reason: string },
): Promise<void> {
  if (retry.attempt >= retry.maxAttempts) {
    return;
  }

  await writeScriptGenerationSandboxLog(input, {
    attempt: retry.attempt,
    event: "script-generation.retrying",
    nextAttempt: retry.attempt + 1,
    reason: retry.reason,
  });
}

async function removePreviousScriptPackage(
  input: AgenticScriptGenerationInput,
): Promise<void> {
  await input.preparationWorkspace.workspace.execute(
    `rm -f ${shellQuote(demoScriptPath)}`,
  );
}

async function readScriptPackageArtifact(
  input: Pick<AgenticScriptGenerationInput, "preparationWorkspace">,
): Promise<
  { status: "succeeded"; value: unknown } | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(demoScriptPath)}; then node -e ${shellQuote(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(demoScriptPath)}, "utf8"))`)}; else exit 1; fi`,
  );
  if (result.exitCode !== 0) {
    return {
      reason: `OpenCode did not write ${demoScriptPath}.`,
      status: "failed",
    };
  }

  try {
    return { status: "succeeded", value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      reason: `Demo Script artifact is not valid JSON: ${readErrorMessage(error)}`,
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
  scriptPackage: DemoScript,
  input: AgenticScriptGenerationInput,
): DemoScriptPackage {
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
    `Write exactly one artifact: ${demoScriptPath}.`,
    "",
    "## Goal",
    "Explore the prepared repo enough to create a Demo Script with one continuous Playwright flow for the requested features.",
    "Use your existing session context from preparation, but inspect relevant routes, components, fixtures, and docs when needed.",
    "",
    "## Hard Requirements",
    "- Output JSON matching the capture-ready Demo Script schema.",
    "- The demoPlaywrightScript must import `{ setup, scene }` from `./makeademo-capture-sdk`.",
    "- Every demonstrated feature must have a declared Scene with an expected visible outcome.",
    "- Playwright scripts must use the provided `baseUrl` variable, not hardcoded preview URLs.",
    "- Demonstrate real user flows with route changes, clicks, fills, presses, selectOption calls, or feature-specific assertions.",
    "- Put login, seeding, navigation, and setup outside on-camera Scenes unless that setup is the feature being demonstrated.",
    "- Do not provide Scene durations. Timing comes from Footage Capture.",
    "- Do not use Playwright `recordVideo`, custom marker writers, or agent-authored timestamps.",
    "- Do not emit placeholder scripts that only load the page, wait, smoke-check body text, or set inert DOM attributes.",
    "- Keep scripts deterministic and short enough for capture.",
    "- Do not call Repo Preparation tools. Do not request dependency installs. Do not run backend validation.",
    "",
    "## Artifact Path",
    demoScriptPath,
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
    `Repair the Demo Script and overwrite ${demoScriptPath}.`,
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
    "Capture Path Validation failed for the Demo Script you generated.",
    "Repair the prepared workspace, the Demo Script, or both. The backend will rerun full Capture Path Validation after this attempt.",
    "",
    "## Hard Requirements",
    `- Overwrite ${demoScriptPath} with the repaired Demo Script JSON before finishing.`,
    "- The demoPlaywrightScript must import `{ setup, scene }` from `./makeademo-capture-sdk`.",
    `- If you change the prepared app command, URL, assumptions, risks, or workspace-change summary, update ${preparationManifestPath}.`,
    "- Keep Playwright interactions deterministic and use only the provided `baseUrl` variable in Playwright scripts.",
    "- Do not add Scene durations, raw video recording, custom marker writers, or timestamps.",
    "- Do not run final Footage Capture. You may run fast local checks if useful.",
    "",
    "## Failure Evidence",
    "```json",
    truncateForPrompt(
      JSON.stringify(
        {
          attempt: input.attempt,
          failure: input.failure,
          currentScriptId: input.demoScriptPackage.scriptId,
        },
        null,
        2,
      ),
    ),
    "```",
    input.failure.diagnosticsLogPath === undefined
      ? "No Capture Path diagnostics log path was returned. Use the structured failure evidence above."
      : `Before editing, read the Capture Path diagnostics log at ${input.failure.diagnosticsLogPath}. It contains verbose validation stdout/stderr excerpts and is written inside the prepared workspace for agent inspection.`,
    "",
    "## Current Preparation Manifest",
    "```json",
    JSON.stringify(input.preparationManifest, null, 2),
    "```",
    "",
    "## Current Demo Script",
    "```json",
    truncateForPrompt(JSON.stringify(input.demoScriptPackage, null, 2)),
    "```",
    "",
    createScriptPackageSchemaPrompt(),
  ].join("\n");
}

function createDraftCompositeReviewPrompt(
  input: DraftCompositeReviewInput,
): string {
  return [
    "# MakeADemo Draft Composite Review",
    "",
    "Review the Draft Composite generated from the Demo Script in this same OpenCode session.",
    "Use your preparation and Script Generation context, plus the structured evidence below, to decide whether the draft is a good demo video.",
    `Write exactly one JSON artifact to ${draftCompositeReviewPath}.`,
    "",
    "## Required Decision Shape",
    "Accept:",
    "```json",
    JSON.stringify(
      { decision: "accept", reason: "Concise acceptance reason." },
      null,
      2,
    ),
    "```",
    "Repair:",
    "```json",
    JSON.stringify(
      {
        decision: "repair",
        reason: "Concise repair reason.",
        repairScope: "demo-script",
      },
      null,
      2,
    ),
    "```",
    "Use repairScope `demo-script` for script pacing, Scene boundaries, visible outcomes, overlays, music intent, or narrative issues.",
    "Use repairScope `workspace` only when the prepared app or deterministic demo data must change.",
    "Do not request repair only for ffmpeg/contact-sheet/sampled-frame findings unless they reveal an actual demo quality issue. Deterministic quality gates are already supplied separately.",
    "",
    "## Available Local Evidence In Workspace",
    `${draftReviewDirectory} contains uploaded draft/review files when they were available from the backend host.`,
    "You may use shell tools such as ffmpeg/ffprobe against those files if useful.",
    "",
    "## Structured Evidence",
    "```json",
    truncateForPrompt(
      JSON.stringify(
        {
          attempt: input.attempt,
          captureManifest: input.captureManifest,
          derivedEvidence: input.derivedEvidence,
          draftComposite: input.draftComposite,
          scriptId: input.scriptPackage.scriptId,
          title: input.scriptPackage.title,
        },
        null,
        2,
      ),
    ),
    "```",
  ].join("\n");
}

function createScriptPackageSchemaPrompt(): string {
  return [
    "## Required Demo Script Shape",
    "The artifact must be one JSON object with every required top-level field present.",
    "Use this exact shape, replacing example strings and scripts with repo-specific content:",
    "```json",
    JSON.stringify(
      {
        audio: { enabled: true, music: { id: "clean" } },
        demoPlaywrightScript:
          "import { setup, scene } from './makeademo-capture-sdk';\n\nawait setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });\nawait scene('scene_requested_feature', async ({ page, expect }) => {\n  await page.getByRole('button', { name: /example/i }).click();\n  await expect(page.getByText(/result/i)).toBeVisible();\n});",
        format: "16:9",
        presentation: {
          music: { enabled: true, trackId: "clean" },
          textOverlays: [
            {
              content: "Show the requested feature",
              font: "Inter",
              position: "bottom-left",
              sceneId: "scene_requested_feature",
              size: "medium",
            },
          ],
          transitions: [],
        },
        scenes: [
          {
            description:
              "Show the requested feature with real UI interactions.",
            expectedVisibleOutcome: "The feature result is visible.",
            id: "scene_requested_feature",
          },
        ],
        scriptId: "script_unique_demo_id",
        title: "Concise demo title",
        version: 1,
      },
      null,
      2,
    ),
    "```",
    "Top-level `scriptId`, `title`, `format`, `version`, `demoPlaywrightScript`, non-empty `scenes`, and `presentation` are mandatory on every attempt.",
    "Each Scene must include `id`, `description`, and `expectedVisibleOutcome`. Do not include `durationSeconds` on recorded Scenes.",
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

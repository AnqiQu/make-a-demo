import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { readPreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
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
import type { CaptureManifest } from "../../../pipeline/06-footage-capture/capture-scenes";
import { assertDemoScriptCaptureSdkContract } from "../../../pipeline/06-footage-capture/capture-sdk-contract";
import {
  type DemoScript,
  parseDemoScript,
} from "../../../pipeline/06-footage-capture/demo-script.schema";
import type { CompositedVideoManifest } from "../../../pipeline/07-compositing/composite-video";
import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../logging/pipeline-event-logger";
import { writeDaytonaOpenCodeActivityLog } from "./daytona-opencode-activity-log";

const makeADemoArtifactDirectory = "/workspace/.makeademo";
const makeADemoOpenCodeConfigDirectory = "/tmp/makeademo/opencode";
const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
const demoScriptPath = `${makeADemoArtifactDirectory}/demo-script.json`;
const draftCompositeReviewPath = `${makeADemoArtifactDirectory}/draft-composite-review.json`;
const draftReviewDirectory = `${makeADemoArtifactDirectory}/draft-review`;
const postRepairArtifactReadTimeoutMs = 60_000;

export type DaytonaOpenCodeScriptGenerationOptions = {
  /**
   * Receives non-fatal Script Generation and Capture Path Repair infrastructure
   * events. Implementations must not turn best-effort sandbox audit-log mirror
   * failures into pipeline failures.
   */
  logger?: PipelineEventLogger;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerID: string;
  maxAttempts?: number;
  postRepairArtifactReadTimeoutMs?: number;
};

export type DraftCompositeReviewDecision =
  | { decision: "accept"; reason?: string }
  | {
      decision: "repair";
      reason: string;
      repairScope: "demo-script" | "workspace";
    };

export type DraftCompositeReviewInput = {
  attempt: number;
  captureManifest: CaptureManifest;
  derivedEvidence: {
    contactSheetPaths: string[];
    draftDurationSeconds?: number;
    ffmpegFindings: string[];
    markerSummary: Array<Record<string, unknown>>;
    qualityFindings: string[];
    rawDraftCompositePath?: string;
    rawTakePath?: string;
    sampledFramePaths: string[];
  };
  draftComposite: CompositedVideoManifest;
  opencodeSessionID?: string;
  preparationWorkspace?: PreparationWorkspaceHandle;
  scriptPackage: DemoScriptPackage;
};

class DaytonaOpenCodeSessionRunner {
  private readonly modelID: string;
  private readonly onStderr: ((chunk: string) => void) | undefined;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly providerID: string;

  constructor(options: DaytonaOpenCodeScriptGenerationOptions) {
    this.modelID = options.modelID;
    this.onStderr = options.onStderr;
    this.onStdout = options.onStdout;
    this.providerID = options.providerID;
  }

  async run(input: {
    attempt: number;
    prompt: string;
    sessionID: string;
    stage:
      | "capture-path-repair"
      | "draft-composite-review"
      | "script-generation";
    workspace: PreparationWorkspace;
  }) {
    const outputWrites: Promise<void>[] = [];
    const result = await input.workspace.execute(
      createOpenCodeRunCommand({
        model: `${this.providerID}/${this.modelID}`,
        prompt: input.prompt,
        sessionID: input.sessionID,
      }),
      removeUndefinedOptions({
        env: createOpenCodeEnv(),
        onStderr: (chunk) => {
          this.onStderr?.(chunk);
          outputWrites.push(
            writeDaytonaOpenCodeActivityLog(input.workspace, {
              attempt: input.attempt,
              channel: "stderr",
              raw: chunk,
              stage: input.stage,
            }),
          );
        },
        onStdout: (chunk) => {
          this.onStdout?.(chunk);
          outputWrites.push(
            writeDaytonaOpenCodeActivityLog(input.workspace, {
              attempt: input.attempt,
              channel: "stdout",
              raw: chunk,
              stage: input.stage,
            }),
          );
        },
      }),
    );
    await Promise.allSettled(outputWrites);
    return result;
  }
}

export class DaytonaOpenCodeScriptGeneration
  implements CapturePathRepairer, ScriptGenerationAgent
{
  private readonly logger: PipelineEventLogger;
  private readonly maxAttempts: number;
  private readonly onStdout: ((chunk: string) => void) | undefined;
  private readonly openCode: DaytonaOpenCodeSessionRunner;
  private readonly postRepairArtifactReadTimeoutMs: number;

  constructor(options: DaytonaOpenCodeScriptGenerationOptions) {
    this.logger = options.logger ?? createScriptGenerationLogger();
    this.maxAttempts = options.maxAttempts ?? 3;
    this.onStdout = options.onStdout;
    this.openCode = new DaytonaOpenCodeSessionRunner(options);
    this.postRepairArtifactReadTimeoutMs =
      options.postRepairArtifactReadTimeoutMs ??
      postRepairArtifactReadTimeoutMs;
  }

  async generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScriptPackage> {
    let prompt = createScriptGenerationPrompt(input);
    let lastFailure =
      "Script Generation did not produce a valid script package.";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await writeScriptGenerationSandboxLog(this.logger, input, {
        attempt,
        event: "script-generation.opencode-attempt.started",
        opencodeSessionID: input.opencodeSessionID,
      });
      this.writeStatus(
        `Script Generation OpenCode attempt ${attempt} starting in session ${input.opencodeSessionID}.`,
      );
      await removePreviousScriptPackage(input);
      const result = await this.openCode.run({
        attempt,
        prompt,
        sessionID: input.opencodeSessionID,
        stage: "script-generation",
        workspace: input.preparationWorkspace.workspace,
      });

      if (result.exitCode !== 0) {
        const retryReason = `OpenCode Script Generation exited with ${result.exitCode}.`;
        lastFailure = `OpenCode Script Generation exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`;
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.opencode-attempt.failed",
          exitCode: result.exitCode,
          reason: lastFailure,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} failed before artifact validation.`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: retryReason,
        });
        continue;
      }

      const artifact = await readScriptPackageArtifact(input);
      if (artifact.status === "failed") {
        lastFailure = artifact.reason;
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.artifact.missing",
          reason: lastFailure,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} did not produce a readable artifact: ${artifact.reason}`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        await writeScriptGenerationRetryLog(this.logger, input, {
          attempt,
          maxAttempts: this.maxAttempts,
          reason: lastFailure,
        });
        continue;
      }

      try {
        const demoScript = parseDemoScript(artifact.value);
        assertCaptureReadyScriptQuality(demoScript);
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.demo-script-candidate.succeeded",
          scriptId: demoScript.scriptId,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced a Demo Script candidate.`,
        );
        return attachPipelineMetadata(demoScript, input);
      } catch (error) {
        lastFailure = readErrorMessage(error);
        await writeScriptGenerationSandboxLog(this.logger, input, {
          attempt,
          event: "script-generation.script-package.invalid",
          reason: lastFailure,
        });
        this.writeStatus(
          `Script Generation OpenCode attempt ${attempt} produced an invalid artifact: ${lastFailure}`,
        );
        prompt = createScriptGenerationRepairPrompt(lastFailure);
        await writeScriptGenerationRetryLog(this.logger, input, {
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

    await writeRepairSandboxLog(this.logger, input, {
      attempt: input.attempt,
      event: "capture-path-repair.opencode-attempt.started",
      failedSceneId: input.failure.failedSceneId,
      opencodeSessionID: input.opencodeSessionID,
    });
    this.writeStatus(
      `Capture Path repair attempt ${input.attempt} starting in session ${input.opencodeSessionID}.`,
    );

    const result = await this.openCode.run({
      attempt: input.attempt,
      prompt: createCapturePathRepairPrompt(input),
      sessionID: input.opencodeSessionID,
      stage: "capture-path-repair",
      workspace: preparationWorkspace.workspace,
    });

    if (result.exitCode !== 0) {
      const reason = `OpenCode Capture Path repair exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`;
      await writeRepairSandboxLog(this.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.opencode-attempt.failed",
        exitCode: result.exitCode,
        reason,
      });
      throw new Error(reason);
    }

    const scriptArtifact = await readPostRepairArtifact({
      artifactName: "demo-script.json",
      input,
      logger: this.logger,
      read: () => readScriptPackageArtifact({ preparationWorkspace }),
      timeoutMs: this.postRepairArtifactReadTimeoutMs,
    });
    if (scriptArtifact.status === "failed") {
      await writeRepairSandboxLog(this.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.artifact.missing",
        reason: scriptArtifact.reason,
      });
      throw new Error(scriptArtifact.reason);
    }

    const manifestArtifact = await readPostRepairArtifact({
      artifactName: "preparation-manifest.json",
      input,
      logger: this.logger,
      read: () => readPreparationManifestArtifact({ preparationWorkspace }),
      timeoutMs: this.postRepairArtifactReadTimeoutMs,
    });

    if (manifestArtifact.status === "failed") {
      throw new Error(manifestArtifact.reason);
    }

    const preparationManifest =
      manifestArtifact.status === "succeeded"
        ? manifestArtifact.value
        : input.preparationManifest;

    try {
      const demoScript = parseDemoScript(scriptArtifact.value);
      assertDemoScriptCaptureSdkContract(demoScript);
      assertCaptureReadyScriptQuality(demoScript);
    } catch (error) {
      const reason = readErrorMessage(error);
      await writeRepairSandboxLog(this.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.script-package.invalid",
        reason,
      });
      throw new Error(reason);
    }

    await writeRepairSandboxLog(this.logger, input, {
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
    const result = await this.openCode.run({
      attempt: input.attempt,
      prompt: createDraftCompositeReviewPrompt(input),
      sessionID: input.opencodeSessionID,
      stage: "draft-composite-review",
      workspace: preparationWorkspace.workspace,
    });

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
  logger: PipelineEventLogger,
  input: Parameters<CapturePathRepairer["repairCapturePathFailure"]>[0],
  entry: Record<string, unknown>,
): Promise<void> {
  await writeSandboxLogBestEffort({
    entry: {
      ...entry,
      repoUrl: input.repoUrl,
      stage: "capture-path-repair",
      workspaceId: input.preparationManifest.workspaceId,
    },
    logger,
    stage: "capture-path-repair",
    write: (logEntry: Record<string, unknown>) =>
      input.preparationWorkspace?.workspace.writeSandboxLog?.(logEntry),
  });
}

async function readPostRepairArtifact<
  T extends { reason?: string; status: string },
>(input: {
  artifactName: string;
  input: Parameters<CapturePathRepairer["repairCapturePathFailure"]>[0];
  logger: PipelineEventLogger;
  read: () => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  const start = Date.now();
  await writeRepairSandboxLog(input.logger, input.input, {
    artifact: input.artifactName,
    attempt: input.input.attempt,
    durationMs: 0,
    event: "capture-path-repair.artifact-read.started",
    operation: `post-repair artifact read ${input.artifactName}`,
    timeoutMs: input.timeoutMs,
  });

  try {
    const artifact = await withTimeout(
      input.read(),
      input.timeoutMs,
      `Post-repair artifact read ${input.artifactName} timed out after ${input.timeoutMs}ms.`,
    );
    const durationMs = Date.now() - start;
    if (artifact.status === "failed") {
      const reason = `Post-repair artifact read ${input.artifactName} failed: ${artifact.reason ?? "unknown artifact read failure"}`;
      await writeRepairSandboxLog(input.logger, input.input, {
        artifact: input.artifactName,
        attempt: input.input.attempt,
        durationMs,
        event: "capture-path-repair.artifact-read.failed",
        operation: `post-repair artifact read ${input.artifactName}`,
        reason,
      });
      return { ...artifact, reason };
    }

    await writeRepairSandboxLog(input.logger, input.input, {
      artifact: input.artifactName,
      attempt: input.input.attempt,
      durationMs,
      event: "capture-path-repair.artifact-read.succeeded",
      operation: `post-repair artifact read ${input.artifactName}`,
    });
    return artifact;
  } catch (error) {
    const durationMs = Date.now() - start;
    const errorMessage = readErrorMessage(error);
    const reason = errorMessage.includes("timed out after")
      ? errorMessage
      : `Post-repair artifact read ${input.artifactName} failed: ${errorMessage}`;
    const event = errorMessage.includes("timed out after")
      ? "capture-path-repair.artifact-read.timeout"
      : "capture-path-repair.artifact-read.failed";
    await writeRepairSandboxLog(input.logger, input.input, {
      artifact: input.artifactName,
      attempt: input.input.attempt,
      durationMs,
      event,
      operation: `post-repair artifact read ${input.artifactName}`,
      reason,
    });
    return { reason, status: "failed" } as T;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  promise.catch(() => undefined);
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

async function writeScriptGenerationSandboxLog(
  logger: PipelineEventLogger,
  input: AgenticScriptGenerationInput,
  entry: Record<string, unknown>,
): Promise<void> {
  await writeSandboxLogBestEffort({
    entry: {
      ...entry,
      repoUrl: input.repoUrl,
      stage: "script-generation",
      workspaceId: input.preparationManifest.workspaceId,
    },
    logger,
    stage: "script-generation",
    write: (logEntry: Record<string, unknown>) =>
      input.preparationWorkspace.workspace.writeSandboxLog?.(logEntry),
  });
}

async function writeSandboxLogBestEffort(input: {
  entry: Record<string, unknown>;
  logger: PipelineEventLogger;
  stage: string;
  write: (entry: Record<string, unknown>) => Promise<void> | undefined;
}): Promise<void> {
  try {
    void input.write(input.entry)?.catch((error) => {
      warnSandboxLogWriteFailed(input, error);
    });
  } catch (error) {
    warnSandboxLogWriteFailed(input, error);
  }
}

function warnSandboxLogWriteFailed(
  input: {
    entry: Record<string, unknown>;
    logger: PipelineEventLogger;
    stage: string;
  },
  error: unknown,
): void {
  try {
    void input.logger
      .warn(
        {
          error: readErrorMessage(error),
          event: "sandbox-log-write-failed",
          failedEvent:
            typeof input.entry.event === "string"
              ? input.entry.event
              : undefined,
          stage: input.stage,
          workspaceComponent: "sandbox-log",
        },
        "Sandbox progress log write failed.",
      )
      .catch(() => undefined);
  } catch {
    // Preserve Script Generation and Capture Path Repair progress if fallback logging fails.
  }
}

function createScriptGenerationLogger(): PipelineEventLogger {
  return createPipelineEventLogger({
    base: { component: "script-generation-agent" },
    sinks: [
      {
        write(line) {
          process.stderr.write(line);
        },
      },
    ],
  });
}

async function writeScriptGenerationRetryLog(
  logger: PipelineEventLogger,
  input: AgenticScriptGenerationInput,
  retry: { attempt: number; maxAttempts: number; reason: string },
): Promise<void> {
  if (retry.attempt >= retry.maxAttempts) {
    return;
  }

  await writeScriptGenerationSandboxLog(logger, input, {
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
  | { status: "missing" }
  | { reason: string; status: "failed" }
> {
  const result = await input.preparationWorkspace.workspace.execute(
    `if test -f ${shellQuote(preparationManifestPath)}; then node -e ${shellQuote(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(preparationManifestPath)}, "utf8"))`)}; else exit 42; fi`,
  );
  if (result.exitCode === 42) {
    return { status: "missing" };
  }
  if (result.exitCode !== 0) {
    return {
      reason: `Could not read ${preparationManifestPath}: ${result.stderr}`,
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

function createOpenCodeEnv(): Record<string, string> {
  return {
    OPENCODE_CONFIG_DIR: makeADemoOpenCodeConfigDirectory,
    OPENCODE_ENABLE_EXA: "1",
  };
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
    ...createDemoScriptCaptureContractPrompt(),
    "- Do not emit placeholder scripts that only load the page, wait, smoke-check body text, or set inert DOM attributes.",
    "- Keep scripts deterministic and short enough for capture.",
    "- Do not call Repo Preparation tools. Do not request dependency installs. Do not run preparation preflight or Capture Path Validation.",
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
    "- Every `scene(id, async ({ page, expect }) => { ... })` must end with at least one visible Playwright locator assertion such as `await expect(page.getByText('Saved')).toBeVisible()`, `await expect(page.locator('#invoice-table')).toContainText('INV-2049')`, or `await expect(page.locator('[data-testid=\"status\"]')).toHaveText('Paid')`.",
    "- Primitive assertions like `expect(await locator.innerText()).toBe(...)` do not satisfy the visible assertion contract; pair any DOM reads with a final Playwright locator assertion.",
    `- If you change the prepared app command, URL, assumptions, risks, or workspace-change summary, update ${preparationManifestPath}.`,
    "- Keep Playwright interactions deterministic and use only the provided `baseUrl` variable in Playwright scripts.",
    "- Do not add Scene durations, raw video recording, custom marker writers, or timestamps.",
    ...createDemoScriptCaptureContractPrompt(),
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

function createDemoScriptCaptureContractPrompt(): string[] {
  return [
    "- Only use the MakeADemo Capture SDK: import `{ setup, scene }` from `./makeademo-capture-sdk` and write interactions inside those callbacks.",
    "- Do not use real-time network access in the Demo Script. Do not call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `page.request`, `page.waitForRequest`, `page.waitForResponse`, `page.route`, `page.unroute`, or Node network modules such as `http`, `https`, `net`, or `dns`.",
    "- Use the prepared app through the provided `baseUrl`, deterministic user-visible interactions, and Playwright locator assertions. Do not inspect app internals, mutate app state with injected JavaScript, or depend on network request timing.",
    "- Every Scene step must be executable against the prepared app and must finish with a visible locator assertion proving the expected outcome.",
  ];
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

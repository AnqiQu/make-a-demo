import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import { validateDemoScriptCandidate } from "../../../pipeline/04-script-generation/demo-script-candidate-validator";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
} from "../../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import {
  attachPipelineMetadata,
  boundedArtifactTimeout,
  createCapturePathRepairPrompt,
  readErrorMessage,
  readPostRepairArtifact,
  readPreparationManifestArtifact,
  readScriptPackageArtifact,
  writeRepairSandboxLog,
} from "./daytona-opencode-capture-path-repair-support";
import type { DaytonaOpenCodeSession } from "./daytona-opencode-session";

export type DaytonaOpenCodeCapturePathRepairerOptions = {
  hardTimeoutMs: number;
  logger: PipelineEventLogger;
  onStatus: (message: string) => void;
  openCode: Pick<DaytonaOpenCodeSession, "run">;
  postRepairArtifactReadTimeoutMs: number;
  timeoutMs: number;
};

/** Repairs Capture Path failures in the prepared workspace using the shared session. */
export class DaytonaOpenCodeCapturePathRepairer {
  private readonly options: DaytonaOpenCodeCapturePathRepairerOptions;

  constructor(options: DaytonaOpenCodeCapturePathRepairerOptions) {
    this.options = options;
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
    const hardDeadlineAt = Date.now() + this.options.hardTimeoutMs;
    await writeRepairSandboxLog(this.options.logger, input, {
      attempt: input.attempt,
      event: "capture-path-repair.opencode-attempt.started",
      failedSceneId: input.failure.failedSceneId,
      opencodeSessionID: input.opencodeSessionID,
    });
    this.options.onStatus(
      `Capture Path repair attempt ${input.attempt} starting in session ${input.opencodeSessionID}.`,
    );
    const result = await this.options.openCode.run({
      attempt: input.attempt,
      prompt: createCapturePathRepairPrompt(input),
      sessionID: input.opencodeSessionID,
      stage: "capture-path-repair",
      workspace: preparationWorkspace.workspace,
      hardDeadlineAt,
      inactivityTimeoutMs: this.options.timeoutMs,
      hardTimeoutMs: this.options.hardTimeoutMs,
    });
    if (result.exitCode !== 0) {
      const reason = `OpenCode Capture Path repair exited with ${result.exitCode}: ${[result.stderr, result.stdout].filter((line) => line.length > 0).join("\n")}`;
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.opencode-attempt.failed",
        exitCode: result.exitCode,
        reason,
      });
      throw new Error(reason);
    }
    const readTimeoutMs = boundedArtifactTimeout(
      Math.min(
        this.options.postRepairArtifactReadTimeoutMs,
        this.options.timeoutMs,
      ),
      hardDeadlineAt,
    );
    const scriptArtifact = await readPostRepairArtifact({
      artifactName: "demo-script.json",
      input,
      logger: this.options.logger,
      read: () =>
        readScriptPackageArtifact(
          { preparationWorkspace },
          { timeoutMs: readTimeoutMs },
        ),
      timeoutMs: readTimeoutMs,
    });
    if (scriptArtifact.status !== "succeeded") {
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.artifact.missing",
        reason:
          scriptArtifact.status === "failed"
            ? scriptArtifact.reason
            : "demo-script.json was not produced",
      });
      throw new Error(
        scriptArtifact.status === "failed"
          ? scriptArtifact.reason
          : "demo-script.json was not produced",
      );
    }
    const manifestArtifact = await readPostRepairArtifact({
      artifactName: "preparation-manifest.json",
      input,
      logger: this.options.logger,
      read: () =>
        readPreparationManifestArtifact(
          { preparationWorkspace },
          { timeoutMs: readTimeoutMs },
        ),
      timeoutMs: readTimeoutMs,
    });
    if (manifestArtifact.status === "failed")
      throw new Error(manifestArtifact.reason);
    const preparationManifest =
      manifestArtifact.status === "succeeded"
        ? (manifestArtifact.value as PreparationManifest)
        : input.preparationManifest;
    let demoScript: Awaited<ReturnType<typeof validateDemoScriptCandidate>>;
    try {
      demoScript = await validateDemoScriptCandidate(scriptArtifact.value);
    } catch (error) {
      const reason = readErrorMessage(error);
      await writeRepairSandboxLog(this.options.logger, input, {
        attempt: input.attempt,
        event: "capture-path-repair.script-package.invalid",
        reason,
      });
      throw new Error(reason);
    }
    await writeRepairSandboxLog(this.options.logger, input, {
      attempt: input.attempt,
      event: "capture-path-repair.demo-script.succeeded",
      scriptId: demoScript.scriptId,
    });
    this.options.onStatus(
      `Capture Path repair attempt ${input.attempt} produced a Demo Script for revalidation.`,
    );
    return {
      preparationManifest,
      demoScriptPackage: attachPipelineMetadata(demoScript, {
        demoBrief: {
          keyProductFeatures: input.demoScriptPackage.demoPlan.featureOrder,
        },
        normalizedSupportingDocuments: [],
        opencodeSessionID: input.opencodeSessionID,
        preparationManifest,
        preparationWorkspace,
        repoUrl: input.repoUrl,
      }),
    };
  }
}

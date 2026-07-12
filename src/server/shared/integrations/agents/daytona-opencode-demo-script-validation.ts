import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { validateDemoScriptCandidate } from "../../../pipeline/04-script-generation/demo-script-candidate-validator";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "../../../pipeline/05-capture-path-validation/capture-path-validator.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";
import { readErrorMessage } from "./daytona-opencode-capture-path-repair-support";
import {
  demoScriptPath,
  readDemoScriptArtifact,
} from "./demo-script-validation-artifact-handoff";

/**
 * Bounded feedback from one in-turn validation request. Infrastructure failures
 * remain distinguishable from candidate or prepared-runtime rejections.
 */
export type DemoScriptValidationResult = {
  feedback: string;
  kind: "infrastructure" | "runtime" | "static";
  status: "failed" | "succeeded";
  validation?: CapturePathValidationResult;
};

/** Inputs required to validate a candidate against its prepared app. */
export type DemoScriptValidationHandlerInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  demoBrief: { keyProductFeatures: string[] };
};

/**
 * External validation dependencies. Implementations must run the same
 * backend-owned Capture Path Validation boundary used by pipeline acceptance.
 */
export type DaytonaOpenCodeDemoScriptValidationOptions = {
  logger?: Pick<PipelineEventLogger, "warn">;
  validateCapturePath: (
    input: CapturePathValidationInput,
  ) => Promise<CapturePathValidationResult>;
};

/**
 * Handles one canonical Demo Script tool handoff. Static checks always precede
 * prepared-runtime validation, and all agent feedback remains bounded.
 */
export class DaytonaOpenCodeDemoScriptValidationHandler {
  private readonly logger: Pick<PipelineEventLogger, "warn"> | undefined;
  private readonly validateCapturePath: DaytonaOpenCodeDemoScriptValidationOptions["validateCapturePath"];

  constructor(options: DaytonaOpenCodeDemoScriptValidationOptions) {
    this.logger = options.logger;
    this.validateCapturePath = options.validateCapturePath;
  }

  async handle(
    input: DemoScriptValidationHandlerInput,
    requestedPath: string,
  ): Promise<DemoScriptValidationResult> {
    const workspace = input.preparationWorkspace.workspace;
    const startedAt = Date.now();
    await this.writeLog(workspace, {
      event: "script-generation.demo-script-validation.requested",
    });
    try {
      if (requestedPath !== demoScriptPath) {
        return this.failed(
          "static",
          `Demo Script path must be ${demoScriptPath}.`,
        );
      }
      let candidate: Awaited<ReturnType<typeof validateDemoScriptCandidate>>;
      try {
        candidate = await validateDemoScriptCandidate(
          await readDemoScriptArtifact(workspace, demoScriptPath),
        );
      } catch (error) {
        const result = this.failed("static", readErrorMessage(error));
        await this.writeLog(workspace, {
          durationMs: Date.now() - startedAt,
          event: "script-generation.demo-script-validation.failed",
          kind: result.kind,
          reason: readErrorMessage(error),
        });
        return result;
      }
      const demoScriptPackage = {
        ...candidate,
        assumptions: input.preparationManifest.assumptions,
        demoPlan: {
          featureOrder: input.demoBrief.keyProductFeatures,
          narrative: candidate.title,
          risks: input.preparationManifest.risks,
        },
        exploration: {
          assumptions: input.preparationManifest.assumptions,
          productSurfaces: input.preparationManifest.scriptGenerationContext,
          summary: input.preparationManifest.setupSummary,
        },
      };
      let validation: CapturePathValidationResult;
      try {
        validation = await this.validateCapturePath({
          demoScriptCandidate: demoScriptPackage,
          demoScriptPackage,
          preparationManifest: input.preparationManifest,
          preparationWorkspace: input.preparationWorkspace,
        });
      } catch (error) {
        const reason = readErrorMessage(error);
        const result = this.failed("infrastructure", reason);
        await this.writeLog(workspace, {
          durationMs: Date.now() - startedAt,
          event: "script-generation.demo-script-validation.failed",
          kind: result.kind,
          reason,
        });
        return result;
      }
      const result =
        validation.status === "succeeded"
          ? {
              feedback:
                "Capture Path Validation passed. Continue the same task and finish the Demo Script handoff.",
              kind: "runtime" as const,
              status: "succeeded" as const,
              validation,
            }
          : {
              feedback: createValidationFeedback(validation),
              kind: "runtime" as const,
              status: "failed" as const,
              validation,
            };
      await this.writeLog(workspace, {
        durationMs: Date.now() - startedAt,
        event: "script-generation.demo-script-validation.finished",
        kind: result.kind,
        status: result.status,
      });
      return result;
    } catch (error) {
      const reason = readErrorMessage(error);
      const result = this.failed("infrastructure", reason);
      await this.writeLog(workspace, {
        durationMs: Date.now() - startedAt,
        event: "script-generation.demo-script-validation.failed",
        kind: result.kind,
        reason,
      });
      return result;
    }
  }

  private failed(
    kind: DemoScriptValidationResult["kind"],
    reason: string,
  ): DemoScriptValidationResult {
    return {
      feedback: `Demo Script ${kind} validation failed: ${reason}. Repair ${demoScriptPath}, then call makeademo_validate_demo_script again.`,
      kind,
      status: "failed",
    };
  }

  private async writeLog(
    workspace: PreparationWorkspaceHandle["workspace"],
    event: Record<string, unknown>,
  ): Promise<void> {
    try {
      await workspace.writeSandboxLog?.({
        ...event,
        stage: "script-generation",
      });
    } catch (error) {
      try {
        await this.logger?.warn(
          { error: readErrorMessage(error), ...event },
          "Demo Script validation sandbox log write failed.",
        );
      } catch {
        // Audit logging is best effort and must not block agent repair.
      }
    }
  }
}

function createValidationFeedback(
  validation: CapturePathValidationResult,
): string {
  const details = [
    validation.failureReason,
    validation.failedAction === undefined
      ? undefined
      : `failed action: ${validation.failedAction}`,
    validation.errorMessage,
    validation.logs.at(-1),
  ].filter((value): value is string => value !== undefined && value.length > 0);
  const detailText =
    details.join("; ") || "the prepared runtime rejected the capture path";
  const kind = /strict mode violation|resolved to \d+ elements|locator/i.test(
    detailText,
  )
    ? "locator-cardinality"
    : "runtime";
  return `Demo Script ${kind} validation failed: ${bound(detailText)}. Repair ${demoScriptPath}, then call makeademo_validate_demo_script again.`;
}

function bound(value: string): string {
  return value.length <= 4_000
    ? value
    : `${value.slice(0, 4_000)}...[truncated]`;
}

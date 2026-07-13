import type { SubmittedAppExplorationResult } from "../app-explorer/submitted-app-explorer";
import {
  type AgentHarnessWorkspace,
  isAgentHarnessInfrastructureError,
} from "../daytona/workspace.interface";
import type { OpenCodeHarnessRunner } from "../opencode/opencode-harness";
import {
  classifyRepairRoute,
  readRepairBudgetDecision,
} from "../repair/repair-router";
import type { PreparationWorkspaceDiff } from "../repo-preparation/preparation-workspace-diff";
import { profileRepo } from "../repo-profiler/repo-profiler";
import { screenStaticRepoSecurity } from "../repo-security/static-repo-security";
import {
  type ActionCatalog,
  type AppMap,
  DEMO_SCRIPT_OUTPUT_PATH,
  type FlowSpec,
  type PipelineRunManifest,
  type PreparationManifest,
  type RepoProfile,
  type RunPlan,
  type ScriptCandidate,
  type ValidationReport,
  readActionCatalog,
  readAppMap,
  readFlowSpec,
  readPipelineRunManifest,
  readPreparationManifest,
  readRunPlan,
  readScriptCandidate,
  readValidationReport,
} from "../schemas/artifacts";
import { assertScriptWritingChangesAllowed } from "../script-generation/read-only-boundary";
import {
  PreparationFallbackRequiredError,
  createPreparationFallbackArtifact,
} from "./preparation-fallback";

export type AgentHarnessPipelineInput = {
  commitSha?: string;
  demoBrief: {
    demoLengthSeconds?: number;
    keyProductFeatures?: string[];
    productSummary?: string;
    targetUsers?: string;
  };
  files: Array<{ path: string; text?: string }>;
  normalizedSupportingDocuments?: Array<Record<string, unknown>>;
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
  repoUrl: string;
  rootDir?: string;
  runId: string;
};

type AgentHarnessArtifactStore = {
  writeJson(path: string, value: unknown): Promise<void>;
};

export type AgentHarnessPipelineDependencies = {
  artifactStore?: AgentHarnessArtifactStore;
  captureWorkspaceDiff?: (input: {
    workspace: AgentHarnessWorkspace;
  }) => Promise<string[]>;
  capturePreparationWorkspaceDiff?: (input: {
    workspace: AgentHarnessWorkspace;
  }) => Promise<PreparationWorkspaceDiff>;
  createWorkspace(input: {
    repoProfile: RepoProfile;
    runPlan: RunPlan;
  }): Promise<AgentHarnessWorkspace>;
  /**
   * Recreates a clean, network-locked submitted-code runtime after the
   * validation dry-run so Footage Capture cannot inherit mutated app state.
   */
  resetCaptureRuntime(input: {
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    runPlan: RunPlan;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  openCodeRunner?: OpenCodeHarnessRunner;
  exploreApp(input: {
    actionCatalogPath: string;
    appMapPath: string;
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    preparationManifest: PreparationManifest;
    preparationValidation: ValidationReport;
    repoProfile: RepoProfile;
    workspace: AgentHarnessWorkspace;
  }): Promise<SubmittedAppExplorationResult>;
  planFlow(input: {
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
  }): Promise<FlowSpec>;
  prepareRepo(input: {
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    normalizedSupportingDocuments: AgentHarnessPipelineInput["normalizedSupportingDocuments"];
    repoProfile: RepoProfile;
    repoSourcePaths: string[];
    runPlan: RunPlan;
    workspace: AgentHarnessWorkspace;
  }): Promise<{ manifest: PreparationManifest; opencodeSessionId?: string }>;
  repairPreparation?(input: {
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    failureReport: ValidationReport;
    normalizedSupportingDocuments: AgentHarnessPipelineInput["normalizedSupportingDocuments"];
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    repoSourcePaths: string[];
    runPlan: RunPlan;
    workspace: AgentHarnessWorkspace;
  }): Promise<{ manifest: PreparationManifest; opencodeSessionId?: string }>;
  repairScript?(input: {
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    failureReport: ValidationReport;
    flowSpec: FlowSpec;
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    scriptCandidate: ScriptCandidate;
    workspace: AgentHarnessWorkspace;
  }): Promise<ScriptCandidate>;
  synthesizeRunPlan(input: { repoProfile: RepoProfile }): Promise<RunPlan>;
  validateCapturePath(input: {
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    flowSpec: FlowSpec;
    preparationManifest: PreparationManifest;
    scriptCandidate: ScriptCandidate;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  validatePreparation(input: {
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    runPlan: RunPlan;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  validateScriptContract(input: {
    actionCatalog: ActionCatalog;
    contractOutputPath: typeof DEMO_SCRIPT_OUTPUT_PATH;
    flowSpec: FlowSpec;
    preparationManifest: PreparationManifest;
    scriptCandidate: ScriptCandidate;
  }): Promise<ValidationReport>;
  writeScript(input: {
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    flowSpec: FlowSpec;
    outputPath: typeof DEMO_SCRIPT_OUTPUT_PATH;
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    workspace: AgentHarnessWorkspace;
  }): Promise<ScriptCandidate>;
};

export type AgentHarnessPipelineResult = {
  actionCatalog?: ActionCatalog;
  appMap?: AppMap;
  flowSpec?: FlowSpec;
  pipelineRunManifest: PipelineRunManifest;
  preparationManifest?: PreparationManifest;
  preparationWorkspaceDiff?: PreparationWorkspaceDiff;
  repoProfile?: RepoProfile;
  runPlan?: RunPlan;
  scriptCandidate?: ScriptCandidate;
  status: "failed" | "passed" | "security-rejected";
  validationReports: ValidationReport[];
  workspace?: AgentHarnessWorkspace;
};

export type AgentHarnessPipelineOptions = {
  destroyWorkspaceOnCompletion?: boolean;
  /** Maximum Repo Preparation repairs allowed independently per failing validation stage. */
  repoPreparationRepairLimit?: number;
  /** Maximum Script repairs allowed independently per failing validation stage. */
  scriptRepairLimit?: number;
};

const artifactPaths = {
  actionCatalog: "/workspace/.makeademo/action-catalog.json",
  agentArtifactAttempts: "/workspace/.makeademo/agent-artifact-attempts",
  appMap: "/workspace/.makeademo/app-map.json",
  appExplorationValidation:
    "/workspace/.makeademo/app-exploration-validation-report.json",
  capturePathValidation:
    "/workspace/.makeademo/capture-path-validation-report.json",
  captureRuntimeReset:
    "/workspace/.makeademo/capture-runtime-reset-validation-report.json",
  demoScript: DEMO_SCRIPT_OUTPUT_PATH,
  flowSpec: "/workspace/.makeademo/flow-spec.json",
  pipelineRunManifest: "/workspace/.makeademo/pipeline-run-manifest.json",
  preparationFallback: "/workspace/.makeademo/preparation-fallback.json",
  preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
  preparationWorkspaceDiff:
    "/workspace/.makeademo/preparation-workspace-diff.json",
  preparationPreflight:
    "/workspace/.makeademo/preparation-preflight-validation-report.json",
  repoProfile: "/workspace/.makeademo/repo-profile.json",
  runPlan: "/workspace/.makeademo/run-plan.json",
  scriptCandidate: "/workspace/.makeademo/script-candidate.json",
  staticScriptContract:
    "/workspace/.makeademo/static-script-contract-validation.json",
  validationAttempts: "/workspace/.makeademo/validation-attempts",
};

export async function runAgentHarnessPipeline(
  input: AgentHarnessPipelineInput,
  dependencies: AgentHarnessPipelineDependencies,
  options: AgentHarnessPipelineOptions = {},
): Promise<AgentHarnessPipelineResult> {
  const stageStatuses: Record<
    string,
    | PipelineRunManifest["finalStatus"]
    | "passed"
    | "pending"
    | "running"
    | "skipped"
  > = {};
  const stageTimings: PipelineRunManifest["stageTimings"] = [];
  const validationReports: ValidationReport[] = [];
  const opencodeSessionIds: string[] = [];
  let completedResult: AgentHarnessPipelineResult | undefined;
  let cleanupFailure: unknown;
  let primaryError: unknown;
  let workspace: AgentHarnessWorkspace | undefined;

  const security = runStage(
    "static-repo-security-screen",
    stageStatuses,
    stageTimings,
    () =>
      screenStaticRepoSecurity({
        files: input.files,
        repoStats: input.repoStats,
      }),
  );
  if (security.status === "rejected") {
    const pipelineRunManifest = await persistRunManifest({
      dependencies,
      input,
      opencodeSessionIds,
      stageStatuses,
      stageTimings,
      status: "failed",
      unsupportedOrFailureReason: security.rejections.join("; "),
      workspace,
    });
    completedResult = {
      pipelineRunManifest,
      status: "security-rejected",
      validationReports,
    };
  }

  let repoProfile: RepoProfile;
  let runPlan: RunPlan;
  try {
    repoProfile = await writeArtifact(
      dependencies,
      artifactPaths.repoProfile,
      profileRepo({
        ...optionalString("commitSha", input.commitSha),
        files: input.files,
        repoUrl: input.repoUrl,
        ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
      }),
    );

    runPlan = await runAsyncStage(
      "run-plan-synthesis",
      stageStatuses,
      stageTimings,
      async () =>
        readRunPlan(
          await dependencies.synthesizeRunPlan({
            repoProfile,
          }),
        ),
    );
    await writeArtifact(dependencies, artifactPaths.runPlan, runPlan);
    workspace = await dependencies.createWorkspace({ repoProfile, runPlan });
  } catch (error) {
    stageStatuses["agent-harness"] = "failed";
    try {
      await persistRunManifest({
        dependencies,
        input,
        opencodeSessionIds,
        stageStatuses,
        stageTimings,
        status: "failed",
        unsupportedOrFailureReason: readErrorMessage(error),
        workspace,
      });
    } catch (manifestError) {
      attachSecondaryError(error, "failureManifestError", manifestError);
    }
    throw error;
  }

  try {
    const preparation = await runAsyncStage(
      "repo-preparation",
      stageStatuses,
      stageTimings,
      async () =>
        dependencies.prepareRepo({
          demoBrief: input.demoBrief,
          normalizedSupportingDocuments: input.normalizedSupportingDocuments,
          repoProfile,
          repoSourcePaths: input.files.map((file) => file.path),
          runPlan,
          workspace: requireWorkspace(workspace),
        }),
    );
    if (preparation.opencodeSessionId !== undefined) {
      opencodeSessionIds.push(preparation.opencodeSessionId);
    }
    let preparationManifest = await writeArtifact(
      dependencies,
      artifactPaths.preparationManifest,
      readPreparationManifest(preparation.manifest),
    );

    const repoPreparationRepairLimit = options.repoPreparationRepairLimit ?? 3;
    const preparationRepairAttemptsByPhase: Record<string, number> = {};
    const scriptRepairAttemptsByPhase: Record<string, number> = {};
    const scriptRepairLimit = options.scriptRepairLimit ?? 3;
    const validationAttemptCounts: Record<string, number> = {};
    let preparationState = await ensureValidPreparation({
      dependencies,
      input,
      preparationManifest,
      preparationRepairAttemptsByPhase,
      repoPreparationRepairLimit,
      repoProfile,
      runPlan,
      stageStatuses,
      stageTimings,
      validationReports,
      validationAttemptCounts,
      workspace: requireWorkspace(workspace),
    });
    preparationManifest = preparationState.preparationManifest;
    let preparationWorkspaceDiff = preparationState.preparationWorkspaceDiff;
    let preparationValidation = preparationState.preparationValidation;
    opencodeSessionIds.push(...preparationState.opencodeSessionIds);

    let appMap: AppMap;
    let actionCatalog: ActionCatalog;
    let flowSpec: FlowSpec;
    let scriptCandidate: ScriptCandidate;
    pipelineAttempt: for (;;) {
      for (;;) {
        const exploration = await runAsyncStage(
          "app-exploration",
          stageStatuses,
          stageTimings,
          async () =>
            dependencies.exploreApp({
              actionCatalogPath: artifactPaths.actionCatalog,
              appMapPath: artifactPaths.appMap,
              demoBrief: input.demoBrief,
              preparationManifest,
              preparationValidation,
              repoProfile,
              workspace: requireWorkspace(workspace),
            }),
        );
        const explorationAttempt = nextValidationAttempt(
          validationAttemptCounts,
          "app-exploration",
        );
        const explorationValidation = readValidationReport({
          ...exploration.validationReport,
          retryCount: explorationAttempt - 1,
        });
        validationReports.push(explorationValidation);
        stageStatuses["app-exploration"] = explorationValidation.status;
        await Promise.all([
          writeArtifact(
            dependencies,
            artifactPaths.appExplorationValidation,
            explorationValidation,
          ),
          writeArtifact(
            dependencies,
            `${artifactPaths.validationAttempts}/app-exploration/attempt-${explorationAttempt}.json`,
            explorationValidation,
          ),
        ]);
        if (explorationValidation.status === "passed") {
          if (exploration.kind !== "artifacts") {
            throw new Error(
              "App Exploration reported success without grounded AppMap and ActionCatalog artifacts.",
            );
          }
          appMap = await writeArtifact(
            dependencies,
            artifactPaths.appMap,
            readAppMap(exploration.appMap),
          );
          actionCatalog = await writeArtifact(
            dependencies,
            artifactPaths.actionCatalog,
            readActionCatalog(exploration.actionCatalog),
          );
          break;
        }

        preparationState = await ensureValidPreparation({
          dependencies,
          initialFailure: explorationValidation,
          input,
          preparationManifest,
          preparationRepairAttemptsByPhase,
          repoPreparationRepairLimit,
          repoProfile,
          runPlan,
          stageStatuses,
          stageTimings,
          validationReports,
          validationAttemptCounts,
          workspace: requireWorkspace(workspace),
        });
        preparationManifest = preparationState.preparationManifest;
        preparationWorkspaceDiff = preparationState.preparationWorkspaceDiff;
        preparationValidation = preparationState.preparationValidation;
        opencodeSessionIds.push(...preparationState.opencodeSessionIds);
      }

      flowSpec = await runAsyncStage(
        "flow-planning",
        stageStatuses,
        stageTimings,
        async () =>
          readFlowSpec(
            await dependencies.planFlow({
              actionCatalog,
              appMap,
              demoBrief: input.demoBrief,
              preparationManifest,
              repoProfile,
            }),
          ),
      );
      await writeArtifact(dependencies, artifactPaths.flowSpec, flowSpec);

      scriptCandidate = await runAsyncStage(
        "script-writing",
        stageStatuses,
        stageTimings,
        async () => {
          const candidate = readScriptCandidate(
            await dependencies.writeScript({
              actionCatalog,
              appMap,
              demoBrief: input.demoBrief,
              flowSpec,
              outputPath: DEMO_SCRIPT_OUTPUT_PATH,
              preparationManifest,
              repoProfile,
              workspace: requireWorkspace(workspace),
            }),
          );
          if (dependencies.captureWorkspaceDiff !== undefined) {
            assertScriptWritingChangesAllowed(
              await dependencies.captureWorkspaceDiff({
                workspace: requireWorkspace(workspace),
              }),
            );
          }
          return candidate;
        },
      );
      await writeArtifact(
        dependencies,
        artifactPaths.scriptCandidate,
        scriptCandidate,
      );

      for (;;) {
        const staticRepairAttempts =
          scriptRepairAttemptsByPhase["static-script-contract-validation"] ?? 0;
        const staticContractValidation = await runValidationStage(
          "static-script-contract-validation",
          dependencies,
          artifactPaths.staticScriptContract,
          validationReports,
          stageStatuses,
          stageTimings,
          () =>
            dependencies.validateScriptContract({
              actionCatalog,
              contractOutputPath: DEMO_SCRIPT_OUTPUT_PATH,
              flowSpec,
              preparationManifest,
              scriptCandidate,
            }),
          validationAttemptCounts,
          staticRepairAttempts,
        );
        if (staticContractValidation.status === "failed") {
          scriptCandidate = await repairScriptCandidate({
            actionCatalog,
            appMap,
            dependencies,
            failureReport: staticContractValidation,
            flowSpec,
            preparationManifest,
            repoProfile,
            scriptCandidate,
            scriptRepairAttempts: staticRepairAttempts,
            scriptRepairLimit,
            stageStatuses,
            stageTimings,
            workspace: requireWorkspace(workspace),
          });
          scriptRepairAttemptsByPhase["static-script-contract-validation"] =
            staticRepairAttempts + 1;
          await writeArtifact(
            dependencies,
            artifactPaths.scriptCandidate,
            scriptCandidate,
          );
          continue;
        }

        const captureRepairAttempts =
          scriptRepairAttemptsByPhase["capture-path-validation"] ?? 0;
        const capturePathValidation = await runValidationStage(
          "capture-path-validation",
          dependencies,
          artifactPaths.capturePathValidation,
          validationReports,
          stageStatuses,
          stageTimings,
          () =>
            dependencies.validateCapturePath({
              actionCatalog,
              appMap,
              flowSpec,
              preparationManifest,
              scriptCandidate,
              workspace: requireWorkspace(workspace),
            }),
          validationAttemptCounts,
          captureRepairAttempts,
        );
        if (capturePathValidation.status === "passed") {
          break;
        }

        if (
          classifyRepairRoute(capturePathValidation) ===
          "repo-preparation-repair"
        ) {
          preparationState = await ensureValidPreparation({
            dependencies,
            initialFailure: capturePathValidation,
            input,
            preparationManifest,
            preparationRepairAttemptsByPhase,
            repoPreparationRepairLimit,
            repoProfile,
            runPlan,
            stageStatuses,
            stageTimings,
            validationReports,
            validationAttemptCounts,
            workspace: requireWorkspace(workspace),
          });
          preparationManifest = preparationState.preparationManifest;
          preparationWorkspaceDiff = preparationState.preparationWorkspaceDiff;
          preparationValidation = preparationState.preparationValidation;
          opencodeSessionIds.push(...preparationState.opencodeSessionIds);
          continue pipelineAttempt;
        }

        if (capturePathValidation.failureClassification === "locator failure") {
          const regrounding = await runAsyncStage(
            "locator-regrounding",
            stageStatuses,
            stageTimings,
            () =>
              dependencies.exploreApp({
                actionCatalogPath: artifactPaths.actionCatalog,
                appMapPath: artifactPaths.appMap,
                demoBrief: input.demoBrief,
                preparationManifest,
                preparationValidation,
                repoProfile,
                workspace: requireWorkspace(workspace),
              }),
          );
          const regroundingAttempt = nextValidationAttempt(
            validationAttemptCounts,
            "locator-regrounding",
          );
          const regroundingValidation = readValidationReport({
            ...regrounding.validationReport,
            retryCount: captureRepairAttempts,
          });
          validationReports.push(regroundingValidation);
          await Promise.all([
            writeArtifact(
              dependencies,
              artifactPaths.appExplorationValidation,
              regroundingValidation,
            ),
            writeArtifact(
              dependencies,
              `${artifactPaths.validationAttempts}/locator-regrounding/attempt-${regroundingAttempt}.json`,
              regroundingValidation,
            ),
          ]);
          assertValidationPassed(regroundingValidation);
          if (regrounding.kind !== "artifacts") {
            throw new Error(
              "Locator re-grounding passed without AppMap and ActionCatalog artifacts.",
            );
          }
          appMap = await writeArtifact(
            dependencies,
            artifactPaths.appMap,
            readAppMap(regrounding.appMap),
          );
          actionCatalog = await writeArtifact(
            dependencies,
            artifactPaths.actionCatalog,
            readActionCatalog(regrounding.actionCatalog),
          );
          flowSpec = await runAsyncStage(
            "flow-replanning",
            stageStatuses,
            stageTimings,
            async () =>
              readFlowSpec(
                await dependencies.planFlow({
                  actionCatalog,
                  appMap,
                  demoBrief: input.demoBrief,
                  preparationManifest,
                  repoProfile,
                }),
              ),
          );
          await writeArtifact(dependencies, artifactPaths.flowSpec, flowSpec);
        }

        scriptCandidate = await repairScriptCandidate({
          actionCatalog,
          appMap,
          dependencies,
          failureReport: capturePathValidation,
          flowSpec,
          preparationManifest,
          repoProfile,
          scriptCandidate,
          scriptRepairAttempts: captureRepairAttempts,
          scriptRepairLimit,
          stageStatuses,
          stageTimings,
          workspace: requireWorkspace(workspace),
        });
        scriptRepairAttemptsByPhase["capture-path-validation"] =
          captureRepairAttempts + 1;
        await writeArtifact(
          dependencies,
          artifactPaths.scriptCandidate,
          scriptCandidate,
        );
      }

      const resetValidation = await runValidationStage(
        "capture-runtime-reset",
        dependencies,
        artifactPaths.captureRuntimeReset,
        validationReports,
        stageStatuses,
        stageTimings,
        () =>
          dependencies.resetCaptureRuntime({
            preparationManifest,
            repoProfile,
            runPlan,
            workspace: requireWorkspace(workspace),
          }),
        validationAttemptCounts,
      );
      assertValidationPassed(resetValidation);
      break;
    }

    const pipelineRunManifest = await persistRunManifest({
      dependencies,
      input,
      opencodeSessionIds,
      stageStatuses,
      stageTimings,
      status: "passed",
      workspace,
    });

    return {
      actionCatalog,
      appMap,
      flowSpec,
      pipelineRunManifest,
      preparationManifest,
      ...(preparationWorkspaceDiff === undefined
        ? {}
        : { preparationWorkspaceDiff }),
      repoProfile,
      runPlan,
      scriptCandidate,
      status: "passed",
      validationReports,
      ...(options.destroyWorkspaceOnCompletion === false &&
      workspace !== undefined
        ? { workspace }
        : {}),
    };
  } catch (error) {
    const failedSessionId = readFailedOpenCodeSessionId(error);
    if (failedSessionId !== undefined) {
      opencodeSessionIds.push(failedSessionId);
    }
    stageStatuses["agent-harness"] = "failed";
    const preparationFailedStage = readPreparationFailedStage(stageStatuses);
    let surfacedError = error;
    if (
      preparationFailedStage !== undefined &&
      !isAgentHarnessInfrastructureError(error)
    ) {
      const fallback = createPreparationFallbackArtifact({
        ...(input.commitSha === undefined
          ? {}
          : { commitSha: input.commitSha }),
        error,
        failedStage: preparationFailedStage,
        repoUrl: input.repoUrl,
        runId: input.runId,
        validationReports,
      });
      surfacedError = new PreparationFallbackRequiredError(
        readErrorMessage(error),
        fallback,
        error,
      );
      try {
        await writeArtifact(
          dependencies,
          artifactPaths.preparationFallback,
          fallback,
        );
      } catch (fallbackArtifactError) {
        attachSecondaryError(
          surfacedError,
          "fallbackArtifactError",
          fallbackArtifactError,
        );
      }
    }
    primaryError = surfacedError;
    try {
      await persistRunManifest({
        dependencies,
        input,
        opencodeSessionIds,
        stageStatuses,
        stageTimings,
        status: "failed",
        unsupportedOrFailureReason: readErrorMessage(surfacedError),
        workspace,
      });
    } catch (manifestError) {
      attachSecondaryError(
        surfacedError,
        "failureManifestError",
        manifestError,
      );
    }
  } finally {
    if (options.destroyWorkspaceOnCompletion !== false) {
      try {
        await workspace?.destroy();
      } catch (cleanupError) {
        if (primaryError === undefined) {
          cleanupFailure = cleanupError;
        } else {
          stageStatuses["workspace-cleanup"] = "failed";
          attachCleanupError(primaryError, cleanupError);
          const primaryMessage = readErrorMessage(primaryError);
          const cleanupMessage = readErrorMessage(cleanupError);
          try {
            await persistRunManifest({
              dependencies,
              input,
              opencodeSessionIds,
              stageStatuses,
              stageTimings,
              status: "failed",
              unsupportedOrFailureReason: `${primaryMessage}; workspace cleanup failed: ${cleanupMessage}`,
              workspace,
            });
          } catch (manifestError) {
            attachSecondaryError(
              primaryError,
              "cleanupManifestError",
              manifestError,
            );
          }
        }
      }
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
  if (completedResult === undefined) {
    throw new Error("Agent harness finished without a result.");
  }
  return completedResult;
}

function readPreparationFailedStage(
  stageStatuses: Record<string, string>,
): string | undefined {
  return Object.entries(stageStatuses)
    .reverse()
    .find(
      ([stage, status]) =>
        status === "failed" &&
        (stage === "repo-preparation" ||
          stage === "preparation-preflight" ||
          stage === "app-exploration"),
    )?.[0];
}

function attachCleanupError(primaryError: unknown, cleanupError: unknown) {
  attachSecondaryError(primaryError, "cleanupError", cleanupError);
}

function attachSecondaryError(
  primaryError: unknown,
  key: string,
  secondaryError: unknown,
) {
  if (
    (typeof primaryError !== "object" || primaryError === null) &&
    typeof primaryError !== "function"
  ) {
    return;
  }
  try {
    Reflect.set(primaryError, key, secondaryError);
  } catch {
    // Preserve the primary pipeline error even when it is non-extensible.
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFailedOpenCodeSessionId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = Reflect.get(error, "opencodeSessionId");
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

async function runValidationStage(
  stage: string,
  dependencies: AgentHarnessPipelineDependencies,
  path: string,
  validationReports: ValidationReport[],
  stageStatuses: Record<string, string>,
  stageTimings: PipelineRunManifest["stageTimings"],
  callback: () => Promise<ValidationReport>,
  validationAttemptCounts: Record<string, number>,
  retryCount = 0,
): Promise<ValidationReport> {
  const attempt = nextValidationAttempt(validationAttemptCounts, stage);
  const rawReport = await runAsyncStage(
    stage,
    stageStatuses,
    stageTimings,
    async () => readValidationReport(await callback()),
  );
  const report = readValidationReport({ ...rawReport, retryCount });
  stageStatuses[stage] = report.status;
  validationReports.push(report);
  await Promise.all([
    writeArtifact(dependencies, path, report),
    writeArtifact(
      dependencies,
      `${artifactPaths.validationAttempts}/${stage.replaceAll(/[^A-Za-z0-9_-]/g, "-")}/attempt-${attempt}.json`,
      report,
    ),
  ]);
  return report;
}

function nextValidationAttempt(
  validationAttemptCounts: Record<string, number>,
  stage: string,
): number {
  const attempt = (validationAttemptCounts[stage] ?? 0) + 1;
  validationAttemptCounts[stage] = attempt;
  return attempt;
}

async function repairScriptCandidate(input: {
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  dependencies: AgentHarnessPipelineDependencies;
  failureReport: ValidationReport;
  flowSpec: FlowSpec;
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  scriptCandidate: ScriptCandidate;
  scriptRepairAttempts: number;
  scriptRepairLimit: number;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  workspace: AgentHarnessWorkspace;
}): Promise<ScriptCandidate> {
  const route = classifyRepairRoute(input.failureReport);
  if (
    route !== "script-repair" ||
    input.dependencies.repairScript === undefined
  ) {
    assertValidationPassed(input.failureReport);
    throw new Error("Unreachable validation state.");
  }

  const budget = readRepairBudgetDecision({
    attempted: input.scriptRepairAttempts,
    limit: input.scriptRepairLimit,
    route,
  });
  if (budget.status === "exhausted") {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${budget.reason}`,
    );
  }

  const repairedCandidate = await runAsyncStage(
    `${input.failureReport.stage}-script-repair-${budget.nextAttempt}`,
    input.stageStatuses,
    input.stageTimings,
    async () =>
      readScriptCandidate(
        await input.dependencies.repairScript?.({
          actionCatalog: input.actionCatalog,
          appMap: input.appMap,
          failureReport: input.failureReport,
          flowSpec: input.flowSpec,
          preparationManifest: input.preparationManifest,
          repoProfile: input.repoProfile,
          scriptCandidate: input.scriptCandidate,
          workspace: input.workspace,
        }),
      ),
  );
  if (input.dependencies.captureWorkspaceDiff !== undefined) {
    assertScriptWritingChangesAllowed(
      await input.dependencies.captureWorkspaceDiff({
        workspace: input.workspace,
      }),
    );
  }
  return repairedCandidate;
}

async function ensureValidPreparation(input: {
  dependencies: AgentHarnessPipelineDependencies;
  initialFailure?: ValidationReport;
  input: AgentHarnessPipelineInput;
  preparationManifest: PreparationManifest;
  preparationRepairAttemptsByPhase: Record<string, number>;
  repoPreparationRepairLimit: number;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  validationReports: ValidationReport[];
  validationAttemptCounts: Record<string, number>;
  workspace: AgentHarnessWorkspace;
}): Promise<{
  opencodeSessionIds: string[];
  preparationManifest: PreparationManifest;
  preparationValidation: ValidationReport;
  preparationWorkspaceDiff?: PreparationWorkspaceDiff;
}> {
  let preparationManifest = input.preparationManifest;
  let failure = input.initialFailure;
  const opencodeSessionIds: string[] = [];

  for (;;) {
    if (failure !== undefined) {
      const phase = failure.stage;
      const phaseRepairAttempts =
        input.preparationRepairAttemptsByPhase[phase] ?? 0;
      const repair = await repairPreparationManifest({
        dependencies: input.dependencies,
        failureReport: failure,
        input: input.input,
        preparationManifest,
        phaseRepairAttempts,
        repoPreparationRepairLimit: input.repoPreparationRepairLimit,
        repoProfile: input.repoProfile,
        runPlan: input.runPlan,
        stageStatuses: input.stageStatuses,
        stageTimings: input.stageTimings,
        workspace: input.workspace,
      });
      input.preparationRepairAttemptsByPhase[phase] = phaseRepairAttempts + 1;
      if (repair.opencodeSessionId !== undefined) {
        opencodeSessionIds.push(repair.opencodeSessionId);
      }
      preparationManifest = await writeArtifact(
        input.dependencies,
        artifactPaths.preparationManifest,
        readPreparationManifest(repair.manifest),
      );
    }

    const preparationWorkspaceDiff =
      input.dependencies.capturePreparationWorkspaceDiff === undefined
        ? undefined
        : await writeArtifact(
            input.dependencies,
            artifactPaths.preparationWorkspaceDiff,
            await input.dependencies.capturePreparationWorkspaceDiff({
              workspace: input.workspace,
            }),
          );

    const preparationValidation = await runValidationStage(
      "preparation-preflight",
      input.dependencies,
      artifactPaths.preparationPreflight,
      input.validationReports,
      input.stageStatuses,
      input.stageTimings,
      () =>
        input.dependencies.validatePreparation({
          preparationManifest,
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
          workspace: input.workspace,
        }),
      input.validationAttemptCounts,
      input.preparationRepairAttemptsByPhase["preparation-preflight"] ?? 0,
    );
    if (preparationValidation.status === "passed") {
      return {
        opencodeSessionIds,
        preparationManifest,
        preparationValidation,
        ...(preparationWorkspaceDiff === undefined
          ? {}
          : { preparationWorkspaceDiff }),
      };
    }
    failure = preparationValidation;
  }
}

async function repairPreparationManifest(input: {
  dependencies: AgentHarnessPipelineDependencies;
  failureReport: ValidationReport;
  input: AgentHarnessPipelineInput;
  preparationManifest: PreparationManifest;
  phaseRepairAttempts: number;
  repoPreparationRepairLimit: number;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  workspace: AgentHarnessWorkspace;
}): Promise<{ manifest: PreparationManifest; opencodeSessionId?: string }> {
  const route = classifyRepairRoute(input.failureReport);
  if (
    route !== "repo-preparation-repair" ||
    input.dependencies.repairPreparation === undefined
  ) {
    assertValidationPassed(input.failureReport);
    throw new Error("Unreachable validation state.");
  }

  const budget = readRepairBudgetDecision({
    attempted: input.phaseRepairAttempts,
    limit: input.repoPreparationRepairLimit,
    route,
  });
  if (budget.status === "exhausted") {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${budget.reason}`,
    );
  }

  return await runAsyncStage(
    `${input.failureReport.stage}-repo-preparation-repair-${budget.nextAttempt}`,
    input.stageStatuses,
    input.stageTimings,
    () =>
      input.dependencies.repairPreparation?.({
        demoBrief: input.input.demoBrief,
        failureReport: input.failureReport,
        normalizedSupportingDocuments:
          input.input.normalizedSupportingDocuments,
        preparationManifest: input.preparationManifest,
        repoProfile: input.repoProfile,
        repoSourcePaths: input.input.files.map((file) => file.path),
        runPlan: input.runPlan,
        workspace: input.workspace,
      }) as Promise<{
        manifest: PreparationManifest;
        opencodeSessionId?: string;
      }>,
  );
}

function assertValidationPassed(report: ValidationReport): void {
  if (report.status !== "passed") {
    throw new Error(`${report.stage} failed: ${report.logsSummary}`);
  }
}

function runStage<T>(
  stage: string,
  stageStatuses: Record<string, string>,
  stageTimings: PipelineRunManifest["stageTimings"],
  callback: () => T,
): T {
  const startedAt = new Date().toISOString();
  stageStatuses[stage] = "running";
  try {
    const result = callback();
    stageStatuses[stage] = "passed";
    stageTimings.push({
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      finishedAt: new Date().toISOString(),
      stage,
      startedAt,
    });
    return result;
  } catch (error) {
    stageStatuses[stage] = "failed";
    stageTimings.push({
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      finishedAt: new Date().toISOString(),
      stage,
      startedAt,
    });
    throw error;
  }
}

async function runAsyncStage<T>(
  stage: string,
  stageStatuses: Record<string, string>,
  stageTimings: PipelineRunManifest["stageTimings"],
  callback: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  stageStatuses[stage] = "running";
  try {
    const result = await callback();
    stageStatuses[stage] = "passed";
    stageTimings.push({
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      finishedAt: new Date().toISOString(),
      stage,
      startedAt,
    });
    return result;
  } catch (error) {
    stageStatuses[stage] = "failed";
    stageTimings.push({
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      finishedAt: new Date().toISOString(),
      stage,
      startedAt,
    });
    throw error;
  }
}

async function writeArtifact<T>(
  dependencies: AgentHarnessPipelineDependencies,
  path: string,
  value: T,
): Promise<T> {
  await dependencies.artifactStore?.writeJson(path, value);
  return value;
}

async function persistRunManifest(input: {
  dependencies: AgentHarnessPipelineDependencies;
  input: AgentHarnessPipelineInput;
  opencodeSessionIds: string[];
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  status: PipelineRunManifest["finalStatus"];
  unsupportedOrFailureReason?: string;
  workspace: AgentHarnessWorkspace | undefined;
}): Promise<PipelineRunManifest> {
  const networkStateTransitions =
    (await input.workspace?.collectNetworkStateLog?.()) ?? [];
  const manifest = readPipelineRunManifest({
    artifactPaths,
    ...optionalString("commitSha", input.input.commitSha),
    daytonaSandboxIds: {
      ...optionalString("agent", input.workspace?.agentSandboxId),
      ...optionalString(
        "submittedCode",
        input.workspace?.submittedCodeSandboxId,
      ),
    },
    finalStatus: input.status,
    networkStateTransitions,
    opencodeSessionIds: [...new Set(input.opencodeSessionIds)],
    repoUrl: input.input.repoUrl,
    runId: input.input.runId,
    stageStatuses: input.stageStatuses,
    stageTimings: input.stageTimings,
    ...optionalString(
      "unsupportedOrFailureReason",
      input.unsupportedOrFailureReason,
    ),
  });
  await writeArtifact(
    input.dependencies,
    artifactPaths.pipelineRunManifest,
    manifest,
  );
  return manifest;
}

function requireWorkspace(
  workspace: AgentHarnessWorkspace | undefined,
): AgentHarnessWorkspace {
  if (workspace === undefined) {
    throw new Error("Agent harness workspace has not been created.");
  }
  return workspace;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value.trim().length === 0
    ? {}
    : ({ [key]: value } as Partial<Record<K, string>>);
}

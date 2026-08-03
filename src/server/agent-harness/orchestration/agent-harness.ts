import type { SubmittedAppExplorationResult } from "../app-explorer/submitted-app-explorer";
import {
  type AgentHarnessWorkspace,
  isAgentHarnessInfrastructureError,
} from "../daytona/workspace.interface";
import {
  classifyRepairRoute,
  isDependencyRepairFailure,
  readRepairBudgetDecision,
} from "../repair/repair-router";
import {
  isPackageManagerLockfilePath,
  readDependencyRepairDelta,
  validatePreparationFidelity,
} from "../repo-preparation/preparation-fidelity";
import type { PreparationWorkspaceDiff } from "../repo-preparation/preparation-workspace-diff";
import { assertPreparedFeatureInventory } from "../repo-preparation/prepared-feature-inventory";
import { profileRepo } from "../repo-profiler/repo-profiler";
import type { SecretQuarantineManifest } from "../repo-security/secret-quarantine";
import { screenStaticRepoSecurity } from "../repo-security/static-repo-security";
import {
  expandPreparationInstallScopeForMissingWorkspace,
  resolvePreparationRuntime,
} from "../run-planner/runtime-target-resolution";
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
import { ensureSceneNavigation } from "../script-contract/demo-script-contract";
import { readDisallowedScriptWritingChanges } from "../script-generation/read-only-boundary";
import {
  PreparationFallbackRequiredError,
  createPreparationFallbackArtifact,
} from "./preparation-fallback";

export type AgentHarnessPipelineInput = {
  commitSha?: string;
  demoBrief: {
    demoLengthSeconds?: number;
    keyProductFeatures?: string[];
    preferredAppDir?: string;
    productSummary?: string;
    targetUsers?: string;
  };
  files: Array<{ path: string; symlinkTarget?: string; text?: string }>;
  normalizedSupportingDocuments?: Array<Record<string, unknown>>;
  repoStats: {
    fileCount: number;
    sizeBytes: number;
  };
  repoUrl: string;
  rootDir?: string;
  runId: string;
  secretQuarantineManifest?: SecretQuarantineManifest;
};

type AgentHarnessArtifactStore = {
  writeJson(path: string, value: unknown): Promise<void>;
};

export type AgentHarnessPipelineDependencies = {
  artifactStore?: AgentHarnessArtifactStore;
  /**
   * Fingerprints every workspace path Script Writing may have touched. The
   * pipeline refuses to run without it: the script-writing read-only boundary
   * is enforced from its result, and a missing capture would silently skip
   * that enforcement.
   */
  captureWorkspaceDiff: (input: {
    workspace: AgentHarnessWorkspace;
  }) => Promise<string[]>;
  /**
   * Captures the preparation workspace's diff against screened sources. The
   * pipeline refuses to run without it: preparation-fidelity validation runs
   * on its result, and a missing capture would silently skip the entire
   * fidelity stage.
   */
  capturePreparationWorkspaceDiff: (input: {
    workspace: AgentHarnessWorkspace;
  }) => Promise<PreparationWorkspaceDiff>;
  createWorkspace(input: {
    repoProfile: RepoProfile;
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
  /**
   * Restores the last Preparation candidate accepted by backend fidelity
   * validation. Implementations must verify the screened-source revision and
   * patch digest before replacing the mutable workspace and manifest.
   */
  restorePreparationCandidate?(input: {
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
    workspace: AgentHarnessWorkspace;
    workspaceDiff: PreparationWorkspaceDiff;
  }): Promise<void>;
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
  synthesizeRunPlan(input: {
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    normalizedSupportingDocuments: AgentHarnessPipelineInput["normalizedSupportingDocuments"];
    repoProfile: RepoProfile;
    workspace: AgentHarnessWorkspace;
  }): Promise<RunPlan>;
  validateCapturePath(input: {
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    flowSpec: FlowSpec;
    preparationManifest: PreparationManifest;
    scriptCandidate: ScriptCandidate;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  validatePreparation(input: {
    /** Regenerate the package-manager lockfile before frozen installation. */
    reconcileLockfile?: boolean;
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
  /** Maximum Repo Preparation repairs allowed across the complete pipeline. */
  repoPreparationRepairLimit?: number;
  /** Maximum Script repairs allowed independently per failing validation stage. */
  scriptRepairLimit?: number;
};

/**
 * Bounded re-runs of Dynamic Capture Path Validation when the failure is a
 * classified transient infrastructure error rather than a script or repo
 * defect; repairs must never be spent on infrastructure flakes.
 */
const transientCaptureRetryLimit = 2;

const artifactPaths = {
  actionCatalog: "/workspace/.makeademo/action-catalog.json",
  agentArtifactAttempts: "/workspace/.makeademo/agent-artifact-attempts",
  appMap: "/workspace/.makeademo/app-map.json",
  appExplorationValidation:
    "/workspace/.makeademo/app-exploration-validation-report.json",
  capturePathValidation:
    "/workspace/.makeademo/capture-path-validation-report.json",
  capturePathPreflight:
    "/workspace/.makeademo/capture-path-preflight-validation-report.json",
  captureRuntimeReset:
    "/workspace/.makeademo/capture-runtime-reset-validation-report.json",
  demoScript: DEMO_SCRIPT_OUTPUT_PATH,
  externalResourceHydrationReport:
    "/workspace/.makeademo/external-resource-hydration-report.json",
  externalResourceManifest:
    "/workspace/.makeademo/external-resource-manifest.json",
  flowSpec: "/workspace/.makeademo/flow-spec.json",
  pipelineRunManifest: "/workspace/.makeademo/pipeline-run-manifest.json",
  preparationFallback: "/workspace/.makeademo/preparation-fallback.json",
  preparationFidelity:
    "/workspace/.makeademo/preparation-fidelity-validation-report.json",
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
  for (const requiredCapture of [
    "capturePreparationWorkspaceDiff",
    "captureWorkspaceDiff",
  ] as const) {
    if (typeof dependencies[requiredCapture] !== "function") {
      throw new Error(
        `Agent harness dependencies must provide ${requiredCapture}; workspace-diff enforcement is not optional.`,
      );
    }
  }
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
  const recordOpenCodeSessionId = (sessionId?: string) => {
    if (sessionId !== undefined && !opencodeSessionIds.includes(sessionId)) {
      opencodeSessionIds.push(sessionId);
    }
  };
  let primaryError: unknown;
  let preparationWorkspaceDiff: PreparationWorkspaceDiff | undefined;
  let preparationWorkspaceDiffCaptureAttempted = false;
  let preparationWorkspaceMutated = false;
  let workspace: AgentHarnessWorkspace | undefined;
  const capturePreparationWorkspaceDiff =
    async (): Promise<PreparationWorkspaceDiff> => {
      preparationWorkspaceDiffCaptureAttempted = true;
      preparationWorkspaceDiff = await writeArtifact(
        dependencies,
        artifactPaths.preparationWorkspaceDiff,
        await dependencies.capturePreparationWorkspaceDiff({
          workspace: requireWorkspace(workspace),
        }),
      );
      return preparationWorkspaceDiff;
    };

  const security = runStage(
    "static-repo-security-screen",
    stageStatuses,
    stageTimings,
    () =>
      screenStaticRepoSecurity({
        files: input.files,
        repoStats: input.repoStats,
        ...(input.secretQuarantineManifest === undefined
          ? {}
          : { secretQuarantineManifest: input.secretQuarantineManifest }),
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
    return {
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
        ...(input.secretQuarantineManifest === undefined
          ? {}
          : {
              quarantinedEnvironmentKeys:
                input.secretQuarantineManifest.entries.flatMap(
                  (entry) => entry.environmentKeys ?? [],
                ),
            }),
        repoUrl: input.repoUrl,
        ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
      }),
    );

    workspace = await dependencies.createWorkspace({ repoProfile });
    runPlan = await runAsyncStage(
      "run-plan-synthesis",
      stageStatuses,
      stageTimings,
      async () =>
        readRunPlan(
          await dependencies.synthesizeRunPlan({
            demoBrief: input.demoBrief,
            normalizedSupportingDocuments: input.normalizedSupportingDocuments,
            repoProfile,
            workspace: requireWorkspace(workspace),
          }),
        ),
    );
    await writeArtifact(dependencies, artifactPaths.runPlan, runPlan);
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
    if (options.destroyWorkspaceOnCompletion !== false) {
      try {
        await workspace?.destroy();
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
    }
    throw error;
  }

  try {
    preparationWorkspaceMutated = true;
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
    recordOpenCodeSessionId(preparation.opencodeSessionId);
    const preparedManifest = readPreparationManifest(preparation.manifest);
    assertPreparedFeatureInventory({
      demoBrief: input.demoBrief,
      preparationManifest: preparedManifest,
      repoProfile,
      repoSourcePaths: new Set(input.files.map((file) => file.path)),
      runPlan,
    });
    let preparationManifest = await writeArtifact(
      dependencies,
      artifactPaths.preparationManifest,
      preparedManifest,
    );

    const repoPreparationRepairLimit = options.repoPreparationRepairLimit ?? 5;
    const preparationRepairBudget: PreparationRepairBudget = {
      attemptedInstallScopes: new Set(),
      attemptsByFingerprint: {},
      totalAttempts: 0,
    };
    const preparationRepairAttemptsByPhase: Record<string, number> = {};
    const scriptRepairAttemptsByPhase: Record<string, number> = {};
    const dynamicActionFailureCounts: Record<string, number> = {};
    const excludedCatalogActionIds = new Set<string>();
    const withoutExcludedActions = (catalog: ActionCatalog): ActionCatalog =>
      excludedCatalogActionIds.size === 0
        ? catalog
        : readActionCatalog({
            ...catalog,
            actions: catalog.actions.filter(
              (action) => !excludedCatalogActionIds.has(action.id),
            ),
          });
    const scriptRepairLimit = options.scriptRepairLimit ?? 3;
    const validationAttemptCounts: Record<string, number> = {};
    let preparationState = await ensureValidPreparation({
      capturePreparationWorkspaceDiff,
      dependencies,
      input,
      preparationManifest,
      preparationRepairBudget,
      preparationRepairAttemptsByPhase,
      recordOpenCodeSessionId,
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
    let acceptedPreparation = preparationState.acceptedPreparation;
    let preparationValidation = preparationState.preparationValidation;

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
        if (
          explorationValidation.status === "failed" &&
          exploration.observation !== undefined
        ) {
          await writeArtifact(
            dependencies,
            `${artifactPaths.validationAttempts}/app-exploration/attempt-${explorationAttempt}-observation.json`,
            exploration.observation,
          );
        }
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
          ...(acceptedPreparation === undefined ? {} : { acceptedPreparation }),
          capturePreparationWorkspaceDiff,
          dependencies,
          initialFailure: explorationValidation,
          input,
          preparationManifest,
          preparationRepairBudget,
          preparationRepairAttemptsByPhase,
          recordOpenCodeSessionId,
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
        acceptedPreparation = preparationState.acceptedPreparation;
        preparationValidation = preparationState.preparationValidation;
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
          return ensureSceneNavigation({
            actionCatalog,
            scriptCandidate: candidate,
          });
        },
      );
      await writeArtifact(
        dependencies,
        artifactPaths.scriptCandidate,
        scriptCandidate,
      );

      let transientCaptureRetries = 0;
      for (;;) {
        const staticRepairAttempts =
          scriptRepairAttemptsByPhase["static-script-contract-validation"] ?? 0;
        const boundaryViolations = readDisallowedScriptWritingChanges(
          await dependencies.captureWorkspaceDiff({
            workspace: requireWorkspace(workspace),
          }),
        );
        const staticContractValidation = await runValidationStage(
          "static-script-contract-validation",
          dependencies,
          artifactPaths.staticScriptContract,
          validationReports,
          stageStatuses,
          stageTimings,
          async () =>
            boundaryViolations.length > 0
              ? createScriptBoundaryViolationReport(boundaryViolations)
              : dependencies.validateScriptContract({
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
        const capturePathPreflight = await runValidationStage(
          "capture-path-preflight",
          dependencies,
          artifactPaths.capturePathPreflight,
          validationReports,
          stageStatuses,
          stageTimings,
          async () => ({
            ...(await dependencies.resetCaptureRuntime({
              preparationManifest,
              repoProfile,
              runPlan,
              workspace: requireWorkspace(workspace),
            })),
            stage: "capture-path-preflight",
          }),
          validationAttemptCounts,
          captureRepairAttempts,
        );
        if (capturePathPreflight.status === "failed") {
          preparationState = await ensureValidPreparation({
            ...(acceptedPreparation === undefined
              ? {}
              : { acceptedPreparation }),
            capturePreparationWorkspaceDiff,
            dependencies,
            initialFailure: capturePathPreflight,
            input,
            preparationManifest,
            preparationRepairBudget,
            preparationRepairAttemptsByPhase,
            recordOpenCodeSessionId,
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
          acceptedPreparation = preparationState.acceptedPreparation;
          preparationValidation = preparationState.preparationValidation;
          continue pipelineAttempt;
        }
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
          capturePathValidation.failureClassification ===
            "transient infrastructure failure" &&
          transientCaptureRetries < transientCaptureRetryLimit
        ) {
          transientCaptureRetries += 1;
          continue;
        }

        if (
          classifyRepairRoute(capturePathValidation) ===
          "repo-preparation-repair"
        ) {
          preparationState = await ensureValidPreparation({
            ...(acceptedPreparation === undefined
              ? {}
              : { acceptedPreparation }),
            capturePreparationWorkspaceDiff,
            dependencies,
            initialFailure: capturePathValidation,
            input,
            preparationManifest,
            preparationRepairBudget,
            preparationRepairAttemptsByPhase,
            recordOpenCodeSessionId,
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
          acceptedPreparation = preparationState.acceptedPreparation;
          preparationValidation = preparationState.preparationValidation;
          continue pipelineAttempt;
        }

        // Flow-lock escape: when one catalog action keeps failing dynamic
        // validation, retrying and re-grounding reproduce the same plan. The
        // second failure removes the action from the catalog and re-plans the
        // flow so an alternative demonstration must be selected.
        const failingActionId = readFailingCatalogActionId(
          capturePathValidation,
          scriptCandidate,
          actionCatalog,
        );
        let flowReplanned = false;
        if (failingActionId !== undefined) {
          const failures =
            (dynamicActionFailureCounts[failingActionId] ?? 0) + 1;
          dynamicActionFailureCounts[failingActionId] = failures;
          if (failures >= 2 && !excludedCatalogActionIds.has(failingActionId)) {
            excludedCatalogActionIds.add(failingActionId);
            actionCatalog = await writeArtifact(
              dependencies,
              artifactPaths.actionCatalog,
              withoutExcludedActions(actionCatalog),
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
            flowReplanned = true;
          }
        }

        if (
          !flowReplanned &&
          capturePathValidation.failureClassification === "locator failure"
        ) {
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
            withoutExcludedActions(
              readActionCatalog(regrounding.actionCatalog),
            ),
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

    if (preparationWorkspaceDiff === undefined) {
      preparationWorkspaceDiff = await capturePreparationWorkspaceDiff();
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
    recordOpenCodeSessionId(failedSessionId);
    let preparationWorkspaceDiffError: unknown;
    if (
      preparationWorkspaceMutated &&
      !preparationWorkspaceDiffCaptureAttempted &&
      workspace !== undefined
    ) {
      try {
        preparationWorkspaceDiff = await capturePreparationWorkspaceDiff();
      } catch (diffError) {
        preparationWorkspaceDiffError = diffError;
      }
    }
    stageStatuses["agent-harness"] = "failed";
    const preparationFailedStage = readPreparationFailedStage(
      stageStatuses,
      validationReports,
    );
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
    if (preparationWorkspaceDiffError !== undefined) {
      attachSecondaryError(
        surfacedError,
        "preparationWorkspaceDiffError",
        preparationWorkspaceDiffError,
      );
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
        // On the success path the result has already been returned and the run
        // manifest persisted; a late destroy failure must not undo either.
        if (primaryError !== undefined) {
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
  throw new Error("Agent harness finished without a result.");
}

function readPreparationFailedStage(
  stageStatuses: Record<string, string>,
  validationReports: ValidationReport[],
): string | undefined {
  for (let index = validationReports.length - 1; index >= 0; index -= 1) {
    const report = validationReports[index];
    if (
      report?.status === "failed" &&
      stageStatuses[report.stage] === "failed" &&
      isPreparationStage(report.stage)
    ) {
      return report.stage;
    }
  }
  return Object.entries(stageStatuses)
    .reverse()
    .find(
      ([stage, status]) => status === "failed" && isPreparationStage(stage),
    )?.[0];
}

function isPreparationStage(stage: string): boolean {
  return (
    stage === "repo-preparation" ||
    stage === "preparation-fidelity" ||
    stage === "preparation-preflight" ||
    stage === "app-exploration"
  );
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
      validationAttemptArtifactPath(stage, attempt),
      report,
    ),
  ]);
  return report;
}

function validationAttemptArtifactPath(
  stage: string,
  attempt: number,
  suffix = "",
): string {
  return `${artifactPaths.validationAttempts}/${stage.replaceAll(/[^A-Za-z0-9_-]/g, "-")}/attempt-${attempt}${suffix}.json`;
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
  return ensureSceneNavigation({
    actionCatalog: input.actionCatalog,
    scriptCandidate: repairedCandidate,
  });
}

function createScriptBoundaryViolationReport(
  disallowedPaths: string[],
): ValidationReport {
  return readValidationReport({
    artifactReferences: [],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    failureClassification: "script modified app source",
    logsSummary: `Script Writing modified disallowed workspace paths: ${disallowedPaths.join(", ")}. Only the demo-script artifacts under /workspace/.makeademo may change.`,
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage: "static-script-contract-validation",
    status: "failed",
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: [
      "Revert every application-source change; Script Writing may only write the demo-script artifacts.",
    ],
  });
}

type AcceptedPreparationCandidate = {
  manifest: PreparationManifest;
  workspaceDiff: PreparationWorkspaceDiff;
};

type PreparationRepairBudget = {
  attemptedInstallScopes: Set<string>;
  attemptsByFingerprint: Record<string, number>;
  totalAttempts: number;
};

async function ensureValidPreparation(input: {
  acceptedPreparation?: AcceptedPreparationCandidate;
  capturePreparationWorkspaceDiff: () => Promise<PreparationWorkspaceDiff>;
  dependencies: AgentHarnessPipelineDependencies;
  initialFailure?: ValidationReport;
  input: AgentHarnessPipelineInput;
  preparationManifest: PreparationManifest;
  preparationRepairBudget: PreparationRepairBudget;
  preparationRepairAttemptsByPhase: Record<string, number>;
  recordOpenCodeSessionId: (sessionId?: string) => void;
  repoPreparationRepairLimit: number;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  validationReports: ValidationReport[];
  validationAttemptCounts: Record<string, number>;
  workspace: AgentHarnessWorkspace;
}): Promise<{
  acceptedPreparation: AcceptedPreparationCandidate | undefined;
  preparationManifest: PreparationManifest;
  preparationValidation: ValidationReport;
}> {
  let preparationManifest = input.preparationManifest;
  let failure = input.initialFailure;
  let acceptedPreparation = input.acceptedPreparation;
  let activeRepairFailure: ValidationReport | undefined;
  let dependencyRepair = false;
  let reconcileLockfile = false;
  let repairBaseline: PreparationWorkspaceDiff | undefined;
  let lastWorkspaceDiff = acceptedPreparation?.workspaceDiff;
  const attemptedInstallScopes =
    input.preparationRepairBudget.attemptedInstallScopes;
  attemptedInstallScopes.add(input.preparationManifest.installCommandUsed);

  for (;;) {
    if (failure !== undefined) {
      const expandedPreparation =
        expandPreparationInstallScopeForMissingWorkspace({
          failureReport: failure,
          preparationManifest,
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
        });
      if (
        expandedPreparation !== undefined &&
        !attemptedInstallScopes.has(expandedPreparation.installCommandUsed)
      ) {
        attemptedInstallScopes.add(expandedPreparation.installCommandUsed);
        input.preparationRepairBudget.totalAttempts += 1;
        preparationManifest = await writeArtifact(
          input.dependencies,
          artifactPaths.preparationManifest,
          expandedPreparation,
        );
        failure = undefined;
      } else {
        const manifestBeforeRepair = preparationManifest;
        const workspaceDiffBeforeRepair = lastWorkspaceDiff;
        const repairingDependencies = isDependencyRepairFailure(
          failure.failureClassification,
        );
        const phase = failure.stage;
        const fingerprint = preparationFailureFingerprint(failure);
        const fingerprintRepairAttempts =
          input.preparationRepairBudget.attemptsByFingerprint[fingerprint] ?? 0;
        const phaseRepairAttempts =
          input.preparationRepairAttemptsByPhase[phase] ?? 0;
        const repair = await repairPreparationManifest({
          dependencies: input.dependencies,
          failureReport: failure,
          input: input.input,
          preparationManifest,
          phaseRepairAttempts,
          fingerprintRepairAttempts,
          repoPreparationRepairLimit: input.repoPreparationRepairLimit,
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
          stageStatuses: input.stageStatuses,
          stageTimings: input.stageTimings,
          totalRepairAttempts: input.preparationRepairBudget.totalAttempts,
          workspace: input.workspace,
        });
        input.preparationRepairBudget.attemptsByFingerprint[fingerprint] =
          fingerprintRepairAttempts + 1;
        input.preparationRepairBudget.totalAttempts += 1;
        input.preparationRepairAttemptsByPhase[phase] = phaseRepairAttempts + 1;
        input.recordOpenCodeSessionId(repair.opencodeSessionId);
        const repairedManifest = readPreparationManifest(repair.manifest);
        // A dependency repair's manifest is discarded below in favor of the
        // pre-repair manifest, so only a manifest the pipeline will adopt is
        // held to the feature-inventory contract.
        if (!repairingDependencies) {
          assertPreparedFeatureInventory({
            demoBrief: input.input.demoBrief,
            preparationManifest: repairedManifest,
            repoProfile: input.repoProfile,
            repoSourcePaths: new Set(
              input.input.files.map((file) => file.path),
            ),
            runPlan: input.runPlan,
          });
        }
        preparationManifest = await writeArtifact(
          input.dependencies,
          artifactPaths.preparationManifest,
          repairingDependencies ? manifestBeforeRepair : repairedManifest,
        );
        activeRepairFailure = failure;
        dependencyRepair = repairingDependencies;
        repairBaseline = workspaceDiffBeforeRepair;
      }
    }

    const resolvedPreparation = resolvePreparationRuntime({
      preparationManifest,
      repoProfile: input.repoProfile,
      runPlan: input.runPlan,
    }).preparationManifest;
    if (!sameRuntimeConfiguration(preparationManifest, resolvedPreparation)) {
      preparationManifest = await writeArtifact(
        input.dependencies,
        artifactPaths.preparationManifest,
        resolvedPreparation,
      );
    }

    reconcileLockfile = false;
    const workspaceDiff = await input.capturePreparationWorkspaceDiff();
    lastWorkspaceDiff = workspaceDiff;
    const fidelityAttempt =
      (input.validationAttemptCounts["preparation-fidelity"] ?? 0) + 1;
    await writeArtifact(
      input.dependencies,
      validationAttemptArtifactPath(
        "preparation-fidelity",
        fidelityAttempt,
        "-workspace-diff",
      ),
      {
        ...workspaceDiff,
        ...(acceptedPreparation === undefined
          ? {}
          : {
              acceptedBaselinePatchSha256:
                acceptedPreparation.workspaceDiff.patchSha256,
            }),
        repair:
          repairBaseline === undefined
            ? "none"
            : dependencyRepair
              ? "dependency"
              : "runtime",
      },
    );
    const repairDelta =
      repairBaseline === undefined
        ? undefined
        : readDependencyRepairDelta(repairBaseline, workspaceDiff);
    const unchangedDependencyRepair =
      dependencyRepair && repairDelta?.changedPaths.length === 0;
    reconcileLockfile = repairDelta?.dependencyInputsChanged ?? false;
    const fidelityValidation = await runValidationStage(
      "preparation-fidelity",
      input.dependencies,
      artifactPaths.preparationFidelity,
      input.validationReports,
      input.stageStatuses,
      input.stageTimings,
      async () =>
        validatePreparationFidelity({
          ...(repairBaseline === undefined
            ? {}
            : { dependencyRepair, repairBaseline }),
          preparationManifest,
          repoSourceFiles: new Map(
            input.input.files.map((file) => [file.path, file.text] as const),
          ),
          workspaceDiff,
        }),
      input.validationAttemptCounts,
      input.preparationRepairAttemptsByPhase["preparation-fidelity"] ?? 0,
    );
    dependencyRepair = false;
    repairBaseline = undefined;
    if (fidelityValidation.status === "failed") {
      reconcileLockfile = false;
      if (
        acceptedPreparation !== undefined &&
        activeRepairFailure !== undefined &&
        input.dependencies.restorePreparationCandidate !== undefined
      ) {
        await input.dependencies.restorePreparationCandidate({
          preparationManifest: acceptedPreparation.manifest,
          repoProfile: input.repoProfile,
          workspace: input.workspace,
          workspaceDiff: acceptedPreparation.workspaceDiff,
        });
        preparationManifest = acceptedPreparation.manifest;
        lastWorkspaceDiff = acceptedPreparation.workspaceDiff;
        failure = appendRepairRejection(
          activeRepairFailure,
          fidelityValidation,
          workspaceDiff.changedPaths,
        );
        activeRepairFailure = undefined;
      } else {
        failure = fidelityValidation;
      }
      continue;
    }
    if (unchangedDependencyRepair && activeRepairFailure !== undefined) {
      failure = {
        ...activeRepairFailure,
        logsSummary: `${activeRepairFailure.logsSummary} Rejected repair: no package manifest or recognized package-manager configuration changed.`,
        suggestedRepairHints: [
          ...activeRepairFailure.suggestedRepairHints,
          "Change the dependency metadata responsible for the reported install failure; do not rewrite the manifest or executable source.",
        ],
      };
      activeRepairFailure = undefined;
      continue;
    }
    acceptedPreparation = { manifest: preparationManifest, workspaceDiff };
    activeRepairFailure = undefined;

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
          ...(reconcileLockfile ? { reconcileLockfile: true } : {}),
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
          workspace: input.workspace,
        }),
      input.validationAttemptCounts,
      input.preparationRepairAttemptsByPhase["preparation-preflight"] ?? 0,
    );
    if (
      preparationValidation.status === "failed" &&
      preparationValidation.failureClassification === "install failure"
    ) {
      const postValidationDiff = await input.capturePreparationWorkspaceDiff();
      lastWorkspaceDiff = postValidationDiff;
      if (
        acceptedPreparation !== undefined &&
        readDependencyRepairDelta(
          acceptedPreparation.workspaceDiff,
          postValidationDiff,
        ).onlyLockfiles
      ) {
        acceptedPreparation = {
          manifest: preparationManifest,
          workspaceDiff: postValidationDiff,
        };
      }
    }
    if (preparationValidation.status === "passed") {
      return {
        acceptedPreparation,
        preparationManifest,
        preparationValidation,
      };
    }
    failure = preparationValidation;
  }
}

function appendRepairRejection(
  originalFailure: ValidationReport,
  fidelityFailure: ValidationReport,
  vetoedChangedPaths: readonly string[],
): ValidationReport {
  // The rejection reverted the whole candidate, including its correct parts;
  // without this pointer a fresh repair agent rebuilds only what the latest
  // veto complained about and loses the rest. Prose alone recovered 11 of 13
  // files in the 2026-08-02 midday run — the concrete list closes the gap.
  // Lockfiles are excluded: the backend regenerates them and repairs must not
  // touch them.
  const preservedFiles = vetoedChangedPaths
    .map((path) => path.replace(/^\/workspace\/repo\//, ""))
    .filter(
      (path) =>
        !isPackageManagerLockfilePath(path) &&
        !fidelityFailure.logsSummary.includes(path),
    );
  const preservedList =
    preservedFiles.length === 0
      ? ""
      : ` Files to re-apply unchanged: ${preservedFiles.slice(0, 24).join(", ")}${
          preservedFiles.length > 24
            ? ` (and ${preservedFiles.length - 24} more in the diff)`
            : ""
        }.`;
  const vetoedCandidateHint = `The rejected candidate was reverted; the workspace matches the last accepted state again. Its full diff remains readable at ${artifactPaths.preparationWorkspaceDiff}. Only the files named in the rejection violated fidelity: fix those and re-apply the candidate's other changes unchanged.${preservedList}`;
  return {
    ...originalFailure,
    artifactReferences: [
      ...new Set([
        ...originalFailure.artifactReferences,
        ...fidelityFailure.artifactReferences,
      ]),
    ],
    logsSummary: `${originalFailure.logsSummary} Rejected repair: ${fidelityFailure.logsSummary}`,
    suggestedRepairHints: [
      ...new Set([
        // A prior rejection's hint describes a stale candidate; replace it so
        // the file list always matches the diff artifact's current content.
        ...originalFailure.suggestedRepairHints.filter(
          (hint) => !hint.includes(artifactPaths.preparationWorkspaceDiff),
        ),
        ...fidelityFailure.suggestedRepairHints,
        vetoedCandidateHint,
      ]),
    ],
  };
}

function sameRuntimeConfiguration(
  left: PreparationManifest,
  right: PreparationManifest,
): boolean {
  return (
    left.appDir === right.appDir &&
    left.baseUrl === right.baseUrl &&
    left.buildCommandUsed === right.buildCommandUsed &&
    left.installCommandUsed === right.installCommandUsed &&
    left.startCommandUsed === right.startCommandUsed &&
    left.ports.length === right.ports.length &&
    left.ports.every((port, index) => port === right.ports[index])
  );
}

async function repairPreparationManifest(input: {
  dependencies: AgentHarnessPipelineDependencies;
  failureReport: ValidationReport;
  fingerprintRepairAttempts: number;
  input: AgentHarnessPipelineInput;
  preparationManifest: PreparationManifest;
  phaseRepairAttempts: number;
  repoPreparationRepairLimit: number;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  totalRepairAttempts: number;
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

  if (input.totalRepairAttempts >= input.repoPreparationRepairLimit) {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${route} global retry budget exhausted after ${input.repoPreparationRepairLimit} attempts`,
    );
  }
  const repeatedFailureLimit = Math.min(
    input.failureReport.stage === "preparation-fidelity" ? 1 : 2,
    input.repoPreparationRepairLimit,
  );
  if (input.fingerprintRepairAttempts >= repeatedFailureLimit) {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${route} repeated failure retry budget exhausted after ${repeatedFailureLimit} attempts`,
    );
  }
  const nextAttempt = input.phaseRepairAttempts + 1;

  return await runAsyncStage(
    `${input.failureReport.stage}-repo-preparation-repair-${nextAttempt}`,
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

/**
 * Identifies the ActionCatalog action behind a dynamic capture failure via the
 * failing script action's sourceActionId, so repeated failures of one action
 * can change the planning input instead of retrying the same plan.
 */
function readFailingCatalogActionId(
  report: ValidationReport,
  scriptCandidate: ScriptCandidate,
  actionCatalog: ActionCatalog,
): string | undefined {
  const scriptActionId =
    /Browser action ([A-Za-z0-9_][A-Za-z0-9_-]*) failed/.exec(
      report.logsSummary,
    )?.[1];
  if (scriptActionId === undefined) {
    return undefined;
  }
  const script = scriptCandidate.scriptJsonContent;
  const scenes =
    typeof script === "object" && script !== null
      ? (script as { scenes?: unknown }).scenes
      : undefined;
  const scriptActions = Array.isArray(scenes)
    ? scenes.flatMap((scene) =>
        typeof scene === "object" &&
        scene !== null &&
        Array.isArray((scene as { actions?: unknown }).actions)
          ? ((scene as { actions: unknown[] }).actions.filter(
              (action): action is Record<string, unknown> =>
                typeof action === "object" && action !== null,
            ) ?? [])
          : [],
      )
    : [];
  const failingAction = scriptActions.find(
    (action) => action.id === scriptActionId,
  );
  const candidateId =
    typeof failingAction?.sourceActionId === "string"
      ? failingAction.sourceActionId
      : scriptActionId;
  return actionCatalog.actions.some((action) => action.id === candidateId)
    ? candidateId
    : undefined;
}

function preparationFailureFingerprint(report: ValidationReport): string {
  const rejectionParts = report.logsSummary.split(" Rejected repair:");
  return [
    report.stage,
    report.failureClassification ?? "unknown",
    report.attemptedCommand ?? "",
    normalizeFailureSummaryLine(rejectionParts[0] ?? ""),
    normalizeFailureSummaryLine(
      rejectionParts.length === 1 ? "" : (rejectionParts.at(-1) ?? ""),
    ),
  ].join("\u0000");
}

/**
 * Reduces a failure summary to its identity-bearing first line: run-varying
 * noise (timestamps, ids, durations, ports, temp paths) must not make the
 * same failure look new, or the repeated-failure limit never triggers.
 */
function normalizeFailureSummaryLine(summary: string): string {
  return (summary.split("\n", 1)[0] ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, "<time>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<id>")
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|minutes?)\b/g,
      "<duration>",
    )
    .replace(/\/(?:private\/)?tmp\/[^\s"'`)\]]+/g, "<path>")
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\b/g, "<host>")
    .replace(/\bports?\s+\d+\b/g, "port <port>")
    .replace(/\s+/g, " ")
    .trim();
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

import {
  type BrowserAction,
  readBrowserActions,
} from "../../pipeline/06-footage-capture/browser-action-plan";
import { readLastErrorCauseLine } from "../app-explorer/stderr-error-signal";
import type {
  CaptureLocatorFailure,
  SubmittedAppExplorationResult,
} from "../app-explorer/submitted-app-explorer";
import {
  AgentHarnessJobDeadlineError,
  type AgentHarnessWorkspace,
  isAgentHarnessInfrastructureError,
} from "../daytona/workspace.interface";
import {
  classifyRepairRoute,
  isDependencyRepairFailure,
  readRepairBudgetDecision,
  repairBudgetExhaustedMessage,
} from "../repair/repair-router";
import {
  type FidelityCandidate,
  createPreparationFidelityReport,
  isPackageManagerLockfilePath,
  readDependencyRepairDelta,
  readPreparationFidelityCandidates,
  reconcileFidelityAdjudication,
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
import { makeADemoArtifactPaths } from "../schemas/artifact-paths";
import {
  type ActionCatalog,
  type AppMap,
  DEMO_SCRIPT_OUTPUT_PATH,
  type FidelityAdjudicationVerdict,
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
  DEFAULT_NODE_LINE,
  createNodeLineSwapCommand,
  resolveNodeLine,
} from "../tools/node-line-resolution";
import {
  PreparationFallbackRequiredError,
  createPreparationFallbackArtifact,
} from "./preparation-fallback";

export type AgentHarnessPipelineInput = {
  archiveSizeBytes?: number;
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
  repoUrl: string;
  rootDir?: string;
  runId: string;
  secretQuarantineManifest?: SecretQuarantineManifest;
};

type AgentHarnessArtifactStore = {
  writeJson(path: string, value: unknown): Promise<void>;
};

export type AgentHarnessPipelineDependencies = {
  /**
   * Adjudicates preparation-fidelity candidate vetoes with one agent judge
   * command in the preparation sandbox. Implementations must source verdicts
   * from a schema-validated artifact the judge wrote and return one verdict
   * per candidate index they judged; returning undefined (or throwing a
   * non-infrastructure error) reports the stage unadjudicated and every
   * candidate verdict stands. The judge can only rescue false vetoes — its
   * absence must never weaken the gate.
   */
  adjudicateFidelityCandidates?(input: {
    candidates: FidelityCandidate[];
    preparationManifest: PreparationManifest;
    workspace: AgentHarnessWorkspace;
    workspaceDiff: PreparationWorkspaceDiff;
  }): Promise<FidelityAdjudicationVerdict[] | undefined>;
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
    /**
     * The Demo Script about to be filmed. The reset re-probes every scene's
     * navigation route on the freshly restarted app, so a route that reverted
     * to failing after the reset fails the gate instead of being filmed.
     */
    scriptCandidate: ScriptCandidate;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  exploreApp(input: {
    actionCatalogPath: string;
    appMapPath: string;
    /**
     * Present only on locator-regrounding calls (N125): the typed identity
     * of the capture-failed action — its verified locator and candidate id,
     * the scene's action prefix ahead of it, and the failure screenshot —
     * so exploration can re-verify the candidate in the context capture
     * will replay it in, instead of from a fresh route load.
     */
    captureFailure?: CaptureLocatorFailure;
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
    /**
     * False skips the gated dependency install: the orchestrator passes it
     * on repair rounds whose diff leaves dependency inputs unchanged, so
     * the sandbox's warm node_modules from the prior round is reused.
     */
    installDependencies?: boolean;
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
  /**
   * Films the statically and dynamically accepted Demo Script from the fresh
   * capture runtime. A failed browser action returns the same typed
   * ValidationReport shape as Capture Path Validation so the orchestrator can
   * spend the bounded Script Repair lane, re-run every gate, and retake.
   */
  captureAcceptedScript?(input: {
    captureRuntimeReset: {
      artifactPath: string;
      stage: "capture-runtime-reset";
      status: "passed";
    };
    preparationManifest: PreparationManifest;
    scriptCandidate: ScriptCandidate;
    workspace: AgentHarnessWorkspace;
  }): Promise<ValidationReport>;
  destroyWorkspaceOnCompletion?: boolean;
  /** Wall-clock budget for the whole job; default 90 minutes. */
  jobDeadlineMs?: number;
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

const artifactPaths = makeADemoArtifactPaths;

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
  // One wall-clock budget bounds the whole job. Checked at every stage-loop
  // boundary so a repair spiral ends as one classified infrastructure
  // timeout with the accumulated stage evidence, never a many-hour hang.
  const jobDeadlineMs = options.jobDeadlineMs ?? 90 * 60_000;
  const jobDeadlineAtMs = Date.now() + jobDeadlineMs;
  const assertJobWithinDeadline = () => {
    if (Date.now() >= jobDeadlineAtMs) {
      throw new AgentHarnessJobDeadlineError(jobDeadlineMs);
    }
  };
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
        ...(input.archiveSizeBytes === undefined
          ? {}
          : { archiveSizeBytes: input.archiveSizeBytes }),
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
    runPlan = {
      ...runPlan,
      nodeLine: resolveNodeLine({
        files: input.files,
        ...(runPlan.targetSelection?.targetId === undefined
          ? {}
          : { targetId: runPlan.targetSelection.targetId }),
      }),
    };
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
    await activatePinnedNodeLine(requireWorkspace(workspace), runPlan);
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
      bonusRounds: 0,
      totalAttempts: 0,
    };
    const preparationRepairAttemptsByPhase: Record<string, number> = {};
    const scriptRepairAttemptsByPhase: Record<string, number> = {};
    const dynamicActionFailureCounts: Record<string, number> = {};
    // N125(4): the ping-pong breaker's chain state. A capture-path locator
    // failure arms `pendingCaptureLocatorFailure`; a static locator-equality
    // rejection naming the same action completes one alternation pair. Two
    // pairs on one action mean the two validation channels contradict each
    // other — capture rejects the browser-verified candidate at replay while
    // the static contract rejects every locator that differs from it — so
    // the run stops with the combined diagnosis instead of silently
    // exhausting both repair budgets.
    let pendingCaptureLocatorFailure:
      | { actionId: string; summary: string }
      | undefined;
    let locatorAlternation: { actionId: string; pairs: number } | undefined;
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
    const preparationState = await ensureValidPreparation({
      assertJobWithinDeadline,
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
    // Every mid-pipeline preparation failure re-enters validated preparation
    // with the same budgets and bindings; only the triggering failure varies.
    const revalidatePreparation = async (initialFailure: ValidationReport) => {
      const revalidatedState = await ensureValidPreparation({
        ...(acceptedPreparation === undefined ? {} : { acceptedPreparation }),
        assertJobWithinDeadline,
        capturePreparationWorkspaceDiff,
        dependencies,
        initialFailure,
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
      preparationManifest = revalidatedState.preparationManifest;
      acceptedPreparation = revalidatedState.acceptedPreparation;
      preparationValidation = revalidatedState.preparationValidation;
    };

    let appMap: AppMap;
    let actionCatalog: ActionCatalog;
    let flowSpec: FlowSpec;
    let scriptCandidate: ScriptCandidate;
    // Re-plans the flow against the current catalog and app map after a
    // grounding change, persisting the replanned FlowSpec artifact.
    const replanFlow = async () => {
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
    };
    pipelineAttempt: for (;;) {
      for (;;) {
        assertJobWithinDeadline();
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
            validationAttemptArtifactPath(
              "app-exploration",
              explorationAttempt,
            ),
            explorationValidation,
          ),
        ]);
        if (
          explorationValidation.status === "failed" &&
          exploration.observation !== undefined
        ) {
          await writeArtifact(
            dependencies,
            validationAttemptArtifactPath(
              "app-exploration",
              explorationAttempt,
              "-observation",
            ),
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

        await revalidatePreparation(explorationValidation);
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
        assertJobWithinDeadline();
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
          const equalityRejectionActionId =
            /Browser action ([A-Za-z0-9_][A-Za-z0-9_-]*) locator does not match browser-verified candidate/.exec(
              staticContractValidation.logsSummary,
            )?.[1];
          if (
            equalityRejectionActionId !== undefined &&
            pendingCaptureLocatorFailure?.actionId === equalityRejectionActionId
          ) {
            const pairs =
              locatorAlternation?.actionId === equalityRejectionActionId
                ? locatorAlternation.pairs + 1
                : 1;
            locatorAlternation = {
              actionId: equalityRejectionActionId,
              pairs,
            };
            if (pairs >= 2) {
              throw new Error(
                `Locator ping-pong on browser action ${equalityRejectionActionId}: capture-path validation keeps failing its browser-verified locator at replay, while static contract validation rejects every locator that differs from that candidate. The two channels contradict each other — the candidate's evidence does not hold at replay, so the fix is re-grounded evidence or preparation repair, not another script repair. Capture failure: ${pendingCaptureLocatorFailure.summary} Static rejection: ${staticContractValidation.logsSummary}`,
              );
            }
          } else if (equalityRejectionActionId === undefined) {
            // A static failure of any other shape breaks the alternation.
            locatorAlternation = undefined;
          }
          pendingCaptureLocatorFailure = undefined;
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
              scriptCandidate,
              workspace: requireWorkspace(workspace),
            })),
            stage: "capture-path-preflight",
          }),
          validationAttemptCounts,
          captureRepairAttempts,
        );
        if (capturePathPreflight.status === "failed") {
          await revalidatePreparation(capturePathPreflight);
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
                scriptCandidate,
                workspace: requireWorkspace(workspace),
              }),
            validationAttemptCounts,
          );
          assertValidationPassed(resetValidation);
          const captureAcceptedScript = options.captureAcceptedScript;
          if (captureAcceptedScript === undefined) {
            break;
          }

          assertJobWithinDeadline();
          const footageRepairAttempts =
            scriptRepairAttemptsByPhase["footage-capture"] ?? 0;
          const footageCaptureValidation = await runValidationStage(
            "footage-capture",
            dependencies,
            artifactPaths.footageCaptureValidation,
            validationReports,
            stageStatuses,
            stageTimings,
            () =>
              captureAcceptedScript({
                captureRuntimeReset: {
                  artifactPath: artifactPaths.captureRuntimeReset,
                  stage: "capture-runtime-reset",
                  status: "passed",
                },
                preparationManifest,
                scriptCandidate,
                workspace: requireWorkspace(workspace),
              }),
            validationAttemptCounts,
            footageRepairAttempts,
          );
          if (footageCaptureValidation.status === "passed") {
            break;
          }
          if (
            classifyRepairRoute(footageCaptureValidation) ===
            "repo-preparation-repair"
          ) {
            await revalidatePreparation(footageCaptureValidation);
            continue pipelineAttempt;
          }

          scriptCandidate = await repairScriptCandidate({
            actionCatalog,
            appMap,
            dependencies,
            failureReport: footageCaptureValidation,
            flowSpec,
            preparationManifest,
            repoProfile,
            scriptCandidate,
            scriptRepairAttempts: footageRepairAttempts,
            scriptRepairLimit,
            stageStatuses,
            stageTimings,
            workspace: requireWorkspace(workspace),
          });
          scriptRepairAttemptsByPhase["footage-capture"] =
            footageRepairAttempts + 1;
          await writeArtifact(
            dependencies,
            artifactPaths.scriptCandidate,
            scriptCandidate,
          );
          continue;
        }

        if (
          capturePathValidation.failureClassification ===
            "transient infrastructure failure" &&
          transientCaptureRetries < transientCaptureRetryLimit
        ) {
          transientCaptureRetries += 1;
          continue;
        }

        // N125(4): a locator failure arms the breaker's pending half-pair;
        // any other capture verdict breaks the alternation chain.
        if (capturePathValidation.failureClassification === "locator failure") {
          const failedActionId =
            capturePathValidation.failedAction?.actionId ??
            /Browser action ([A-Za-z0-9_][A-Za-z0-9_-]*) failed/.exec(
              capturePathValidation.logsSummary,
            )?.[1];
          pendingCaptureLocatorFailure =
            failedActionId === undefined
              ? undefined
              : {
                  actionId: failedActionId,
                  summary: capturePathValidation.logsSummary,
                };
        } else {
          pendingCaptureLocatorFailure = undefined;
          locatorAlternation = undefined;
        }

        if (
          classifyRepairRoute(capturePathValidation) ===
          "repo-preparation-repair"
        ) {
          await revalidatePreparation(capturePathValidation);
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
            await replanFlow();
            flowReplanned = true;
          }
        }

        if (
          !flowReplanned &&
          capturePathValidation.failureClassification === "locator failure"
        ) {
          const captureFailure = readCaptureLocatorFailure(
            capturePathValidation,
            scriptCandidate,
          );
          const regrounding = await runAsyncStage(
            "locator-regrounding",
            stageStatuses,
            stageTimings,
            () =>
              dependencies.exploreApp({
                actionCatalogPath: artifactPaths.actionCatalog,
                appMapPath: artifactPaths.appMap,
                ...(captureFailure === undefined ? {} : { captureFailure }),
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
              validationAttemptArtifactPath(
                "locator-regrounding",
                regroundingAttempt,
              ),
              regroundingValidation,
            ),
          ]);
          // N125(3): a regrounding that honestly reports app-state
          // divergence (the candidate stayed missing after prefix replay)
          // is a preparation defect, not a reason to kill the run — the
          // pipeline re-enters from validated preparation like every other
          // preparation-routed capture failure.
          if (
            regroundingValidation.status === "failed" &&
            classifyRepairRoute(regroundingValidation) ===
              "repo-preparation-repair"
          ) {
            await revalidatePreparation(regroundingValidation);
            continue pipelineAttempt;
          }
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
          await replanFlow();
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
  }

  const budget = readRepairBudgetDecision({
    attempted: input.scriptRepairAttempts,
    limit: input.scriptRepairLimit,
    route: "script-repair",
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
  bonusRounds: number;
  lastFailingFeatureIds?: readonly string[];
  totalAttempts: number;
};

async function ensureValidPreparation(input: {
  acceptedPreparation?: AcceptedPreparationCandidate;
  assertJobWithinDeadline: () => void;
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
  let manifestBaseline: PreparationManifest | undefined;
  // Set when a repair ran this round; applied only once the repair proves
  // real. A no-op repair is a non-attempt and spends no budget (N109),
  // apart from the grace-bounded safeguard below.
  let pendingRepairCharge: (() => void) | undefined;
  let unchargedNoopRepairs = 0;
  let lastWorkspaceDiff = acceptedPreparation?.workspaceDiff;
  // The preflight attempt whose gated install last succeeded in this
  // sandbox. Repair rounds whose diff leaves dependency inputs unchanged
  // reuse that install instead of spending 1–2 minutes reproducing the
  // same warm node_modules (N58); any round that installs afresh or fails
  // at-or-before install resets it.
  let lastCleanInstallAttempt: number | undefined;
  let internalFailureRetryUsed = false;
  const attemptedInstallScopes =
    input.preparationRepairBudget.attemptedInstallScopes;
  attemptedInstallScopes.add(input.preparationManifest.installCommandUsed);

  for (;;) {
    input.assertJobWithinDeadline();
    if (failure?.failureClassification === "harness/internal failure") {
      // Repair-evidence contract clause 5 (N62): infra errors never reach
      // agent prompts or spend repair budget. One agent-free revalidation
      // absorbs a transient control-plane blip; a repeat is a real fault.
      if (internalFailureRetryUsed) {
        throw new Error(
          `Preparation validation failed inside the harness (not agent-repairable): ${failure.logsSummary}`,
        );
      }
      internalFailureRetryUsed = true;
      failure = undefined;
    }
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
        recordFailingFeatureProgress(input.preparationRepairBudget, failure);
        const repair = await repairPreparationManifest({
          dependencies: input.dependencies,
          failureReport: failure,
          input: input.input,
          preparationManifest,
          phaseRepairAttempts,
          fingerprintRepairAttempts,
          // Exploration is the terminal preparation gate and always runs
          // after every other phase, so earlier-stage churn can spend the
          // whole global budget before exploration's first failure (ghost
          // 2026-08-09: three preflight repairs plus two false fidelity
          // vetoes starved the data-path steering). Its failures may spend
          // up to two rounds beyond the global limit; no earlier stage
          // gets a reservation because they already run first.
          repoPreparationRepairLimit:
            input.repoPreparationRepairLimit +
            input.preparationRepairBudget.bonusRounds +
            (phase === "app-exploration" ? explorationRepairReserveRounds : 0),
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
          stageStatuses: input.stageStatuses,
          stageTimings: input.stageTimings,
          totalRepairAttempts: input.preparationRepairBudget.totalAttempts,
          workspace: input.workspace,
        });
        pendingRepairCharge = () => {
          input.preparationRepairBudget.attemptsByFingerprint[fingerprint] =
            fingerprintRepairAttempts + 1;
          input.preparationRepairBudget.totalAttempts += 1;
          input.preparationRepairAttemptsByPhase[phase] =
            phaseRepairAttempts + 1;
        };
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
        manifestBaseline = manifestBeforeRepair;
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

    const workspaceDiff = await input.capturePreparationWorkspaceDiff();
    lastWorkspaceDiff = workspaceDiff;
    const repairDelta =
      repairBaseline === undefined
        ? undefined
        : readDependencyRepairDelta(repairBaseline, workspaceDiff);
    reconcileLockfile = repairDelta?.dependencyInputsChanged ?? false;
    if (
      pendingRepairCharge !== undefined &&
      activeRepairFailure !== undefined
    ) {
      const workspaceUnchanged =
        repairDelta !== undefined
          ? repairDelta.changedPaths.length === 0
          : workspaceDiff.changedPaths.length === 0;
      // A dependency repair's manifest is discarded, so its only channel of
      // effect is the workspace; a runtime repair may legitimately change
      // only the manifest (commands, ports, envUsed), which counts as real.
      const manifestUnchanged =
        manifestBaseline !== undefined &&
        JSON.stringify(preparationManifest) ===
          JSON.stringify(manifestBaseline);
      if (workspaceUnchanged && (dependencyRepair || manifestUnchanged)) {
        if (unchargedNoopRepairs >= noopRepairGraceRounds) {
          pendingRepairCharge();
        } else {
          unchargedNoopRepairs += 1;
        }
        pendingRepairCharge = undefined;
        failure = appendNoopRepairRejection(
          activeRepairFailure,
          dependencyRepair,
        );
        activeRepairFailure = undefined;
        dependencyRepair = false;
        repairBaseline = undefined;
        manifestBaseline = undefined;
        continue;
      }
      unchargedNoopRepairs = 0;
      pendingRepairCharge();
      pendingRepairCharge = undefined;
    }
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
    const fidelityValidation = await runValidationStage(
      "preparation-fidelity",
      input.dependencies,
      artifactPaths.preparationFidelity,
      input.validationReports,
      input.stageStatuses,
      input.stageTimings,
      async () => {
        const candidates = readPreparationFidelityCandidates({
          ...(repairBaseline === undefined
            ? {}
            : { dependencyRepair, repairBaseline }),
          // The failure that dispatched the active repair carries the
          // harness's own feature observations; fidelity checks the
          // repaired manifest's claims against them.
          ...(activeRepairFailure?.featureVerdicts === undefined
            ? {}
            : { priorFeatureVerdicts: activeRepairFailure.featureVerdicts }),
          preparationManifest,
          repoSourceFiles: new Map(
            input.input.files.map((file) => [file.path, file.text] as const),
          ),
          workspaceDiff,
        });
        const adjudicate = input.dependencies.adjudicateFidelityCandidates;
        const deterministicCandidates = candidates.filter(
          (candidate) => candidate.deterministic === true,
        );
        if (deterministicCandidates.length > 0) {
          return createPreparationFidelityReport({
            candidates: deterministicCandidates,
          });
        }
        if (candidates.length === 0 || adjudicate === undefined) {
          return createPreparationFidelityReport({ candidates });
        }
        // Cost lands only on the veto path: the judge runs once per failing
        // attempt, never on clean validations.
        const unjudgedRecord = () => ({
          outcomes: candidates.map((candidate, candidateIndex) => ({
            candidateIndex,
            message: candidate.message,
            outcome: "unjudged" as const,
          })),
        });
        let verdicts: FidelityAdjudicationVerdict[] | undefined;
        try {
          verdicts = await adjudicate({
            candidates,
            preparationManifest,
            workspace: input.workspace,
            workspaceDiff,
          });
        } catch (error) {
          if (isAgentHarnessInfrastructureError(error)) throw error;
          verdicts = undefined;
        }
        if (verdicts === undefined) {
          return createPreparationFidelityReport({
            adjudication: { ...unjudgedRecord(), status: "unadjudicated" },
            candidates,
          });
        }
        // A judge that edited the workspace judged a diff that no longer
        // exists; its verdicts are unsafe to apply.
        const diffAfterAdjudication =
          await input.dependencies.capturePreparationWorkspaceDiff({
            workspace: input.workspace,
          });
        if (diffAfterAdjudication.patchSha256 !== workspaceDiff.patchSha256) {
          return createPreparationFidelityReport({
            adjudication: {
              ...unjudgedRecord(),
              status: "discarded-diff-changed",
            },
            candidates,
          });
        }
        const { record, steering, surviving } = reconcileFidelityAdjudication({
          candidates,
          patch: workspaceDiff.patch,
          verdicts,
        });
        return createPreparationFidelityReport({
          adjudication: record,
          candidates: surviving,
          steering,
        });
      },
      input.validationAttemptCounts,
      input.preparationRepairAttemptsByPhase["preparation-fidelity"] ?? 0,
    );
    dependencyRepair = false;
    repairBaseline = undefined;
    manifestBaseline = undefined;
    if (fidelityValidation.status === "failed") {
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
    acceptedPreparation = { manifest: preparationManifest, workspaceDiff };
    activeRepairFailure = undefined;

    const reuseInstallFromAttempt =
      repairDelta !== undefined && !repairDelta.dependencyInputsChanged
        ? lastCleanInstallAttempt
        : undefined;
    const preparationValidation = await runValidationStage(
      "preparation-preflight",
      input.dependencies,
      artifactPaths.preparationPreflight,
      input.validationReports,
      input.stageStatuses,
      input.stageTimings,
      () =>
        input.dependencies.validatePreparation({
          ...(reuseInstallFromAttempt === undefined
            ? {}
            : { installDependencies: false }),
          preparationManifest,
          ...(reconcileLockfile ? { reconcileLockfile: true } : {}),
          repoProfile: input.repoProfile,
          runPlan: input.runPlan,
          workspace: input.workspace,
        }),
      input.validationAttemptCounts,
      input.preparationRepairAttemptsByPhase["preparation-preflight"] ?? 0,
    );
    // The pre/at-install classifications are listed conservatively —
    // anything ambiguous forces a reinstall.
    const installLayerFailed = [
      "install failure",
      // A timed-out lifecycle left native builds and postinstall codegen
      // unfinished — reuse would skip the re-run entirely (N98).
      "lifecycle timeout",
      "external network attempted",
      "harness/internal failure",
    ].includes(preparationValidation.failureClassification ?? "");
    if (reuseInstallFromAttempt === undefined) {
      // Install ran this validation: it stays reusable unless the failure
      // happened at or before install.
      lastCleanInstallAttempt = installLayerFailed
        ? undefined
        : (input.validationAttemptCounts["preparation-preflight"] ?? 0);
    } else if (installLayerFailed) {
      // N127: a reuse round re-runs the offline lifecycle on the re-synced
      // tree; when the install layer fails there, the reused install can no
      // longer be trusted — the next round reinstalls instead of replaying
      // the same failure for as long as repairs leave dependency inputs
      // untouched.
      lastCleanInstallAttempt = undefined;
    }
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
    // The reuse note travels as a hint, never in logsSummary: the failure
    // fingerprint normalizes the summary, and a round-varying prefix would
    // defeat repeated-failure detection.
    failure =
      reuseInstallFromAttempt === undefined
        ? preparationValidation
        : {
            ...preparationValidation,
            suggestedRepairHints: [
              ...preparationValidation.suggestedRepairHints,
              `Dependency install reused from validation attempt ${reuseInstallFromAttempt} (this repair changed no dependency inputs; the offline lifecycle still re-ran on the freshly synced tree).`,
            ],
          };
  }
}

/**
 * Free rounds before consecutive no-op repairs start charging the repair
 * budgets. A repair that changed nothing did no work worth charging — but
 * only twice, so an agent that keeps returning untouched workspaces still
 * runs into the repeated-failure limit instead of looping forever.
 */
const noopRepairGraceRounds = 2;

const dependencyNoopRejection =
  "no package manifest or recognized package-manager configuration changed.";
const dependencyNoopHint =
  "Change the dependency metadata responsible for the reported install failure; do not rewrite the manifest or executable source.";
const runtimeNoopRejection =
  "the repair produced no change: the workspace and the preparation manifest match the state that already failed.";
const runtimeNoopHint =
  "Make a concrete change that addresses the failure: edit the files responsible or correct the preparation manifest's commands, ports, baseUrl, or envUsed. Resubmitting the same state will be rejected again.";

/**
 * Builds the failure a no-op repair loops back on. A repair that returns
 * the workspace and manifest untouched is a non-attempt: the original
 * failure stands, annotated so the next dispatch knows resubmission was
 * already rejected. Appending is idempotent — consecutive no-ops must not
 * stack duplicate rejections or hints.
 */
function appendNoopRepairRejection(
  originalFailure: ValidationReport,
  dependencyRepair: boolean,
): ValidationReport {
  const rejection = dependencyRepair
    ? dependencyNoopRejection
    : runtimeNoopRejection;
  const hint = dependencyRepair ? dependencyNoopHint : runtimeNoopHint;
  const rejectionSuffix = ` Rejected repair: ${rejection}`;
  return {
    ...originalFailure,
    logsSummary: originalFailure.logsSummary.endsWith(rejectionSuffix)
      ? originalFailure.logsSummary
      : `${originalFailure.logsSummary}${rejectionSuffix}`,
    suggestedRepairHints: originalFailure.suggestedRepairHints.includes(hint)
      ? originalFailure.suggestedRepairHints
      : [...originalFailure.suggestedRepairHints, hint],
  };
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
  // Two gates squeeze this repair: without naming both constraints in one
  // prompt, agents re-try the vetoed kind of change until the budget dies
  // (midday burned five rounds on it, 2026-08-07 matrix).
  const intersectionHint =
    "Both constraints hold at once: the original failure above must still be fixed AND the fidelity rules that vetoed the rejected files still apply, so repeating that kind of change will be rejected again. Prefer fixing the failure through fixtures, data paths, or demo configuration rather than modifying the vetoed product files.";
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
          (hint) =>
            !hint.includes(artifactPaths.preparationWorkspaceDiff) &&
            !hint.startsWith("Both constraints hold at once"),
        ),
        ...fidelityFailure.suggestedRepairHints,
        vetoedCandidateHint,
        intersectionHint,
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
  }

  if (input.totalRepairAttempts >= input.repoPreparationRepairLimit) {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${repairBudgetExhaustedMessage(
        {
          attempts: input.repoPreparationRepairLimit,
          budgetLabel: "global",
          route: "repo-preparation-repair",
        },
      )}`,
    );
  }
  const repeatedFailureLimit = Math.min(
    input.failureReport.stage === "preparation-fidelity" ? 1 : 2,
    input.repoPreparationRepairLimit,
  );
  if (input.fingerprintRepairAttempts >= repeatedFailureLimit) {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${repairBudgetExhaustedMessage(
        {
          attempts: repeatedFailureLimit,
          budgetLabel: "repeated failure",
          route: "repo-preparation-repair",
        },
      )}`,
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

/**
 * Joins a capture-path locator failure's typed identity back to the Demo
 * Script action it names (N125): the action's verified locator and candidate
 * id plus the failing scene's action prefix ahead of it, so regrounding can
 * re-verify the candidate in its replay context. Returns undefined when the
 * report carries no identity or the failing scene no longer contains the
 * action — regrounding then falls back to a plain re-exploration.
 */
function readCaptureLocatorFailure(
  report: ValidationReport,
  scriptCandidate: ScriptCandidate,
): CaptureLocatorFailure | undefined {
  const failedAction = report.failedAction;
  if (failedAction?.actionId === undefined) {
    return undefined;
  }
  const script = scriptCandidate.scriptJsonContent;
  const scenes =
    typeof script === "object" && script !== null
      ? (script as { scenes?: unknown }).scenes
      : undefined;
  if (!Array.isArray(scenes)) {
    return undefined;
  }
  for (const scene of scenes) {
    if (typeof scene !== "object" || scene === null) {
      continue;
    }
    if ((scene as { id?: unknown }).id !== failedAction.sceneId) {
      continue;
    }
    let actions: BrowserAction[];
    try {
      actions = readBrowserActions(
        (scene as { actions?: unknown }).actions ?? [],
      );
    } catch {
      continue;
    }
    const index = actions.findIndex(
      (action) => action.id === failedAction.actionId,
    );
    const action = actions[index];
    if (action === undefined) {
      continue;
    }
    const screenshotPath = report.screenshots[0];
    return {
      actionId: failedAction.actionId,
      ...("locator" in action ? { locator: action.locator } : {}),
      ...(action.locatorCandidateId === undefined
        ? {}
        : { locatorCandidateId: action.locatorCandidateId }),
      sceneId: failedAction.sceneId,
      scenePrefix: actions.slice(0, index),
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    };
  }
  return undefined;
}

const preparationProgressBonusLimit = 2;

/**
 * Extra repair rounds only app-exploration failures may spend beyond the
 * global preparation budget. Worst case stays bounded at
 * repoPreparationRepairLimit + preparationProgressBonusLimit + this reserve.
 */
const explorationRepairReserveRounds = 2;

/**
 * Grants a bonus repair round when a failure's failing-feature set strictly
 * shrank — a proper subset of the previous feature-bearing failure's set. A
 * loop that fixes features round over round is converging, so it earns
 * headroom (capped at +2 per run) instead of dying one round short; churn
 * (different features failing) and app-wide failures earn nothing.
 */
function recordFailingFeatureProgress(
  budget: PreparationRepairBudget,
  failure: ValidationReport,
): void {
  const failing = failure.failingFeatureIds;
  if (failing === undefined || failing.length === 0) {
    return;
  }
  const previous = budget.lastFailingFeatureIds;
  budget.lastFailingFeatureIds = failing;
  if (
    previous === undefined ||
    budget.bonusRounds >= preparationProgressBonusLimit
  ) {
    return;
  }
  const previousSet = new Set(previous);
  const failingSet = new Set(failing);
  if (
    failingSet.size < previousSet.size &&
    [...failingSet].every((featureId) => previousSet.has(featureId))
  ) {
    budget.bonusRounds += 1;
  }
}

/**
 * Identifies a failure for the repeated-failure limit. The identity-bearing
 * line is the decisive cause extracted from the managed output — its last
 * error-class line — not the summary's first line, which is usually the
 * outermost symptom (a probe's `curl: (7)`) and collapses distinct causes
 * into one fingerprint. Summaries whose lines never name an error (render
 * timeouts, listen failures) fall back to the first line.
 */
function preparationFailureFingerprint(report: ValidationReport): string {
  const rejectionParts = report.logsSummary.split(" Rejected repair:");
  const failureBody = rejectionParts[0] ?? "";
  return [
    report.stage,
    report.failureClassification ?? "unknown",
    report.attemptedCommand ?? "",
    normalizeFailureSummaryLine(
      readLastErrorCauseLine(failureBody) ?? failureBody,
    ),
    normalizeFailureSummaryLine(
      rejectionParts.length === 1 ? "" : (rejectionParts.at(-1) ?? ""),
    ),
  ].join("\u0000");
}

/**
 * Reduces a failure line to its identity-bearing form: run-varying noise
 * (timestamps, ids, durations, ports, temp paths) must not make the same
 * failure look new, or the repeated-failure limit never triggers. The
 * timestamp scrub accepts `_`-separated clock digits because npm debug-log
 * file names embed them that way.
 */
function normalizeFailureSummaryLine(summary: string): string {
  return (summary.split("\n", 1)[0] ?? "")
    .trim()
    .toLowerCase()
    .replace(
      /\b\d{4}-\d{2}-\d{2}t\d{2}[:_]\d{2}[:_]\d{2}(?:[._]\d+)?z\b/g,
      "<time>",
    )
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

/**
 * Throws the stage's failure as the pipeline error unless the report passed.
 * The asserts signature lets repair guards end on this call: a failed report
 * never returns, so no unreachable fallback throw is needed after it.
 */
function assertValidationPassed(
  report: ValidationReport,
): asserts report is ValidationReport & { status: "passed" } {
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
    (await input.workspace?.collectNetworkStateLog()) ?? [];
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

const nodeLineSwapTimeoutMs = 120_000;

// Runs before any submitted-code command so binaries, headers, and every
// nested spawn agree on the repository's pinned Node line (N78). The default
// line skips the round-trip: the image's marker already matches.
async function activatePinnedNodeLine(
  workspace: AgentHarnessWorkspace,
  runPlan: RunPlan,
): Promise<void> {
  const nodeLine = runPlan.nodeLine;
  if (nodeLine === undefined || nodeLine.line === DEFAULT_NODE_LINE) {
    return;
  }
  const result = await workspace.executeSubmittedCode(
    createNodeLineSwapCommand(nodeLine.line),
    { timeoutMs: nodeLineSwapTimeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Submitted-code sandbox could not activate Node line ${nodeLine.line} (pins: ${nodeLine.provenance.join("; ")}): ${(result.stderr || result.stdout).trim().slice(-500)}`,
    );
  }
  try {
    await workspace.writeSandboxLog({
      event: "node-line.activated",
      line: nodeLine.line,
      message: `Submitted-code sandbox activated Node line ${nodeLine.line}.`,
      provenance: nodeLine.provenance,
      satisfied: nodeLine.satisfied,
    });
  } catch {
    // Audit logging is best-effort; the swap itself already succeeded.
  }
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value.trim().length === 0
    ? {}
    : ({ [key]: value } as Partial<Record<K, string>>);
}

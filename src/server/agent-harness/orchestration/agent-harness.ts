import type { AgentHarnessWorkspace } from "../daytona/workspace.interface";
import type { OpenCodeHarnessRunner } from "../opencode/opencode-harness";
import {
  classifyRepairRoute,
  readRepairBudgetDecision,
} from "../repair/repair-router";
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
  createWorkspace(input: {
    repoProfile: RepoProfile;
    runPlan: RunPlan;
  }): Promise<AgentHarnessWorkspace>;
  /**
   * Recreates a clean, network-locked submitted-code runtime after the
   * validation dry-run so Footage Capture cannot inherit mutated app state.
   */
  resetCaptureRuntime?(input: {
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
  }): Promise<{
    actionCatalog: ActionCatalog;
    appMap: AppMap;
    validationReport: ValidationReport;
  }>;
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
    runPlan: RunPlan;
    workspace: AgentHarnessWorkspace;
  }): Promise<{ manifest: PreparationManifest; opencodeSessionId?: string }>;
  repairPreparation?(input: {
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    failureReport: ValidationReport;
    normalizedSupportingDocuments: AgentHarnessPipelineInput["normalizedSupportingDocuments"];
    preparationManifest: PreparationManifest;
    repoProfile: RepoProfile;
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
  repoProfile?: RepoProfile;
  runPlan?: RunPlan;
  scriptCandidate?: ScriptCandidate;
  status: "failed" | "passed" | "security-rejected";
  validationReports: ValidationReport[];
  workspace?: AgentHarnessWorkspace;
};

export type AgentHarnessPipelineOptions = {
  destroyWorkspaceOnCompletion?: boolean;
  repoPreparationRepairLimit?: number;
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
  preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
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
    return {
      pipelineRunManifest,
      status: "security-rejected",
      validationReports,
    };
  }

  const repoProfile = await writeArtifact(
    dependencies,
    artifactPaths.repoProfile,
    profileRepo({
      ...optionalString("commitSha", input.commitSha),
      files: input.files,
      repoUrl: input.repoUrl,
      ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
    }),
  );

  const runPlan = await runAsyncStage(
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

    const repoPreparationRepairLimit = options.repoPreparationRepairLimit ?? 2;
    let preparationState = await ensureValidPreparation({
      dependencies,
      input,
      preparationManifest,
      repoPreparationRepairAttempts: 0,
      repoPreparationRepairLimit,
      repoProfile,
      runPlan,
      stageStatuses,
      stageTimings,
      validationReports,
      workspace: requireWorkspace(workspace),
    });
    preparationManifest = preparationState.preparationManifest;
    let preparationValidation = preparationState.preparationValidation;
    let repoPreparationRepairAttempts =
      preparationState.repoPreparationRepairAttempts;
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
        const explorationValidation = readValidationReport({
          ...exploration.validationReport,
          retryCount: repoPreparationRepairAttempts,
        });
        validationReports.push(explorationValidation);
        stageStatuses["app-exploration"] = explorationValidation.status;
        await writeArtifact(
          dependencies,
          artifactPaths.appExplorationValidation,
          explorationValidation,
        );
        if (explorationValidation.status === "passed") {
          break;
        }

        preparationState = await ensureValidPreparation({
          dependencies,
          initialFailure: explorationValidation,
          input,
          preparationManifest,
          repoPreparationRepairAttempts,
          repoPreparationRepairLimit,
          repoProfile,
          runPlan,
          stageStatuses,
          stageTimings,
          validationReports,
          workspace: requireWorkspace(workspace),
        });
        preparationManifest = preparationState.preparationManifest;
        preparationValidation = preparationState.preparationValidation;
        repoPreparationRepairAttempts =
          preparationState.repoPreparationRepairAttempts;
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

      let scriptRepairAttempts = 0;
      const scriptRepairLimit = options.scriptRepairLimit ?? 3;
      for (;;) {
        const staticContractValidation = await runValidationStage(
          "static-script-contract-validation",
          dependencies,
          artifactPaths.staticScriptContract,
          validationReports,
          stageStatuses,
          stageTimings,
          () =>
            dependencies.validateScriptContract({
              contractOutputPath: DEMO_SCRIPT_OUTPUT_PATH,
              flowSpec,
              preparationManifest,
              scriptCandidate,
            }),
          scriptRepairAttempts,
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
            scriptRepairAttempts,
            scriptRepairLimit,
            stageStatuses,
            stageTimings,
            workspace: requireWorkspace(workspace),
          });
          scriptRepairAttempts += 1;
          await writeArtifact(
            dependencies,
            artifactPaths.scriptCandidate,
            scriptCandidate,
          );
          continue;
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
          scriptRepairAttempts,
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
            repoPreparationRepairAttempts,
            repoPreparationRepairLimit,
            repoProfile,
            runPlan,
            stageStatuses,
            stageTimings,
            validationReports,
            workspace: requireWorkspace(workspace),
          });
          preparationManifest = preparationState.preparationManifest;
          preparationValidation = preparationState.preparationValidation;
          repoPreparationRepairAttempts =
            preparationState.repoPreparationRepairAttempts;
          opencodeSessionIds.push(...preparationState.opencodeSessionIds);
          continue pipelineAttempt;
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
          scriptRepairAttempts,
          scriptRepairLimit,
          stageStatuses,
          stageTimings,
          workspace: requireWorkspace(workspace),
        });
        scriptRepairAttempts += 1;
        await writeArtifact(
          dependencies,
          artifactPaths.scriptCandidate,
          scriptCandidate,
        );
      }

      if (dependencies.resetCaptureRuntime !== undefined) {
        const resetValidation = await runValidationStage(
          "capture-runtime-reset",
          dependencies,
          artifactPaths.captureRuntimeReset,
          validationReports,
          stageStatuses,
          stageTimings,
          () =>
            dependencies.resetCaptureRuntime?.({
              preparationManifest,
              repoProfile,
              runPlan,
              workspace: requireWorkspace(workspace),
            }) as Promise<ValidationReport>,
        );
        assertValidationPassed(resetValidation);
      }
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
    await persistRunManifest({
      dependencies,
      input,
      opencodeSessionIds,
      stageStatuses,
      stageTimings,
      status: "failed",
      unsupportedOrFailureReason:
        error instanceof Error ? error.message : String(error),
      workspace,
    });
    throw error;
  } finally {
    if (options.destroyWorkspaceOnCompletion !== false) {
      await workspace?.destroy();
    }
  }
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
  retryCount = 0,
): Promise<ValidationReport> {
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
      `${artifactPaths.validationAttempts}/${stage.replaceAll(/[^A-Za-z0-9_-]/g, "-")}/attempt-${retryCount + 1}.json`,
      report,
    ),
  ]);
  return report;
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
    `script-repair-${budget.nextAttempt}`,
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
  repoPreparationRepairAttempts: number;
  repoPreparationRepairLimit: number;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
  stageStatuses: Record<string, string>;
  stageTimings: PipelineRunManifest["stageTimings"];
  validationReports: ValidationReport[];
  workspace: AgentHarnessWorkspace;
}): Promise<{
  opencodeSessionIds: string[];
  preparationManifest: PreparationManifest;
  preparationValidation: ValidationReport;
  repoPreparationRepairAttempts: number;
}> {
  let preparationManifest = input.preparationManifest;
  let repairAttempts = input.repoPreparationRepairAttempts;
  let failure = input.initialFailure;
  const opencodeSessionIds: string[] = [];

  for (;;) {
    if (failure !== undefined) {
      const repair = await repairPreparationManifest({
        dependencies: input.dependencies,
        failureReport: failure,
        input: input.input,
        preparationManifest,
        repoPreparationRepairAttempts: repairAttempts,
        repoPreparationRepairLimit: input.repoPreparationRepairLimit,
        repoProfile: input.repoProfile,
        runPlan: input.runPlan,
        stageStatuses: input.stageStatuses,
        stageTimings: input.stageTimings,
        workspace: input.workspace,
      });
      repairAttempts += 1;
      if (repair.opencodeSessionId !== undefined) {
        opencodeSessionIds.push(repair.opencodeSessionId);
      }
      preparationManifest = await writeArtifact(
        input.dependencies,
        artifactPaths.preparationManifest,
        readPreparationManifest(repair.manifest),
      );
    }

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
      repairAttempts,
    );
    if (preparationValidation.status === "passed") {
      return {
        opencodeSessionIds,
        preparationManifest,
        preparationValidation,
        repoPreparationRepairAttempts: repairAttempts,
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
  repoPreparationRepairAttempts: number;
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
    attempted: input.repoPreparationRepairAttempts,
    limit: input.repoPreparationRepairLimit,
    route,
  });
  if (budget.status === "exhausted") {
    throw new Error(
      `${input.failureReport.stage} failed: ${input.failureReport.logsSummary}. ${budget.reason}`,
    );
  }

  return await runAsyncStage(
    `repo-preparation-repair-${budget.nextAttempt}`,
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

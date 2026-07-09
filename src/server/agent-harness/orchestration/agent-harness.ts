import type { AgentHarnessWorkspace } from "../daytona/workspace.interface";
import type { OpenCodeHarnessRunner } from "../opencode/opencode-harness";
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
};

const artifactPaths = {
  actionCatalog: "/workspace/.makeademo/action-catalog.json",
  appMap: "/workspace/.makeademo/app-map.json",
  capturePathValidation:
    "/workspace/.makeademo/capture-path-validation-report.json",
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
    const preparationManifest = await writeArtifact(
      dependencies,
      artifactPaths.preparationManifest,
      readPreparationManifest(preparation.manifest),
    );

    const preparationValidation = await runValidationStage(
      "preparation-preflight",
      dependencies,
      artifactPaths.preparationPreflight,
      validationReports,
      stageStatuses,
      stageTimings,
      () =>
        dependencies.validatePreparation({
          preparationManifest,
          repoProfile,
          runPlan,
          workspace: requireWorkspace(workspace),
        }),
    );
    assertValidationPassed(preparationValidation);

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
    const appMap = await writeArtifact(
      dependencies,
      artifactPaths.appMap,
      readAppMap(exploration.appMap),
    );
    const actionCatalog = await writeArtifact(
      dependencies,
      artifactPaths.actionCatalog,
      readActionCatalog(exploration.actionCatalog),
    );
    validationReports.push(readValidationReport(exploration.validationReport));

    const flowSpec = await runAsyncStage(
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

    const scriptCandidate = await runAsyncStage(
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
    );
    assertValidationPassed(staticContractValidation);

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
    );
    assertValidationPassed(capturePathValidation);

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

async function runValidationStage(
  stage: string,
  dependencies: AgentHarnessPipelineDependencies,
  path: string,
  validationReports: ValidationReport[],
  stageStatuses: Record<string, string>,
  stageTimings: PipelineRunManifest["stageTimings"],
  callback: () => Promise<ValidationReport>,
): Promise<ValidationReport> {
  const report = await runAsyncStage(
    stage,
    stageStatuses,
    stageTimings,
    async () => readValidationReport(await callback()),
  );
  validationReports.push(report);
  await writeArtifact(dependencies, path, report);
  return report;
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
    networkStateTransitions: [
      { at: new Date().toISOString(), state: "runtime-locked" },
    ],
    opencodeSessionIds: input.opencodeSessionIds,
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

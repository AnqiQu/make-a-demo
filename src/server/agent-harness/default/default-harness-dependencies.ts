import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import {
  BROWSER_ACTION_COMPILER_VERSION,
  BUN_RUNTIME_VERSION,
  CAPTURE_SDK_CONTRACT_VERSION,
  DEMO_SCRIPT_CONTRACT_VERSION,
  PLAYWRIGHT_RUNTIME_VERSION,
} from "../../pipeline/06-footage-capture/capture-contract-versions";
import { createCaptureSdkAgentContract } from "../../pipeline/06-footage-capture/capture-sdk-contract";
import {
  type PlaywrightRecordingSceneDescription,
  parseDemoScript,
} from "../../pipeline/06-footage-capture/demo-script.schema";
import {
  type ExternalResourceFetcher,
  hydrateExternalResourceCache,
  isHydratableExternalResource,
} from "../../shared/external-resources/external-resource-cache";
import {
  type ExternalResourceManifest,
  externalResourceManifestVersion,
} from "../../shared/external-resources/external-resource-manifest.schema";
import {
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "../../shared/integrations/agents/opencode-provider-secrets";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import type { PipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import {
  type SubmittedAppExplorationResult,
  exploreSubmittedApp,
  isExplicitAuthenticationFeature,
  readRouteDistinctContent,
} from "../app-explorer/submitted-app-explorer";
import { downloadSubmittedCodeArchive } from "../daytona/submitted-code-artifact-archive";
import { uploadSubmittedCodeExternalResourceCache } from "../daytona/submitted-code-external-resource-cache";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessSubmittedCodeAppStartInput,
  type AgentHarnessSubmittedCodeAppStatus,
  type AgentHarnessWorkspace,
  type AgentHarnessWorkspaceCommandResult,
  type AgentHarnessWorkspaceExecuteOptions,
  type AgentHarnessWorkspaceHandle,
  type AgentHarnessWorkspaceProvider,
  isAgentHarnessInfrastructureError,
} from "../daytona/workspace.interface";
import { DefaultOpenCodeHarnessRunner } from "../opencode/default-opencode-harness-runner";
import {
  type OpenCodeHarnessRunInput,
  type OpenCodeHarnessRunResult,
  type OpenCodeHarnessRunner,
  createStagePrompt,
} from "../opencode/opencode-harness";
import type {
  AgentHarnessPipelineDependencies,
  AgentHarnessPipelineInput,
} from "../orchestration/agent-harness";
import { isDependencyRepairFailure } from "../repair/repair-router";
import { assertPreparedFeatureInventory } from "../repo-preparation/prepared-feature-inventory";
import { synthesizeRunPlan } from "../run-planner/run-plan-synthesis";
import {
  findRuntimeConfigurationIssue,
  resolvePreparationRuntime,
} from "../run-planner/runtime-target-resolution";
import {
  RuntimeTargetSelectionRequiredError,
  createExplicitRuntimeTargetSelection,
  readModelRuntimeTargetSelection,
} from "../run-planner/runtime-target-selection";
import {
  type ActionCatalog,
  type AppMap,
  DEMO_SCRIPT_OUTPUT_PATH,
  type FlowSpec,
  type NetworkAttempt,
  type PreparationManifest,
  type RepoProfile,
  type RunPlan,
  type RuntimeProbeAttempt,
  type RuntimeProbeDiagnostics,
  type ScriptCandidate,
  type ValidationReport,
  readFlowSpec,
  readPreparationManifest,
} from "../schemas/artifacts";
import { createFlowSpecContract } from "../schemas/flow-spec-contract";
import { createPreparationManifestContract } from "../schemas/preparation-manifest-contract";
import { createPreparationManifestTemplate } from "../schemas/preparation-manifest-template";
import { assembleDemoNarrative } from "../script-contract/demo-narrative";
import {
  createDemoScriptContract,
  validateDemoScriptCandidateContract,
} from "../script-contract/demo-script-contract";
import {
  type ScriptWritingContentSnapshot,
  findScriptWritingContentChanges,
} from "../script-generation/read-only-boundary";
import {
  hasNetworkInstallFailureSignature,
  runDependencyInstallThroughGate,
} from "../tools/dependency-install-gate";
import {
  createLockfileReconciliationCommand,
  planLockfileReconciliation,
} from "../tools/lockfile-reconciliation";
import { validateDynamicCapturePath } from "../validation/dynamic-capture-path-validation";
import { validatePreparedWorkspaceCapturePath } from "../validation/prepared-workspace-capture-path-validator";
import {
  createRuntimeNetworkGuardSource,
  readRuntimeNetworkAttempts,
  runtimeNetworkGuardPath,
} from "../validation/runtime-network-guard";
import {
  type JsonSyntaxDiagnostic,
  diagnoseJsonSyntax,
  fingerprintArtifactText,
  redactSecretText,
} from "./json-artifact-diagnostic";
import {
  type RepoSourceArchive,
  assertRepoSourceArchiveIntegrity,
} from "./repo-snapshot";
import {
  type AgentHarnessRetryPolicy,
  readAgentHarnessRetryPolicy,
} from "./retry-policy";

export type DefaultHarnessDependenciesOptions = {
  artifactStore: NonNullable<AgentHarnessPipelineDependencies["artifactStore"]>;
  env?: Record<string, string | undefined>;
  externalResourceFetcher?: ExternalResourceFetcher;
  logger?: PipelineEventLogger;
  modelID?: string;
  openCodeRunner?: OpenCodeHarnessRunner;
  outputRoot: string;
  providerID?: string;
  /** Exact screened revision to materialize; production callers must provide it. */
  repoSourceArchive?: RepoSourceArchive;
  retryPolicy?: Partial<AgentHarnessRetryPolicy>;
  staticImageAssets?: Readonly<Record<string, { sourcePath: string }>>;
  workspaceProvider?: AgentHarnessWorkspaceProvider;
};

export type DefaultHarnessDependencies = {
  dependencies: AgentHarnessPipelineDependencies;
  getExternalResourceCache?():
    | { directory: string; manifest: ExternalResourceManifest }
    | undefined;
  getWorkspaceHandle(): AgentHarnessWorkspaceHandle | undefined;
};

const workspaceRepoDirectory = "/workspace/repo";
const makeADemoDirectory = "/workspace/.makeademo";
const misplacedPreparationManifestPath =
  "/workspace/repo/.makeademo/preparation-manifest.json";
const openCodeConfigDirectory = "/tmp/makeademo/opencode";
const maxShellArtifactWriteBytes = 120 * 1024;
const openCodeInactivityTimeoutMs = 5 * 60_000;
const preparationDiffCommandTimeoutMs = 60_000;
const preparationHashMarker = "\0MAKEADEMO_HASHES\0";
const preparationPatchMarker = "\0MAKEADEMO_PATCH\0";

const artifactPaths = {
  actionCatalog: "/workspace/.makeademo/action-catalog.json",
  agentArtifactAttempts: "/workspace/.makeademo/agent-artifact-attempts",
  appMap: "/workspace/.makeademo/app-map.json",
  appExplorationValidation:
    "/workspace/.makeademo/app-exploration-validation-report.json",
  capturePathValidation:
    "/workspace/.makeademo/capture-path-validation-report.json",
  captureSdkContract: "/workspace/.makeademo/capture-sdk-contract.json",
  demoBrief: "/workspace/.makeademo/demo-brief.json",
  demoScript: DEMO_SCRIPT_OUTPUT_PATH,
  demoScriptContract: "/workspace/.makeademo/demo-script-contract.json",
  externalResourceManifest:
    "/workspace/.makeademo/external-resource-manifest.json",
  externalResourceHydrationReport:
    "/workspace/.makeademo/external-resource-hydration-report.json",
  flowSpec: "/workspace/.makeademo/flow-spec.json",
  flowSpecContract: "/workspace/.makeademo/flow-spec-contract.json",
  preparationFidelity:
    "/workspace/.makeademo/preparation-fidelity-validation-report.json",
  preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
  preparationManifestContract:
    "/workspace/.makeademo/preparation-manifest-contract.json",
  preparationManifestTemplate:
    "/workspace/.makeademo/preparation-manifest-template.json",
  preparationPreflight:
    "/workspace/.makeademo/preparation-preflight-validation-report.json",
  repoProfile: "/workspace/.makeademo/repo-profile.json",
  runPlan: "/workspace/.makeademo/run-plan.json",
  runtimeTargetSelection: "/workspace/.makeademo/runtime-target-selection.json",
  runtimeTargetSelectionContract:
    "/workspace/.makeademo/runtime-target-selection-contract.json",
  supportingDocuments: "/workspace/.makeademo/supporting-documents.json",
};

export async function createDefaultAgentHarnessDependencies(
  options: DefaultHarnessDependenciesOptions,
): Promise<DefaultHarnessDependencies> {
  const env = options.env ?? process.env;
  const retryPolicy = readAgentHarnessRetryPolicy(env, options.retryPolicy);
  const providerID = options.providerID ?? "openai";
  const modelID =
    options.modelID ?? (env.MAKEADEMO_OPENAI_MODEL?.trim() || "gpt-5.6-terra");
  const openCodeRunner =
    options.openCodeRunner ?? new DefaultOpenCodeHarnessRunner();
  let workspaceHandle: AgentHarnessWorkspaceHandle | undefined;
  let submittedCodeAppStartInput:
    | AgentHarnessSubmittedCodeAppStartInput
    | undefined;
  let opencodeSessionId: string | undefined;
  let repoMaterialized = false;
  let runtimeRepairArtifactAttempt = 0;
  let scriptWritingBaseline: ScriptWritingContentSnapshot = {};
  const externalResourceDirectory = join(
    options.outputRoot,
    "external-resources",
  );
  let externalResourceManifest: ExternalResourceManifest | undefined;
  const policyDeniedExternalResourceUrls = new Set<string>();
  const externalResourceHydrationOutcomes: Array<{
    error?: string;
    method?: string;
    outcome: "cached" | "policy-denied" | "retrieval-failed";
    pass: number;
    phase: NetworkAttempt["phase"];
    resourceType?: string;
    responseUrl?: string;
    route?: string;
    sha256?: string;
    sizeBytes?: number;
    stage: string;
    url: string;
  }> = [];
  const trustedStaticImageAssetIds = Object.keys(
    options.staticImageAssets ?? {},
  ).sort();
  const runOpenCode = (input: OpenCodeHarnessRunInput) =>
    runLoggedOpenCode({
      input: {
        inactivityTimeoutMs: openCodeInactivityTimeoutMs,
        ...input,
      },
      logger: options.logger,
      openCodeRunner,
    });
  const ensureRepoMaterialized = async (
    repoProfile: RepoProfile,
    workspace: AgentHarnessWorkspace,
  ) => {
    if (repoMaterialized) return;
    await materializeScreenedRepo({
      repoProfile,
      sourceArchive: options.repoSourceArchive,
      workspace,
    });
    repoMaterialized = true;
  };
  const hydrateExternalResources = async (
    attempts: NetworkAttempt[],
    pass: number,
    stage: string,
  ) => {
    const previousEntries = externalResourceManifest?.entries ?? [];
    const previousEntryCount = previousEntries.length;
    const previousUrls = new Set(previousEntries.map((entry) => entry.url));
    const previousPolicyDeniedCount = policyDeniedExternalResourceUrls.size;
    const attemptsByUrl = new Map(
      attempts.flatMap((attempt) =>
        attempt.url === undefined ? [] : [[attempt.url, attempt] as const],
      ),
    );
    externalResourceManifest = await hydrateExternalResourceCache({
      attempts,
      directory: externalResourceDirectory,
      ...(externalResourceManifest === undefined
        ? {}
        : { existingManifest: externalResourceManifest }),
      ...(options.externalResourceFetcher === undefined
        ? {}
        : { fetchResource: options.externalResourceFetcher }),
      onFailure: async ({ error, reason, url }) => {
        if (reason === "policy-denied") {
          policyDeniedExternalResourceUrls.add(url);
        }
        const attempt = attemptsByUrl.get(url);
        externalResourceHydrationOutcomes.push({
          error: readUnknownErrorMessage(error),
          outcome: reason,
          pass,
          phase: attempt?.phase ?? "browser",
          ...(attempt?.method === undefined ? {} : { method: attempt.method }),
          ...(attempt?.resourceType === undefined
            ? {}
            : { resourceType: attempt.resourceType }),
          ...(attempt?.route === undefined ? {} : { route: attempt.route }),
          stage,
          url,
        });
        await options.logger?.warn({
          error: readUnknownErrorMessage(error),
          event: "external-resource.hydration.failed",
          reason,
          stage,
          url,
        });
      },
    });
    for (const entry of externalResourceManifest.entries) {
      if (previousUrls.has(entry.url)) continue;
      const attempt = attemptsByUrl.get(entry.url);
      externalResourceHydrationOutcomes.push({
        outcome: "cached",
        pass,
        phase: attempt?.phase ?? "browser",
        ...(attempt?.method === undefined ? {} : { method: attempt.method }),
        ...(attempt?.resourceType === undefined
          ? {}
          : { resourceType: attempt.resourceType }),
        ...(attempt?.route === undefined ? {} : { route: attempt.route }),
        ...(entry.responseUrl === undefined
          ? {}
          : { responseUrl: entry.responseUrl }),
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        stage,
        url: entry.url,
      });
    }
    await Promise.all([
      options.artifactStore.writeJson(
        artifactPaths.externalResourceManifest,
        externalResourceManifest,
      ),
      options.artifactStore.writeJson(
        artifactPaths.externalResourceHydrationReport,
        {
          outcomes: externalResourceHydrationOutcomes,
          version: externalResourceManifestVersion,
        },
      ),
    ]);
    const addedResources =
      externalResourceManifest.entries.length - previousEntryCount;
    const policyDeniedResources =
      policyDeniedExternalResourceUrls.size - previousPolicyDeniedCount;
    await options.logger?.info({
      addedResources,
      event: "external-resource.hydration.completed",
      pass,
      policyDeniedResources,
      resourceCount: externalResourceManifest.entries.length,
      stage,
    });
    return { addedResources };
  };
  const readUncachedExternalResourceAttempts = (
    attempts: NetworkAttempt[],
  ): NetworkAttempt[] => {
    const cachedUrls = new Set(
      (externalResourceManifest?.entries ?? []).flatMap((entry) => [
        entry.url,
        ...(entry.responseUrl === undefined ? [] : [entry.responseUrl]),
      ]),
    );
    const uncached = attempts
      .filter(isHydratableExternalResource)
      .filter((attempt) => !policyDeniedExternalResourceUrls.has(attempt.url))
      .filter((attempt) => !cachedUrls.has(attempt.url));
    return [
      ...new Map(uncached.map((attempt) => [attempt.url, attempt])).values(),
    ];
  };
  const validateRuntimeWithExternalResources = async (
    input: Omit<
      Parameters<typeof validateSubmittedCodeRuntime>[0],
      "buildApp" | "externalResourceCache" | "onAppStart" | "resetWorkspace"
    >,
  ): Promise<ValidationReport> => {
    const runValidation = async (inputRun: {
      buildApp: boolean;
      initialRun: boolean;
    }) =>
      await validateSubmittedCodeRuntime({
        ...input,
        buildApp: inputRun.buildApp,
        ...(externalResourceManifest === undefined
          ? {}
          : {
              externalResourceCache: {
                directory: externalResourceDirectory,
                manifest: externalResourceManifest,
              },
            }),
        ...(!inputRun.initialRun || input.installDependencies === false
          ? { installDependencies: false }
          : {}),
        onAppStart: (appStartInput) => {
          submittedCodeAppStartInput = appStartInput;
        },
        resetWorkspace: inputRun.initialRun,
      });
    const readUncachedAttempts = (report: ValidationReport) =>
      readUncachedExternalResourceAttempts(report.blockedNetworkAttempts);

    let buildApp = true;
    let initialRun = true;
    for (
      let pass = 1;
      pass <= retryPolicy.externalResourceBrokerPasses;
      pass += 1
    ) {
      const report = await runValidation({ buildApp, initialRun });
      initialRun = false;
      const uncached = readUncachedAttempts(report);
      if (uncached.length === 0) return report;
      const hydration = await hydrateExternalResources(
        uncached,
        pass,
        input.stage ?? "preparation-preflight",
      );
      buildApp =
        report.attemptedCommand !== undefined &&
        report.attemptedCommand === input.preparationManifest.buildCommandUsed;
      if (hydration.addedResources > 0) continue;
      const remainingAttempts = readUncachedAttempts(report);
      return remainingAttempts.length === 0
        ? report
        : unresolvedExternalResourceValidation(
            report,
            remainingAttempts,
            "runtime",
          );
    }

    const finalReport = await runValidation({ buildApp, initialRun: false });
    const uncached = readUncachedAttempts(finalReport);
    return uncached.length === 0
      ? finalReport
      : unresolvedExternalResourceValidation(finalReport, uncached, "runtime");
  };
  const runWithExternalResourceBroker = async <T>(input: {
    markUnresolved?: (result: T, attempts: NetworkAttempt[]) => T;
    readBlockedAttempts: (result: T) => NetworkAttempt[];
    run: () => Promise<T>;
    stage: string;
    workspace: AgentHarnessWorkspace;
  }): Promise<T> => {
    let uploadedManifest: ExternalResourceManifest | undefined;
    const uploadCache = async () => {
      if (uploadedManifest === externalResourceManifest) return;
      await uploadSubmittedCodeExternalResourceCache({
        directory: externalResourceDirectory,
        ...(externalResourceManifest === undefined
          ? {}
          : { manifest: externalResourceManifest }),
        ...(uploadedManifest === undefined
          ? {}
          : { previousManifest: uploadedManifest }),
        workspace: input.workspace,
      });
      uploadedManifest = externalResourceManifest;
    };
    const runOffline = async () => {
      await uploadCache();
      return await input.run();
    };
    const readUncachedAttempts = async (result: T) => {
      let runtimeAttempts: NetworkAttempt[] = [];
      if (input.workspace.readSubmittedCodeAppStatus !== undefined) {
        try {
          const status = await input.workspace.readSubmittedCodeAppStatus();
          runtimeAttempts = readRuntimeNetworkAttempts(
            [status.stderr, status.stdout].filter(Boolean).join("\n"),
          );
        } catch (error) {
          await options.logger?.warn({
            error: readUnknownErrorMessage(error),
            event: "external-resource.runtime-attempts.unavailable",
          });
        }
      }
      const attempts = new Map(
        [...input.readBlockedAttempts(result), ...runtimeAttempts].map(
          (attempt) => [JSON.stringify(attempt), attempt],
        ),
      );
      return readUncachedExternalResourceAttempts([...attempts.values()]);
    };
    const restartSubmittedCodeApp = async () => {
      if (
        submittedCodeAppStartInput === undefined ||
        input.workspace.startSubmittedCodeApp === undefined ||
        input.workspace.stopSubmittedCodeApp === undefined
      ) {
        return;
      }
      await input.workspace.stopSubmittedCodeApp();
      await uploadCache();
      await input.workspace.startSubmittedCodeApp(submittedCodeAppStartInput);
    };
    const unresolved = (result: T, attempts: NetworkAttempt[]) =>
      input.markUnresolved?.(result, attempts) ?? result;

    for (
      let pass = 1;
      pass <= retryPolicy.externalResourceBrokerPasses;
      pass += 1
    ) {
      const offlineResult = await runOffline();
      const uncached = await readUncachedAttempts(offlineResult);
      if (uncached.length === 0) return offlineResult;

      const hydration = await hydrateExternalResources(
        uncached,
        pass,
        input.stage,
      );
      if (hydration.addedResources === 0) {
        const remainingAttempts =
          readUncachedExternalResourceAttempts(uncached);
        return remainingAttempts.length === 0
          ? offlineResult
          : unresolved(offlineResult, remainingAttempts);
      }
      await restartSubmittedCodeApp();
    }

    const finalResult = await runOffline();
    const remainingAttempts = await readUncachedAttempts(finalResult);
    return remainingAttempts.length === 0
      ? finalResult
      : unresolved(finalResult, remainingAttempts);
  };

  const dependencies: AgentHarnessPipelineDependencies = {
    artifactStore: options.artifactStore,
    async capturePreparationWorkspaceDiff({ workspace }) {
      const patchStartedAt = Date.now();
      await options.logger?.info({
        event: "preparation.diff.patch.started",
        timeoutMs: preparationDiffCommandTimeoutMs,
      });
      let diff: Awaited<ReturnType<typeof readPreparationWorkspaceDiff>>;
      try {
        diff = await readPreparationWorkspaceDiff(workspace);
        await options.logger?.info({
          durationMs: Date.now() - patchStartedAt,
          event: "preparation.diff.patch.succeeded",
          patchBytes: Buffer.byteLength(diff.patch),
          timeoutMs: preparationDiffCommandTimeoutMs,
        });
      } catch (error) {
        await options.logger?.error({
          durationMs: Date.now() - patchStartedAt,
          error: readUnknownErrorMessage(error),
          event: "preparation.diff.patch.failed",
          timeoutMs: preparationDiffCommandTimeoutMs,
        });
        throw createPreparationDiffOperationError(error);
      }
      return {
        ...diff,
        patchSha256: `sha256:${createHash("sha256").update(diff.patch).digest("hex")}`,
        sourceCommitSha:
          options.repoSourceArchive?.commitSha ?? "unknown-screened-revision",
      };
    },
    async captureWorkspaceDiff({ workspace }) {
      return findScriptWritingContentChanges({
        after: await readWorkspaceContentSnapshot(workspace, {
          includeMakeADemoArtifacts: false,
        }),
        before: scriptWritingBaseline,
      });
    },
    async restorePreparationCandidate({
      preparationManifest,
      repoProfile,
      workspace,
      workspaceDiff,
    }) {
      const expectedPatchSha256 = `sha256:${createHash("sha256")
        .update(workspaceDiff.patch)
        .digest("hex")}`;
      if (workspaceDiff.patchSha256 !== expectedPatchSha256) {
        throw new Error(
          "Fidelity-approved preparation patch failed SHA-256 verification.",
        );
      }
      const screenedCommitSha = options.repoSourceArchive?.commitSha;
      if (
        screenedCommitSha === undefined ||
        workspaceDiff.sourceCommitSha !== screenedCommitSha
      ) {
        throw new Error(
          "Fidelity-approved preparation patch does not match the screened repository revision.",
        );
      }
      await materializeScreenedRepo({
        repoProfile,
        sourceArchive: options.repoSourceArchive,
        workspace,
      });
      if (workspaceDiff.patch.length > 0) {
        const patchPath = `${makeADemoDirectory}/accepted-preparation.patch`;
        await writeWorkspaceText(workspace, patchPath, workspaceDiff.patch);
        try {
          const result = await workspace.execute(
            `git -C ${shellQuote(workspaceRepoDirectory)} apply --binary ${shellQuote(patchPath)}`,
          );
          if (result.exitCode !== 0) {
            throw new Error(
              `Failed to restore fidelity-approved preparation patch: ${result.stderr || result.stdout}`,
            );
          }
        } finally {
          await removeWorkspaceFile(workspace, patchPath);
        }
      }
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifest,
        preparationManifest,
      );
      opencodeSessionId = undefined;
    },
    async createWorkspace() {
      const provider =
        options.workspaceProvider ??
        (await createDaytonaWorkspaceProvider({
          env,
          logger: options.logger,
          providerID,
        }));
      workspaceHandle = await provider.create();
      return workspaceHandle.workspace;
    },
    async exploreApp({ demoBrief, preparationManifest, workspace }) {
      const result = await runWithExternalResourceBroker({
        markUnresolved: (result, attempts) => ({
          ...result,
          validationReport: unresolvedExternalResourceValidation(
            result.validationReport,
            attempts,
            "browser",
          ),
        }),
        readBlockedAttempts: (result: SubmittedAppExplorationResult) =>
          result.validationReport.blockedNetworkAttempts,
        run: () =>
          exploreSubmittedApp({
            baseUrl: preparationManifest.baseUrl,
            ...(externalResourceManifest === undefined
              ? {}
              : { externalResourceManifest }),
            featureInventory:
              preparationManifest.productContext.featureInventory,
            preparationManifestId: preparationManifest.id,
            requestedFeatures: demoBrief.keyProductFeatures ?? [],
            workspace,
          }),
        stage: "app-exploration",
        workspace,
      });
      // On success as much as on failure: the screenshots are the standing
      // human audit for evidence classes the automated gates miss (a run can
      // pass every gate while the video shows an empty app).
      await persistExplorationEvidence({
        logger: options.logger,
        outputRoot: options.outputRoot,
        workspace,
      });
      return result;
    },
    async planFlow({
      actionCatalog,
      appMap,
      demoBrief,
      preparationManifest,
      repoProfile,
    }) {
      const workspace = requireWorkspace(workspaceHandle);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.actionCatalog,
        actionCatalog,
      );
      await writeWorkspaceJson(workspace, artifactPaths.appMap, appMap);
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifest,
        preparationManifest,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.flowSpecContract,
        createFlowSpecContract(),
      );
      let artifactError = "FlowSpec was not produced.";
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt: createFlowPlanningPrompt(
            attempt === 1 ? undefined : artifactError,
          ),
          ...optionalSessionId(opencodeSessionId),
          stage: "flow-planning",
          timeoutMs: 10 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        const flowSpecResult =
          result.exitCode === 0
            ? await tryReadWorkspaceJson(workspace, artifactPaths.flowSpec)
            : {
                error: formatAgentCommandFailure(result),
                ok: false as const,
              };
        if (flowSpecResult.ok) {
          try {
            const flowSpec = readFlowSpec(flowSpecResult.value);
            assertFlowSpecGrounded({
              actionCatalog,
              appMap,
              demoBrief,
              flowSpec,
              preparationManifest,
            });
            return flowSpec;
          } catch (error) {
            artifactError = `Invalid FlowSpec: ${readErrorMessage(error)}`;
          }
        } else {
          artifactError = flowSpecResult.error;
          throwIfRequiredArtifactWriteWasDenied({
            artifactError,
            path: artifactPaths.flowSpec,
            result,
            stage: "Flow Planning",
          });
        }
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: artifactPaths.flowSpec,
              readError: artifactError,
              result,
              stage: "Flow Planning",
            }),
          );
        }
      }
      throw new Error("Flow Planning artifact retry loop exited early.");
    },
    async prepareRepo({
      demoBrief,
      normalizedSupportingDocuments,
      repoProfile,
      repoSourcePaths,
      runPlan,
      workspace,
    }) {
      await ensureRepoMaterialized(repoProfile, workspace);
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(workspace, artifactPaths.runPlan, runPlan);
      const preparationManifestTemplate = createPreparationManifestTemplate(
        runPlan,
        demoBrief,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifestContract,
        createPreparationManifestContract(),
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifestTemplate,
        preparationManifestTemplate,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.supportingDocuments,
        normalizedSupportingDocuments ?? [],
      );
      let previousResult:
        | { exitCode: number; stderr: string; stdout: string }
        | undefined;
      let readError = "PreparationManifest was not produced.";
      let repairBaselineFingerprint: string | undefined;
      let primaryAgentTimeout: AgentHarnessCommandTimeoutError | undefined;
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const stage =
          attempt === 1 ? "repo-preparation" : "repo-preparation-repair";
        let result: OpenCodeHarnessRunResult;
        try {
          result = await runOpenCode({
            availableTools: ["read", "write"],
            configDir: openCodeConfigDirectory,
            model: `${providerID}/${modelID}`,
            prompt:
              attempt === 1
                ? createRepoPreparationPrompt({
                    demoBrief,
                    repoProfile,
                    runPlan,
                  })
                : createRepoPreparationRepairPrompt({
                    demoBrief,
                    previousResult: previousResult ?? {
                      exitCode: 1,
                      stderr: "",
                      stdout: "",
                    },
                    readError,
                    repoProfile,
                    runPlan,
                  }),
            ...optionalSessionId(opencodeSessionId),
            stage,
            timeoutMs: attempt === 1 ? 20 * 60_000 : 10 * 60_000,
            workingDirectory: workspaceRepoDirectory,
            workspace,
          });
        } catch (error) {
          if (
            primaryAgentTimeout !== undefined &&
            isAgentHarnessInfrastructureError(error)
          ) {
            attachSecondaryFailure(primaryAgentTimeout, "recoveryError", error);
            throw primaryAgentTimeout;
          }
          throw error;
        }
        primaryAgentTimeout ??= result.timeoutError;
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        previousResult = result;
        const candidateManifest = await tryReadPreparationManifest(
          workspace,
          artifactPaths.preparationManifest,
          { demoBrief, repoProfile, repoSourcePaths, runPlan },
        );
        let manifestResult: PreparationManifestReadResult =
          candidateManifest.ok || result.exitCode === 0
            ? candidateManifest
            : {
                error: formatAgentCommandFailure(result),
                failureClassification: "agent-command",
                ok: false as const,
              };
        if (
          attempt > 1 &&
          repairBaselineFingerprint !== undefined &&
          manifestResult.candidateFingerprint === repairBaselineFingerprint
        ) {
          manifestResult = {
            ...(manifestResult.candidate === undefined
              ? {}
              : { candidate: manifestResult.candidate }),
            candidateFingerprint: manifestResult.candidateFingerprint,
            error:
              "Repo Preparation Repair did not modify preparation-manifest.json.",
            failureClassification: "unchanged",
            ok: false,
          };
        }
        let syntaxEvidencePath: string | undefined;
        if (
          !manifestResult.ok &&
          manifestResult.failureClassification === "invalid-json" &&
          manifestResult.rawCandidate !== undefined &&
          attempt < retryPolicy.agentArtifactAttempts
        ) {
          syntaxEvidencePath = `${makeADemoDirectory}/invalid-preparation-manifest-attempt-${attempt}.json`;
          await writeWorkspaceText(
            workspace,
            syntaxEvidencePath,
            manifestResult.rawCandidate,
          );
          await writeWorkspaceJson(
            workspace,
            artifactPaths.preparationManifest,
            preparationManifestTemplate,
          );
          repairBaselineFingerprint = fingerprintArtifactText(
            `${JSON.stringify(preparationManifestTemplate, null, 2)}\n`,
          );
        } else if (
          manifestResult.ok ||
          manifestResult.failureClassification !== "unchanged"
        ) {
          repairBaselineFingerprint = undefined;
        }
        const persistedManifestResult =
          syntaxEvidencePath === undefined || manifestResult.ok
            ? manifestResult
            : { ...manifestResult, syntaxEvidencePath };
        await persistAgentArtifactAttempt({
          artifactStore: options.artifactStore,
          attempt,
          result: persistedManifestResult,
          route: "repo-preparation",
          sessionId: opencodeSessionId,
        });
        await writeAgentArtifactValidationLog({
          attempt,
          logger: options.logger,
          result: persistedManifestResult,
          route: "repo-preparation",
          sessionId: opencodeSessionId,
          workspace,
        });
        if (persistedManifestResult.ok) {
          return {
            manifest: persistedManifestResult.manifest,
            ...(opencodeSessionId === undefined ? {} : { opencodeSessionId }),
          };
        }
        readError = formatPreparationManifestReadError(persistedManifestResult);
        throwIfRequiredArtifactWriteWasDenied({
          artifactError: readError,
          path: artifactPaths.preparationManifest,
          result,
          stage: "Repo Preparation",
        });
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw attachOpenCodeSession(
            new Error(
              formatOpenCodeArtifactContractError({
                path: artifactPaths.preparationManifest,
                readError,
                result,
                stage: "Repo Preparation Repair",
              }),
            ),
            opencodeSessionId,
          );
        }
      }
      throw new Error("Repo Preparation artifact retry loop exited early.");
    },
    async repairPreparation({
      demoBrief,
      failureReport,
      preparationManifest,
      repoProfile,
      repoSourcePaths,
      runPlan,
      workspace,
    }) {
      const dependencyRepair = isDependencyRepairFailure(
        failureReport.failureClassification,
      );
      const rebuildFromScreenedSource =
        failureReport.stage === "preparation-fidelity";
      if (rebuildFromScreenedSource) {
        await materializeScreenedRepo({
          repoProfile,
          sourceArchive: options.repoSourceArchive,
          workspace,
        });
        await removeWorkspaceFile(workspace, artifactPaths.preparationManifest);
        opencodeSessionId = undefined;
      }
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      if (!rebuildFromScreenedSource) {
        await writeWorkspaceJson(
          workspace,
          artifactPaths.preparationManifest,
          preparationManifest,
        );
      }
      await writeWorkspaceJson(
        workspace,
        validationArtifactPath(failureReport.stage),
        failureReport,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(workspace, artifactPaths.runPlan, runPlan);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifestContract,
        createPreparationManifestContract(),
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifestTemplate,
        createPreparationManifestTemplate(runPlan, demoBrief),
      );
      let artifactError: string | undefined;
      let timeoutRetryUsed = false;
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt: createRuntimePreparationRepairPrompt({
            ...(artifactError === undefined ? {} : { artifactError }),
            demoBrief,
            failureReport,
            preparationManifest,
            repoProfile,
            runPlan,
          }),
          ...optionalSessionId(opencodeSessionId),
          stage: "repo-preparation-repair",
          timeoutMs: 15 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        if (dependencyRepair) {
          await writeWorkspaceJson(
            workspace,
            artifactPaths.preparationManifest,
            preparationManifest,
          );
        }
        let manifestResult: PreparationManifestReadResult;
        if (result.exitCode !== 0) {
          manifestResult = {
            error: formatAgentCommandFailure(result),
            failureClassification: "agent-command",
            ok: false,
          };
        } else if (dependencyRepair) {
          manifestResult = {
            candidate: preparationManifest,
            candidateFingerprint: fingerprintArtifactText(
              JSON.stringify(preparationManifest),
            ),
            manifest: preparationManifest,
            ok: true,
          };
        } else {
          manifestResult = await tryReadPreparationManifest(
            workspace,
            artifactPaths.preparationManifest,
            { demoBrief, repoProfile, repoSourcePaths, runPlan },
          );
        }
        runtimeRepairArtifactAttempt += 1;
        await persistAgentArtifactAttempt({
          artifactStore: options.artifactStore,
          attempt: runtimeRepairArtifactAttempt,
          result: manifestResult,
          route: "repo-preparation-runtime-repair",
          sessionId: opencodeSessionId,
        });
        await writeAgentArtifactValidationLog({
          attempt: runtimeRepairArtifactAttempt,
          logger: options.logger,
          result: manifestResult,
          route: "repo-preparation-runtime-repair",
          sessionId: opencodeSessionId,
          workspace,
        });
        if (result.timeoutError !== undefined) {
          if (
            timeoutRetryUsed ||
            attempt === retryPolicy.agentArtifactAttempts
          ) {
            throw result.timeoutError;
          }
          timeoutRetryUsed = true;
          opencodeSessionId = undefined;
          artifactError = `${
            manifestResult.ok
              ? result.timeoutError.message
              : manifestResult.error
          } The previous repair attempt was killed mid-work; the workspace may contain its unfinished edits — review them against the failure report before submitting.`;
          continue;
        }
        if (manifestResult.ok) {
          return {
            manifest: manifestResult.manifest,
            ...(opencodeSessionId === undefined ? {} : { opencodeSessionId }),
          };
        }
        artifactError = manifestResult.error;
        throwIfRequiredArtifactWriteWasDenied({
          artifactError,
          path: artifactPaths.preparationManifest,
          result,
          stage: "Repo Preparation Repair",
        });
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: artifactPaths.preparationManifest,
              readError: artifactError,
              result,
              stage: "Repo Preparation Repair",
            }),
          );
        }
      }
      throw new Error("Repo Preparation repair retry loop exited early.");
    },
    async repairScript({
      actionCatalog,
      appMap,
      failureReport,
      flowSpec,
      preparationManifest,
      repoProfile,
      workspace,
    }) {
      await writeScriptContracts(workspace, trustedStaticImageAssetIds);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.actionCatalog,
        actionCatalog,
      );
      await writeWorkspaceJson(workspace, artifactPaths.appMap, appMap);
      await writeWorkspaceJson(workspace, artifactPaths.flowSpec, flowSpec);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifest,
        preparationManifest,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(
        workspace,
        failureReport.stage === "capture-path-validation"
          ? artifactPaths.capturePathValidation
          : "/workspace/.makeademo/static-script-contract-validation.json",
        failureReport,
      );
      scriptWritingBaseline = await readWorkspaceContentSnapshot(workspace, {
        includeMakeADemoArtifacts: false,
      });
      let artifactError: string | undefined;
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt: createScriptRepairPrompt({
            ...(artifactError === undefined ? {} : { artifactError }),
            failureReport,
          }),
          ...optionalSessionId(opencodeSessionId),
          stage: "script-repair",
          timeoutMs: 10 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        const demoScriptResult =
          result.exitCode === 0
            ? await tryReadWorkspaceJson(workspace, DEMO_SCRIPT_OUTPUT_PATH)
            : {
                error: formatAgentCommandFailure(result),
                ok: false as const,
              };
        if (demoScriptResult.ok) {
          return createScriptCandidate({
            actionCatalog,
            appMap,
            demoScript: demoScriptResult.value,
            flowSpec,
            preparationManifest,
            trustedStaticImageAssetIds,
          });
        }
        artifactError = demoScriptResult.error;
        throwIfRequiredArtifactWriteWasDenied({
          artifactError,
          path: DEMO_SCRIPT_OUTPUT_PATH,
          result,
          stage: "Script Repair",
        });
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: DEMO_SCRIPT_OUTPUT_PATH,
              readError: artifactError,
              result,
              stage: "Script Repair",
            }),
          );
        }
      }
      throw new Error("Script Repair artifact retry loop exited early.");
    },
    async resetCaptureRuntime({
      preparationManifest,
      repoProfile,
      runPlan,
      workspace,
    }) {
      return await validateRuntimeWithExternalResources({
        installDependencies: false,
        preparationManifest,
        repoProfile,
        runPlan,
        stage: "capture-runtime-reset",
        workspace,
      });
    },
    async synthesizeRunPlan({
      demoBrief,
      normalizedSupportingDocuments,
      repoProfile,
      workspace,
    }) {
      const candidates = repoProfile.browserRuntimeCandidates ?? [];
      if (demoBrief.preferredAppDir !== undefined) {
        return synthesizeRunPlan(
          repoProfile,
          createExplicitRuntimeTargetSelection(
            repoProfile,
            demoBrief.preferredAppDir,
          ),
        );
      }
      if (candidates.length <= 1) {
        return synthesizeRunPlan(repoProfile);
      }

      await ensureRepoMaterialized(repoProfile, workspace);
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.runtimeTargetSelectionContract,
        createRuntimeTargetSelectionContract(repoProfile),
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.supportingDocuments,
        normalizedSupportingDocuments ?? [],
      );
      let artifactError = "Runtime target selection was not produced.";
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt: createRuntimeTargetSelectionPrompt(
            attempt === 1 ? undefined : artifactError,
          ),
          ...optionalSessionId(opencodeSessionId),
          stage: "runtime-target-selection",
          timeoutMs: 5 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        const diff = await readPreparationWorkspaceDiff(workspace);
        if (diff.changedPaths.length > 0) {
          throw new Error(
            `Runtime Target Selection must be read-only; changed: ${diff.changedPaths.join(", ")}.`,
          );
        }
        const selectionResult =
          result.exitCode === 0
            ? await tryReadWorkspaceJson(
                workspace,
                artifactPaths.runtimeTargetSelection,
              )
            : {
                error: formatAgentCommandFailure(result),
                ok: false as const,
              };
        if (selectionResult.ok) {
          try {
            return synthesizeRunPlan(
              repoProfile,
              readModelRuntimeTargetSelection(
                selectionResult.value,
                repoProfile,
              ),
            );
          } catch (error) {
            if (error instanceof RuntimeTargetSelectionRequiredError) {
              throw error;
            }
            artifactError = `Invalid runtime target selection: ${readErrorMessage(error)}`;
          }
        } else {
          artifactError = selectionResult.error;
          throwIfRequiredArtifactWriteWasDenied({
            artifactError,
            path: artifactPaths.runtimeTargetSelection,
            result,
            stage: "Runtime Target Selection",
          });
        }
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: artifactPaths.runtimeTargetSelection,
              readError: artifactError,
              result,
              stage: "Runtime Target Selection",
            }),
          );
        }
      }
      throw new Error("Runtime Target Selection retry loop exited early.");
    },
    async validateCapturePath({ preparationManifest, scriptCandidate }) {
      const handle = requireWorkspaceHandle(workspaceHandle);
      return validateDynamicCapturePath(
        {
          preparationManifest,
          scriptCandidate,
        },
        {
          async runCapturePath() {
            try {
              const demoScript = parseDemoScript(
                scriptCandidate.scriptJsonContent,
              );
              const browserScenes = demoScript.scenes.filter(
                (scene): scene is PlaywrightRecordingSceneDescription =>
                  scene.type === "playwright-recording",
              );
              if (browserScenes.length === 0) {
                return {
                  blockedNetworkAttempts: [],
                  browserUrl: preparationManifest.baseUrl,
                  logs: [
                    "Capture Path Validation skipped: Demo Script has no browser Scenes.",
                  ],
                  status: "succeeded" as const,
                  warnings: [],
                };
              }
              const demoPlaywrightScript = demoScript.demoPlaywrightScript;
              if (demoPlaywrightScript === undefined) {
                throw new Error(
                  "Demo Script browser Scenes did not compile to Playwright source.",
                );
              }
              const expectedStepIdsByScene = Object.fromEntries([
                [
                  "setup",
                  demoScript.setupActions?.map((action) => action.id) ?? [],
                ],
                ...browserScenes.map((scene) => [
                  scene.id,
                  scene.actions?.map((action) => action.id) ?? [],
                ]),
              ]);
              let captureValidationRun = 0;
              return await runWithExternalResourceBroker({
                markUnresolved: (result) => ({
                  ...result,
                  failureReason:
                    "Capture Path Validation could not replay required external browser resources.",
                  status: "failed" as const,
                }),
                readBlockedAttempts: (result) => result.blockedNetworkAttempts,
                run: async () => {
                  captureValidationRun += 1;
                  return await validatePreparedWorkspaceCapturePath({
                    baseUrl: preparationManifest.baseUrl,
                    demoPlaywrightScript,
                    ...(externalResourceManifest === undefined
                      ? {}
                      : { externalResourceManifest }),
                    expectedStepIdsByScene,
                    localRunDirectory: join(
                      options.outputRoot,
                      "capture-path-validation",
                      `capture-path-validation-${Date.now()}-${captureValidationRun}`,
                    ),
                    onEvent: async (entry) => {
                      const level =
                        entry.level === "error"
                          ? "error"
                          : entry.level === "warn"
                            ? "warn"
                            : "info";
                      await options.logger?.[level](entry);
                    },
                    sceneIds: browserScenes.map((scene) => scene.id),
                    workspace: handle,
                  });
                },
                stage: "capture-path-validation",
                workspace: handle.workspace,
              });
            } catch (error) {
              const diagnostic = readErrorDiagnostic(error);
              return {
                blockedNetworkAttempts: [],
                browserUrl: preparationManifest.baseUrl,
                failureReason: diagnostic.summary,
                logs: diagnostic.details,
                scriptPath: scriptCandidate.outputPath,
                status: "failed" as const,
                warnings: [],
              };
            }
          },
        },
      );
    },
    async validatePreparation({
      preparationManifest,
      reconcileLockfile,
      repoProfile,
      runPlan,
      workspace,
    }) {
      return await validateRuntimeWithExternalResources({
        preparationManifest,
        ...(reconcileLockfile === undefined ? {} : { reconcileLockfile }),
        repoProfile,
        runPlan,
        workspace,
      });
    },
    async validateScriptContract({
      actionCatalog,
      flowSpec,
      preparationManifest,
      scriptCandidate,
    }) {
      return validateDemoScriptCandidateContract({
        actionCatalog,
        flowSpec,
        preparationManifest,
        requireCanonicalNarrative: true,
        scriptCandidate,
        trustedStaticImageAssetIds,
      });
    },
    async writeScript({
      actionCatalog,
      appMap,
      demoBrief,
      flowSpec,
      preparationManifest,
      repoProfile,
      workspace,
    }) {
      await writeScriptContracts(workspace, trustedStaticImageAssetIds);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.actionCatalog,
        actionCatalog,
      );
      await writeWorkspaceJson(workspace, artifactPaths.appMap, appMap);
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(workspace, artifactPaths.flowSpec, flowSpec);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifest,
        preparationManifest,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      scriptWritingBaseline = await readWorkspaceContentSnapshot(workspace, {
        includeMakeADemoArtifacts: false,
      });
      let artifactError = "Demo Script was not produced.";
      for (
        let attempt = 1;
        attempt <= retryPolicy.agentArtifactAttempts;
        attempt += 1
      ) {
        const stage = attempt === 1 ? "script-writing" : "script-repair";
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt:
            attempt === 1
              ? createScriptWritingPrompt({
                  demoBrief,
                })
              : createScriptArtifactRepairPrompt({
                  artifactError,
                  demoBrief,
                }),
          ...optionalSessionId(opencodeSessionId),
          stage,
          timeoutMs: attempt === 1 ? 15 * 60_000 : 10 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        const demoScriptResult =
          result.exitCode === 0
            ? await tryReadWorkspaceJson(workspace, DEMO_SCRIPT_OUTPUT_PATH)
            : {
                error: formatAgentCommandFailure(result),
                ok: false as const,
              };
        if (demoScriptResult.ok) {
          return createScriptCandidate({
            actionCatalog,
            appMap,
            demoScript: demoScriptResult.value,
            flowSpec,
            preparationManifest,
            trustedStaticImageAssetIds,
          });
        }
        artifactError = demoScriptResult.error;
        throwIfRequiredArtifactWriteWasDenied({
          artifactError,
          path: DEMO_SCRIPT_OUTPUT_PATH,
          result,
          stage:
            stage === "script-writing" ? "Script Writing" : "Script Repair",
        });
        if (attempt === retryPolicy.agentArtifactAttempts) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: DEMO_SCRIPT_OUTPUT_PATH,
              readError: artifactError,
              result,
              stage: "Script Repair",
            }),
          );
        }
      }
      throw new Error("Script Writing artifact retry loop exited early.");
    },
  };

  return {
    dependencies,
    getExternalResourceCache: () =>
      externalResourceManifest === undefined
        ? undefined
        : {
            directory: externalResourceDirectory,
            manifest: externalResourceManifest,
          },
    getWorkspaceHandle: () => workspaceHandle,
  };
}

async function runLoggedOpenCode(input: {
  input: OpenCodeHarnessRunInput;
  logger: PipelineEventLogger | undefined;
  openCodeRunner: OpenCodeHarnessRunner;
}): Promise<OpenCodeHarnessRunResult> {
  const startedAt = Date.now();
  let lastOutputAt: string | undefined;
  let partialStderr = "";
  let partialStdout = "";
  const startedEntry = {
    event: "agent.command.started",
    message: `${input.input.stage} agent command started.`,
    model: input.input.model,
    stage: input.input.stage,
    ...(input.input.inactivityTimeoutMs === undefined
      ? {}
      : { inactivityTimeoutMs: input.input.inactivityTimeoutMs }),
    timeoutMs: input.input.timeoutMs,
    ...(input.input.sessionId === undefined
      ? {}
      : { opencodeSessionId: input.input.sessionId }),
  };
  await writeAgentStageLog(input, startedEntry, "info");

  try {
    const result = await input.openCodeRunner.run({
      ...input.input,
      onStderr: (chunk) => {
        lastOutputAt = new Date().toISOString();
        partialStderr = appendTail(partialStderr, chunk, 4_000);
        input.input.onStderr?.(chunk);
      },
      onStdout: (chunk) => {
        lastOutputAt = new Date().toISOString();
        partialStdout = appendTail(partialStdout, chunk, 4_000);
        input.input.onStdout?.(chunk);
      },
    });
    const level = result.exitCode === 0 ? "info" : "error";
    await writeAgentStageLog(
      input,
      {
        durationMs: Date.now() - startedAt,
        event:
          result.exitCode === 0
            ? "agent.command.succeeded"
            : "agent.command.failed",
        exitCode: result.exitCode,
        message: `${input.input.stage} agent command ${result.exitCode === 0 ? "succeeded" : "failed"}.`,
        ...(result.sessionId === undefined
          ? {}
          : { opencodeSessionId: result.sessionId }),
        stage: input.input.stage,
        stderrExcerpt: redactSecretText(tail(result.stderr, 4_000)),
        stdoutExcerpt: redactSecretText(tail(result.stdout, 4_000)),
      },
      level,
    );
    return result;
  } catch (error) {
    const timeoutError = isAgentHarnessCommandTimeout(error)
      ? normalizeAgentHarnessCommandTimeout(error, input.input)
      : undefined;
    await writeAgentStageLog(
      input,
      {
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error),
        event: "agent.command.failed",
        ...(lastOutputAt === undefined ? {} : { lastOutputAt }),
        message: `${input.input.stage} agent command failed before completion.`,
        ...(partialStderr.length === 0
          ? {}
          : { partialStderrExcerpt: redactSecretText(partialStderr) }),
        ...(partialStdout.length === 0
          ? {}
          : { partialStdoutExcerpt: redactSecretText(partialStdout) }),
        stage: input.input.stage,
        ...(timeoutError === undefined
          ? {}
          : {
              timeoutKind: timeoutError.kind,
              timeoutMs: timeoutError.timeoutMs,
            }),
      },
      "error",
    );
    if (timeoutError !== undefined) {
      return {
        exitCode: 124,
        ...(input.input.sessionId === undefined
          ? {}
          : { sessionId: input.input.sessionId }),
        stderr: [readErrorMessage(error), partialStderr]
          .filter((value) => value.length > 0)
          .join("\n"),
        stdout: partialStdout,
        timeoutError,
      };
    }
    throw error;
  }
}

function appendTail(current: string, chunk: string, maxLength: number): string {
  return `${current}${chunk}`.slice(-maxLength);
}

function isAgentHarnessCommandTimeout(error: unknown): error is Error {
  return (
    error instanceof Error && error.name === "AgentHarnessCommandTimeoutError"
  );
}

function normalizeAgentHarnessCommandTimeout(
  error: Error,
  input: OpenCodeHarnessRunInput,
): AgentHarnessCommandTimeoutError {
  if (error instanceof AgentHarnessCommandTimeoutError) {
    return error;
  }
  const inactivity = error.message.includes("produced no output");
  return new AgentHarnessCommandTimeoutError(
    inactivity
      ? (input.inactivityTimeoutMs ?? input.timeoutMs)
      : input.timeoutMs,
    inactivity ? "inactivity" : "deadline",
  );
}

function attachSecondaryFailure(
  primaryError: Error,
  key: string,
  secondaryError: unknown,
): void {
  try {
    Reflect.set(primaryError, key, secondaryError);
  } catch {
    // Preserve the primary agent failure when it is non-extensible.
  }
}

async function writeAgentStageLog(
  input: {
    input: OpenCodeHarnessRunInput;
    logger: PipelineEventLogger | undefined;
  },
  entry: Record<string, unknown>,
  level: "error" | "info",
): Promise<void> {
  await input.logger?.[level](entry);
  await writeSandboxLogBestEffort({
    entry: {
      ...entry,
      source: "agent-harness",
      timestamp: new Date().toISOString(),
    },
    logger: input.logger,
    workspace: input.input.workspace,
  });
}

async function writeSandboxLogBestEffort(input: {
  entry: Record<string, unknown>;
  logger: PipelineEventLogger | undefined;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  if (input.workspace.writeSandboxLog === undefined) {
    return;
  }
  try {
    await input.workspace.writeSandboxLog(input.entry);
  } catch (error) {
    try {
      await input.logger?.warn({
        error: readErrorMessage(error),
        event: "sandbox.log.write.failed",
        message: "Sandbox audit log write failed; continuing with local logs.",
        ...(typeof input.entry.stage === "string"
          ? { stage: input.entry.stage }
          : {}),
      });
    } catch {
      // The primary operation must not be replaced by observability failures.
    }
  }
}

async function createDaytonaWorkspaceProvider(input: {
  env: Record<string, string | undefined>;
  logger: PipelineEventLogger | undefined;
  providerID: string;
}): Promise<AgentHarnessWorkspaceProvider> {
  const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
    env: input.env,
    providerID: input.providerID,
    ...(input.env.DAYTONA_API_KEY === undefined
      ? {}
      : { daytonaApiKey: input.env.DAYTONA_API_KEY }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  return new DaytonaSdkPreparationWorkspaceProvider({
    secrets: createOpenCodeProviderSandboxSecrets({
      providerID: input.providerID,
      providerSecretName,
    }),
    ...(input.env.DAYTONA_API_KEY === undefined
      ? {}
      : { apiKey: input.env.DAYTONA_API_KEY }),
    ...(input.env.MAKEADEMO_DAYTONA_SNAPSHOT === undefined
      ? {}
      : { snapshot: input.env.MAKEADEMO_DAYTONA_SNAPSHOT }),
    ...(input.env.MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT === undefined
      ? {}
      : {
          submittedCodeSnapshot:
            input.env.MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT,
        }),
  });
}

async function materializeScreenedRepo(input: {
  repoProfile: RepoProfile;
  sourceArchive: RepoSourceArchive | undefined;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  if (input.sourceArchive === undefined) {
    throw new Error(
      "Repo Preparation requires the immutable archive produced by Repo Security Screen.",
    );
  }
  if (
    input.repoProfile.commitSha !== undefined &&
    input.repoProfile.commitSha !== input.sourceArchive.commitSha
  ) {
    throw new Error(
      `Screened repository revision mismatch: expected ${input.repoProfile.commitSha}, received ${input.sourceArchive.commitSha}.`,
    );
  }
  await assertRepoSourceArchiveIntegrity(input.sourceArchive);
  if (!/^[0-9a-f]{64}$/.test(input.sourceArchive.sha256)) {
    throw new Error("Screened repository archive SHA-256 is malformed.");
  }
  if (input.workspace.uploadFiles === undefined) {
    throw new Error(
      "Repo Preparation workspace artifact upload is unavailable.",
    );
  }
  const remoteArchivePath = `${makeADemoDirectory}/screened-repo.tar`;
  await input.workspace.uploadFiles([
    {
      destinationPath: remoteArchivePath,
      sourcePath: input.sourceArchive.path,
    },
  ]);
  const result = await input.workspace.execute(
    `sh -lc ${shellQuote(
      [
        `mkdir -p ${shellQuote(makeADemoDirectory)}`,
        `actual_sha=$(sha256sum ${shellQuote(remoteArchivePath)} | cut -d ' ' -f 1)`,
        `test "$actual_sha" = ${shellQuote(input.sourceArchive.sha256)}`,
        `rm -rf ${shellQuote(workspaceRepoDirectory)}`,
        `mkdir -p ${shellQuote(workspaceRepoDirectory)}`,
        `tar --no-same-owner --no-same-permissions -xf ${shellQuote(remoteArchivePath)} -C ${shellQuote(workspaceRepoDirectory)}`,
        `git -C ${shellQuote(workspaceRepoDirectory)} init -q`,
        `git -C ${shellQuote(workspaceRepoDirectory)} add -f -A`,
        `git -C ${shellQuote(workspaceRepoDirectory)} -c user.name=MakeADemo -c user.email=makeademo@localhost commit -q --allow-empty -m ${shellQuote(`Screened source ${input.sourceArchive.commitSha}`)}`,
        `printf '%s\n' node_modules .vite .turbo .npm .pnpm-store .yarn/cache .next/cache .bun .cache >> ${shellQuote(`${workspaceRepoDirectory}/.git/info/exclude`)}`,
        `rm -f ${shellQuote(remoteArchivePath)}`,
      ].join(" && "),
    )}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Screened repository archive extraction failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function validateSubmittedCodeRuntime(input: {
  buildApp?: boolean;
  externalResourceCache?: {
    directory: string;
    manifest: ExternalResourceManifest;
  };
  installDependencies?: boolean;
  onAppStart?: (input: AgentHarnessSubmittedCodeAppStartInput) => void;
  preparationManifest: PreparationManifest;
  reconcileLockfile?: boolean;
  repoProfile: RepoProfile;
  resetWorkspace?: boolean;
  runPlan: RunPlan;
  stage?: string;
  workspace: AgentHarnessWorkspace;
}): Promise<ValidationReport> {
  const resolution = resolvePreparationRuntime({
    preparationManifest: input.preparationManifest,
    repoProfile: input.repoProfile,
    runPlan: input.runPlan,
  });
  const manifest = resolution.preparationManifest;
  const runtimeTarget = resolution.runtimeTarget;
  const stage = input.stage ?? "preparation-preflight";
  const runtimeConfigurationIssue = findRuntimeConfigurationIssue({
    preparationManifest: manifest,
    repoProfile: input.repoProfile,
  });
  if (runtimeConfigurationIssue !== undefined) {
    return failedPreparationValidation({
      attemptedCommand: manifest.startCommandUsed,
      classification: "start failure",
      logsSummary: runtimeConfigurationIssue,
      manifest,
      stage,
    });
  }
  const buildScopeViolation = findBuildScopeViolation({
    manifest,
    repoProfile: input.repoProfile,
  });
  if (buildScopeViolation !== undefined) {
    return failedPreparationValidation({
      attemptedCommand: buildScopeViolation.attemptedCommand,
      classification: "build failure",
      logsSummary: `Root aggregate build is too broad for the prepared feature. Use ${buildScopeViolation.scopedCommand} instead.`,
      manifest,
      stage,
    });
  }
  try {
    await stopSubmittedCodeApp(input.workspace);
    await setSubmittedCodeNetwork(input.workspace, false);
    if (input.resetWorkspace !== false) {
      await input.workspace.syncSubmittedCodeWorkspace?.();
    }
  } catch (error) {
    if (isAgentHarnessInfrastructureError(error)) throw error;
    return failedPreparationValidation({
      classification: "harness/internal failure",
      logsSummary: `Failed to reset submitted-code workspace: ${readErrorMessage(error)}`,
      manifest,
      stage,
    });
  }

  if (input.installDependencies !== false) {
    const installCommand =
      manifest.installCommandUsed || input.runPlan.installCommand;
    const runInstall = (command: string) =>
      runDependencyInstallThroughGate({
        closeNetwork: () => setSubmittedCodeNetwork(input.workspace, false),
        command,
        openNetwork: () => setSubmittedCodeNetwork(input.workspace, true),
        runCommand: () =>
          executeSubmitted(
            input.workspace,
            commandInAppDirectory(
              runtimeTarget?.install.cwd ?? manifest.appDir,
              command,
            ),
            { timeoutMs: dependencyInstallTimeoutMs },
          ),
      });
    type InstallResult = Awaited<ReturnType<typeof runInstall>>;
    const reconcileLockfile = async (
      reconciliationCommand: string,
    ): Promise<InstallResult | undefined> => {
      const reconciliation = await runInstall(reconciliationCommand);
      if (reconciliation.status === "succeeded") {
        try {
          if (input.workspace.promoteSubmittedCodeFiles === undefined) {
            throw new Error(
              "Workspace cannot persist an automatic lockfile reconciliation.",
            );
          }
          await input.workspace.promoteSubmittedCodeFiles(
            readReconciledLockfilePaths({
              installCommand,
              installDirectory: runtimeTarget?.install.cwd ?? manifest.appDir,
              lockfiles: input.repoProfile.lockfiles,
            }),
          );
          return undefined;
        } catch (error) {
          return {
            exitCode: 1,
            status: "failed",
            stderr: `Automatic lockfile reconciliation could not be persisted: ${readErrorMessage(error)}`,
            stdout: "",
          };
        }
      }
      if (reconciliation.status === "failed") {
        return {
          ...reconciliation,
          stderr: [
            "Automatic lockfile reconciliation failed.",
            reconciliation.stderr || reconciliation.stdout,
          ]
            .filter((value) => value.length > 0)
            .join("\n"),
        };
      }
      return reconciliation;
    };

    let result: InstallResult;
    if (input.reconcileLockfile === true) {
      const reconciliationCommand =
        createLockfileReconciliationCommand(installCommand);
      result =
        reconciliationCommand === undefined
          ? {
              exitCode: 1,
              status: "failed",
              stderr:
                "Automatic lockfile reconciliation could not determine the package manager.",
              stdout: "",
            }
          : ((await reconcileLockfile(reconciliationCommand)) ??
            (await runInstall(installCommand)));
    } else {
      result = await runInstall(installCommand);
      const reconciliationCommand =
        result.status === "failed"
          ? planLockfileReconciliation({
              installCommand,
              stderr: result.stderr,
              stdout: result.stdout,
            })
          : undefined;
      if (reconciliationCommand !== undefined) {
        result =
          (await reconcileLockfile(reconciliationCommand)) ??
          (await runInstall(installCommand));
      }
    }
    if (result.status === "denied") {
      return failedPreparationValidation({
        attemptedCommand: installCommand,
        classification: "install failure",
        logsSummary: result.reason,
        manifest,
        stage,
      });
    }
    if (result.status === "failed") {
      const unreachable = readUnreachableDependencyHost(result);
      if (unreachable !== undefined) {
        return failedPreparationValidation({
          attemptedCommand: installCommand,
          classification: "external network required",
          exitCode: result.exitCode,
          logsSummary: `Dependency install cannot reach ${unreachable.host}${unreachable.packageName === undefined ? "" : ` for package ${unreachable.packageName}`}; a retry inside the open install window failed with the same network error: ${result.stderr || result.stdout}`,
          manifest,
          stage,
          stderr: result.stderr,
          stdout: result.stdout,
          suggestedRepairHints: [
            `Host ${unreachable.host} stays unreachable from the sandbox; do not retry the same URL. Package-manager overrides or resolutions cannot bypass it because the tarball is still downloaded during resolution. Search the lockfile for the direct dependency whose manifest pins ${unreachable.packageName ?? "the unreachable tarball"} to ${unreachable.host} and change that package's version in package.json to one that resolves entirely from the registry.`,
          ],
        });
      }
      return failedPreparationValidation({
        attemptedCommand: installCommand,
        classification: "install failure",
        exitCode: result.exitCode,
        logsSummary: `Submitted-code dependency install failed: ${result.stderr || result.stdout}`,
        manifest,
        stage,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
  }

  if (input.workspace.startSubmittedCodeApp === undefined) {
    return failedPreparationValidation({
      attemptedCommand: manifest.startCommandUsed,
      classification: "harness/internal failure",
      logsSummary:
        "Managed submitted-code app execution is not configured for this workspace.",
      manifest,
      stage,
    });
  }
  if (input.externalResourceCache !== undefined) {
    try {
      await uploadSubmittedCodeExternalResourceCache({
        directory: input.externalResourceCache.directory,
        manifest: input.externalResourceCache.manifest,
        workspace: input.workspace,
      });
    } catch (error) {
      if (isAgentHarnessInfrastructureError(error)) throw error;
      return failedPreparationValidation({
        classification: "harness/internal failure",
        logsSummary: `Failed to upload the submitted-code External Resource Cache: ${readErrorMessage(error)}`,
        manifest,
        stage,
      });
    }
  }
  const networkGuardInstallation = await installRuntimeNetworkGuard(
    input.workspace,
  );
  if (networkGuardInstallation.exitCode !== 0) {
    return failedPreparationValidation({
      classification: "harness/internal failure",
      logsSummary: `Failed to install submitted-code runtime network guard: ${networkGuardInstallation.stderr || networkGuardInstallation.stdout}`,
      manifest,
      stage,
    });
  }
  const existingNodeOptions = manifest.envUsed.NODE_OPTIONS?.trim();
  const guardedRuntimeEnv = {
    ...manifest.envUsed,
    NODE_OPTIONS: [existingNodeOptions, `--require=${runtimeNetworkGuardPath}`]
      .filter(
        (value): value is string => value !== undefined && value.length > 0,
      )
      .join(" "),
  };

  if (input.buildApp !== false && manifest.buildCommandUsed !== undefined) {
    const buildResult = await executeSubmitted(
      input.workspace,
      commandInAppDirectory(
        runtimeTarget?.build?.cwd ?? manifest.appDir,
        manifest.buildCommandUsed,
      ),
      { env: guardedRuntimeEnv, timeoutMs: submittedCodeBuildTimeoutMs },
    );
    const blockedBuildAttempts = readRuntimeNetworkAttempts(
      [buildResult.stderr, buildResult.stdout].filter(Boolean).join("\n"),
    );
    if (buildResult.exitCode !== 0 || blockedBuildAttempts.length > 0) {
      return failedPreparationValidation({
        attemptedCommand: manifest.buildCommandUsed,
        blockedNetworkAttempts: blockedBuildAttempts,
        classification:
          blockedBuildAttempts.length > 0
            ? "external network attempted"
            : "build failure",
        exitCode: buildResult.exitCode,
        logsSummary:
          blockedBuildAttempts.length > 0
            ? `Submitted-code build requested ${blockedBuildAttempts.length} uncached external resource(s): ${buildResult.stderr || buildResult.stdout}`
            : `Submitted-code build failed: ${buildResult.stderr || buildResult.stdout}`,
        manifest,
        stage,
        stderr: buildResult.stderr,
        stdout: buildResult.stdout,
      });
    }
  }
  const appStartInput = {
    command: manifest.startCommandUsed,
    cwd: absoluteAppDirectory(runtimeTarget?.start.cwd ?? manifest.appDir),
    env: guardedRuntimeEnv,
  };
  input.onAppStart?.(appStartInput);
  try {
    await input.workspace.startSubmittedCodeApp(appStartInput);
  } catch (error) {
    if (isAgentHarnessInfrastructureError(error)) throw error;
    return failedPreparationValidation({
      attemptedCommand: manifest.startCommandUsed,
      classification: "harness/internal failure",
      logsSummary: `Daytona could not start the managed submitted-code app session: ${readErrorMessage(error)}`,
      manifest,
      stage,
    });
  }

  const preflightUrl = preparationProbeUrl(manifest);
  const preflightResult = await probeSubmittedCodeRuntime(
    input.workspace,
    preflightUrl,
  );
  const probeExecutionFailed =
    isReadinessProbeExecutionFailure(preflightResult);
  const probeResponded =
    preflightResult.exitCode === 0 &&
    preflightResult.runtimeProbe.attempts.at(-1)?.outcome === "responded";
  let appStatus:
    | Awaited<
        ReturnType<
          NonNullable<AgentHarnessWorkspace["readSubmittedCodeAppStatus"]>
        >
      >
    | undefined;
  let appStatusError: string | undefined;
  if (input.workspace.readSubmittedCodeAppStatus !== undefined) {
    try {
      appStatus = await input.workspace.readSubmittedCodeAppStatus();
    } catch (error) {
      appStatusError = readErrorMessage(error);
    }
  }
  const appOutput = [appStatus?.stderr, appStatus?.stdout]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  const probeSucceeded = probeResponded && appStatus?.running !== false;
  const blockedRuntimeNetworkAttempts = readRuntimeNetworkAttempts(appOutput);
  const failedLogs = [
    `Prepared submitted-code runtime readiness failed: ${preflightResult.stderr || preflightResult.stdout}`,
    appStatus === undefined
      ? undefined
      : appStatus.running
        ? "The managed app command was still running."
        : `The managed app command exited with code ${appStatus.exitCode}.`,
    appOutput.length === 0 ? undefined : `Managed app output:\n${appOutput}`,
    appStatusError === undefined
      ? undefined
      : `Managed app status could not be read: ${appStatusError}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");

  return validationReport({
    attemptedCommand: `curl ${preflightUrl}`,
    exitCode: preflightResult.exitCode,
    blockedNetworkAttempts: blockedRuntimeNetworkAttempts,
    failureClassification: probeSucceeded
      ? "none"
      : probeExecutionFailed
        ? "harness/internal failure"
        : classifyPreparationRuntimeFailure(
            preflightResult.runtimeProbe,
            appOutput,
            appStatus?.running === false,
          ),
    logsSummary: probeSucceeded
      ? blockedRuntimeNetworkAttempts.length === 0
        ? "Prepared submitted-code runtime responded successfully."
        : `Prepared submitted-code runtime responded successfully; Runtime Network Lockdown suppressed ${blockedRuntimeNetworkAttempts.length} external request(s).`
      : failedLogs,
    stage,
    networkAttempts: blockedRuntimeNetworkAttempts,
    runtimeProbe: preflightResult.runtimeProbe,
    status: probeSucceeded ? "passed" : "failed",
    stderrExcerpts: preflightResult.stderr
      ? [preflightResult.stderr.slice(-500)]
      : [],
    stdoutExcerpts: preflightResult.stdout
      ? [preflightResult.stdout.slice(-500)]
      : [],
    urlChecked: preflightUrl,
  });
}

function classifyPreparationRuntimeFailure(
  probe: RuntimeProbeDiagnostics,
  appOutput: string,
  processExited = false,
): string {
  const missingSpecifiers = [
    ...appOutput.matchAll(
      /(?:can'?t resolve|cannot find module|could not resolve)\s+["']([^"']+)["']/gi,
    ),
  ].map((match) => match[1] ?? "");
  if (missingSpecifiers.some(isBarePackageSpecifier)) {
    return "missing dependency";
  }
  if (missingSpecifiers.length > 0) return "build failure";
  if (processExited) return "runtime crash";
  const outcome = probe.attempts.at(-1)?.outcome;
  if (outcome === "render-timeout") return "render timeout";
  if (outcome === "runtime-exited") return "runtime crash";
  if (outcome === "connection-refused") return "listen failure";
  if (outcome === "http-error") {
    if (probe.httpStatus === 401 || probe.httpStatus === 403)
      return "auth wall";
    if (probe.httpStatus === 404) return "app route not discoverable";
    if ((probe.httpStatus ?? 0) >= 500) return "build failure";
  }
  return "start failure";
}

function isBarePackageSpecifier(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/")
  ) {
    return false;
  }
  return /^(?:@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9][A-Za-z0-9_.-]*)(?:\/.*)?$/.test(
    specifier,
  );
}

function preparationProbeUrl(manifest: PreparationManifest): string {
  const entryPath = manifest.productContext.featureInventory
    .flatMap(({ entryPaths }) => entryPaths)
    .find((path) => path.length > 0);
  return entryPath === undefined
    ? manifest.baseUrl
    : new URL(entryPath, manifest.baseUrl).toString();
}

function unresolvedExternalResourceValidation(
  report: ValidationReport,
  attempts: NetworkAttempt[],
  resourceContext: "browser" | "runtime",
): ValidationReport {
  const resources = attempts.map((attempt) => attempt.url ?? attempt.host);
  return {
    ...report,
    failureClassification: "external network attempted",
    logsSummary: `The controller could not cache ${resources.length} required external ${resourceContext} resource${resources.length === 1 ? "" : "s"}: ${resources.join(", ")}.`,
    status: "failed",
    suggestedRepairHints: [
      ...report.suggestedRepairHints,
      "Make the required presentation resource public and credential-free, or provide it locally in the prepared runtime.",
    ],
  };
}

function readReconciledLockfilePaths(input: {
  installCommand: string;
  installDirectory: string;
  lockfiles: string[];
}): string[] {
  const manager = /^(?:corepack\s+)?(bun|npm|pnpm|yarn)\b/.exec(
    input.installCommand.trim(),
  )?.[1];
  const expectedNames: Record<string, string[]> = {
    bun: ["bun.lock", "bun.lockb"],
    npm: ["package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
  };
  const names = expectedNames[manager ?? ""] ?? [];
  const known = input.lockfiles.filter(
    (path) =>
      posix.dirname(path) === input.installDirectory &&
      names.includes(posix.basename(path)),
  );
  if (known.length > 0) return known.sort();
  const fallback = names[0];
  if (fallback === undefined) {
    throw new Error("Package manager lockfile type could not be determined.");
  }
  return [
    input.installDirectory === "."
      ? fallback
      : posix.join(input.installDirectory, fallback),
  ];
}

function findBuildScopeViolation(input: {
  manifest: PreparationManifest;
  repoProfile: RepoProfile;
}): { attemptedCommand: string; scopedCommand: string } | undefined {
  const buildCommand = input.manifest.buildCommandUsed;
  if (
    buildCommand === undefined ||
    input.manifest.appDir !== "." ||
    !input.repoProfile.workspaces.isMonorepo ||
    !/^(?:(?:bun|pnpm|yarn)(?:\s+run)?|npm\s+run)\s+build(?:\s|$)/.test(
      buildCommand,
    ) ||
    !/\b(?:turbo|nx|lerna)\b/.test(input.repoProfile.packageScripts.build ?? "")
  ) {
    return undefined;
  }

  const appNames = new Set(
    input.manifest.productContext.featureInventory.flatMap(({ sourcePaths }) =>
      sourcePaths.flatMap((path) => {
        const match = /(?:^|\/)apps\/([^/]+)\//.exec(path);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    ),
  );
  if (appNames.size !== 1) {
    return undefined;
  }

  const [appName] = appNames;
  const scriptName = `build:${appName}`;
  if (input.repoProfile.packageScripts[scriptName] === undefined) {
    return undefined;
  }
  const runner =
    input.repoProfile.packageManager === "unknown"
      ? "npm"
      : input.repoProfile.packageManager;
  return {
    attemptedCommand: buildCommand,
    scopedCommand: `${runner} run ${scriptName}`,
  };
}

async function installRuntimeNetworkGuard(workspace: AgentHarnessWorkspace) {
  const encodedSource = Buffer.from(createRuntimeNetworkGuardSource()).toString(
    "base64",
  );
  return await executeSubmitted(
    workspace,
    `mkdir -p ${shellQuote(makeADemoDirectory)} && printf %s ${shellQuote(encodedSource)} | base64 -d > ${shellQuote(runtimeNetworkGuardPath)}`,
  );
}

async function stopSubmittedCodeApp(
  workspace: AgentHarnessWorkspace,
): Promise<void> {
  if (workspace.stopSubmittedCodeApp === undefined) {
    throw new Error(
      "Managed submitted-code app execution is not configured for this workspace.",
    );
  }
  await workspace.stopSubmittedCodeApp();
}

async function setSubmittedCodeNetwork(
  workspace: AgentHarnessWorkspace,
  enabled: boolean,
): Promise<void> {
  await workspace.setSubmittedCodeNetworkAccess?.(enabled);
}

async function executeSubmitted(
  workspace: AgentHarnessWorkspace,
  command: string,
  options: AgentHarnessWorkspaceExecuteOptions = {},
) {
  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Submitted-code execution is not configured.");
  }
  return await workspace.executeSubmittedCode(command, options);
}

function commandInAppDirectory(appDir: string, command: string): string {
  const absoluteAppDir = absoluteAppDirectory(appDir);
  return `sh -lc ${shellQuote(`cd ${shellQuote(absoluteAppDir)} && ${command}`)}`;
}

function absoluteAppDirectory(appDir: string): string {
  const relativeAppDirectory = appDir.replace(/^\/+/, "").replace(/\/+$/, "");
  return relativeAppDirectory === "" || relativeAppDirectory === "."
    ? workspaceRepoDirectory
    : `${workspaceRepoDirectory}/${relativeAppDirectory}`;
}

/**
 * Cold monorepo dev servers routinely compile for 60–120s before binding, so
 * connection-refused probes back off exponentially until this budget elapses.
 * Every other failure mode (HTTP error, crashed process, probe execution
 * failure) still terminates the probe immediately.
 */
const runtimeReadinessBudgetMs = 180_000;
const runtimeReadinessInitialDelayMs = 2_000;
const runtimeReadinessMaxDelayMs = 15_000;

/**
 * Explicit ceilings for the two heaviest submitted-code commands, replacing
 * the implicit provider default so a hung install or build fails as a
 * classified timeout instead of an opaque provider error.
 */
const dependencyInstallTimeoutMs = 20 * 60_000;
const submittedCodeBuildTimeoutMs = 15 * 60_000;

async function probeSubmittedCodeRuntime(
  workspace: AgentHarnessWorkspace,
  url: string,
): Promise<
  AgentHarnessWorkspaceCommandResult & {
    runtimeProbe: RuntimeProbeDiagnostics;
  }
> {
  let result: AgentHarnessWorkspaceCommandResult = {
    exitCode: 1,
    stderr: "Readiness probe did not run.",
    stdout: "",
  };
  const attempts: RuntimeProbeAttempt[] = [];
  let responseMetadata: { httpStatus: number; url: string } | undefined;
  let waitedMs = 0;
  let delayMs = runtimeReadinessInitialDelayMs;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    result = await executeSubmitted(
      workspace,
      `curl -fsS --location --max-redirs 5 --connect-timeout 2 --max-time 90 --write-out ${shellQuote(`\n[makeademo:probe] {"httpStatus":%{http_code},"url":"%{url_effective}"}\n`)} ${shellQuote(url)} -o /tmp/makeademo/preflight.html`,
    );
    responseMetadata = readRuntimeProbeResponseMetadata(result.stdout);
    const process = await readRuntimeProcessObservation(workspace);
    attempts.push({
      attempt,
      ...(result.stderr || result.stdout
        ? { detail: (result.stderr || result.stdout).slice(-500) }
        : {}),
      durationMs: Date.now() - startedAtMs,
      exitCode: result.exitCode,
      outcome: readRuntimeProbeOutcome(result, process),
      startedAt,
      ...(process === undefined ? {} : { process }),
    });
    if (
      result.exitCode === 0 ||
      isReadinessProbeExecutionFailure(result) ||
      !isConnectionRefused(result) ||
      process?.running === false ||
      waitedMs >= runtimeReadinessBudgetMs
    ) {
      break;
    }
    await wait(delayMs);
    waitedMs += delayMs;
    delayMs = Math.min(delayMs * 2, runtimeReadinessMaxDelayMs);
  }
  return {
    ...result,
    runtimeProbe: {
      attempts,
      ...(responseMetadata !== undefined
        ? {
            finalUrl: responseMetadata.url,
            httpStatus: responseMetadata.httpStatus,
          }
        : result.exitCode === 0
          ? { finalUrl: url, httpStatus: 200 }
          : {}),
      targetUrl: url,
    },
  };
}

function readRuntimeProbeResponseMetadata(
  stdout: string,
): { httpStatus: number; url: string } | undefined {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("[makeademo:probe] "));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice("[makeademo:probe] ".length)) as Record<
      string,
      unknown
    >;
    return typeof value.httpStatus === "number" && typeof value.url === "string"
      ? { httpStatus: value.httpStatus, url: value.url }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readRuntimeProcessObservation(
  workspace: AgentHarnessWorkspace,
): Promise<RuntimeProbeAttempt["process"] | undefined> {
  if (workspace.readSubmittedCodeAppStatus === undefined) return undefined;
  try {
    const status = await workspace.readSubmittedCodeAppStatus();
    return runtimeProcessObservation(status);
  } catch {
    return undefined;
  }
}

function runtimeProcessObservation(
  status: AgentHarnessSubmittedCodeAppStatus,
): NonNullable<RuntimeProbeAttempt["process"]> {
  return {
    running: status.running,
    ...(status.endedAt === undefined ? {} : { endedAt: status.endedAt }),
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.signal === undefined ? {} : { signal: status.signal }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.terminationReason === undefined
      ? {}
      : { terminationReason: status.terminationReason }),
  };
}

function readRuntimeProbeOutcome(
  result: AgentHarnessWorkspaceCommandResult,
  process: RuntimeProbeAttempt["process"] | undefined,
): RuntimeProbeAttempt["outcome"] {
  if (process?.running === false) return "runtime-exited";
  if (result.exitCode === 0) return "responded";
  if (isConnectionRefused(result)) return "connection-refused";
  if (result.exitCode === 28 || /timed? out|timeout/i.test(result.stderr)) {
    return "render-timeout";
  }
  if (result.exitCode === 22 || /\b(?:4|5)\d\d\b/.test(result.stderr)) {
    return "http-error";
  }
  return "probe-error";
}

function isConnectionRefused(
  result: AgentHarnessWorkspaceCommandResult,
): boolean {
  return (
    result.exitCode === 7 ||
    /(?:couldn'?t connect|failed to connect|connection refused)/i.test(
      `${result.stderr}\n${result.stdout}`,
    )
  );
}

function isReadinessProbeExecutionFailure(
  result: AgentHarnessWorkspaceCommandResult,
): boolean {
  return (
    [2, 126, 127].includes(result.exitCode) ||
    /(?:syntax error|curl:\s*(?:command )?not found)/i.test(result.stderr)
  );
}

function assertFlowSpecGrounded(input: {
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
  flowSpec: FlowSpec;
  preparationManifest: PreparationManifest;
}): void {
  if (input.actionCatalog.appMapId !== input.appMap.id) {
    throw new Error("ActionCatalog must reference the current AppMap");
  }
  const observedRoutes = new Set(
    input.appMap.discoveredRoutes.map((route) => route.path),
  );
  const authWallRoutes = new Set(input.appMap.loginOrAuthWalls);
  const actionsById = new Map(
    input.actionCatalog.actions.map((action) => [action.id, action]),
  );
  const preparedFeaturesById = new Map(
    input.preparationManifest.productContext.featureInventory.map((feature) => [
      feature.id,
      feature,
    ]),
  );
  const distinctContentByRoute = readRouteDistinctContent(
    input.appMap.discoveredRoutes,
  );
  const assertTargetText = (action: ActionCatalog["actions"][number]) =>
    (
      (action.preferredLocator.strategy === "text"
        ? action.preferredLocator.value
        : action.preferredLocator.name) ?? ""
    ).trim();
  const isRouteDistinctAssert = (action: ActionCatalog["actions"][number]) =>
    action.kind === "assert" &&
    (distinctContentByRoute.get(action.route) ?? []).includes(
      assertTargetText(action),
    );
  for (const feature of input.flowSpec.features) {
    const selectedActions: ActionCatalog["actions"] = [];
    const selectedActionKinds = new Set<
      ActionCatalog["actions"][number]["kind"]
    >();
    const preparedFeature = preparedFeaturesById.get(feature.featureId);
    if (preparedFeature === undefined) {
      throw new Error(
        `FlowSpec references unknown prepared feature ${feature.featureId}`,
      );
    }
    if (
      normalizeFeature(feature.label) !==
      normalizeFeature(preparedFeature.label)
    ) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} must preserve its prepared display label`,
      );
    }
    if (
      feature.requestedFeature !== undefined &&
      normalizeFeature(feature.requestedFeature) !==
        normalizeFeature(preparedFeature.requestedFeature ?? "")
    ) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} does not preserve its requested feature label`,
      );
    }
    for (const route of feature.referencedAppMapRoutePaths) {
      if (!observedRoutes.has(route)) {
        throw new Error(`FlowSpec references unknown AppMap route ${route}`);
      }
      if (
        authWallRoutes.has(route) &&
        !isExplicitAuthenticationFeature(
          preparedFeature,
          input.demoBrief.keyProductFeatures ?? [],
        )
      ) {
        throw new Error(
          `FlowSpec feature ${feature.featureId} cannot use auth wall route ${route}; authentication must be completed off camera`,
        );
      }
    }
    for (const actionId of feature.referencedActionIds) {
      const action = actionsById.get(actionId);
      if (action === undefined) {
        throw new Error(
          `FlowSpec references unknown ActionCatalog action ${actionId}`,
        );
      }
      if (!feature.referencedAppMapRoutePaths.includes(action.route)) {
        throw new Error(
          `FlowSpec action ${actionId} belongs to unselected route ${action.route}`,
        );
      }
      if (!action.featureIds?.includes(feature.featureId)) {
        throw new Error(
          `FlowSpec action ${actionId} is not grounded for feature ${feature.featureId}`,
        );
      }
      selectedActions.push(action);
      selectedActionKinds.add(action.kind);
    }
    const exercisedActions = input.actionCatalog.actions.filter(
      (action) =>
        action.exercised === true &&
        action.featureIds?.includes(feature.featureId),
    );
    if (!selectedActionKinds.has("assert")) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} must select both an interaction and visible assertion from ActionCatalog`,
      );
    }
    // Chrome-only asserts pass on a page that renders nothing: when the
    // catalog offers an assert on route-distinct content for this feature,
    // the FlowSpec must use one. Enforced only when satisfiable, so the
    // planning retry loop can never wedge on an evidence-poor catalog.
    const qualifyingAsserts = input.actionCatalog.actions.filter(
      (action) =>
        action.featureIds?.includes(feature.featureId) &&
        isRouteDistinctAssert(action),
    );
    if (
      qualifyingAsserts.length > 0 &&
      !selectedActions.some(isRouteDistinctAssert)
    ) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} asserts only globally-repeated navigation text. Select an assert targeting route-distinct visible content; qualifying ActionCatalog asserts: ${qualifyingAsserts
          .slice(0, 3)
          .map((action) => `${action.id} ("${assertTargetText(action)}")`)
          .join(", ")}`,
      );
    }
    if (exercisedActions.length > 0) {
      if (!selectedActions.some(({ exercised }) => exercised === true)) {
        throw new Error(
          `FlowSpec feature ${feature.featureId} must select a browser-exercised interaction when one is available`,
        );
      }
    } else if (!selectedActionKinds.has("navigate")) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} must select both an interaction and visible assertion from ActionCatalog`,
      );
    }
  }
  const actionReferenceCounts = new Map<string, number>();
  for (const feature of input.flowSpec.features) {
    for (const actionId of new Set(feature.referencedActionIds)) {
      actionReferenceCounts.set(
        actionId,
        (actionReferenceCounts.get(actionId) ?? 0) + 1,
      );
    }
  }
  for (const feature of input.flowSpec.features) {
    if (
      !feature.referencedActionIds.some(
        (actionId) => actionReferenceCounts.get(actionId) === 1,
      )
    ) {
      throw new Error(
        `FlowSpec feature ${feature.featureId} must include unique ActionCatalog evidence that distinguishes it from the other selected features`,
      );
    }
  }

  const requestedFeatures = input.demoBrief.keyProductFeatures ?? [];
  if (requestedFeatures.length > 0) {
    assertExactRequestedFeatureCoverage(
      requestedFeatures,
      input.flowSpec.features.map(
        (feature) =>
          feature.requestedFeature ?? `unrequested feature ${feature.label}`,
      ),
    );
  } else {
    const expectedFeatureCount = Math.min(
      3,
      input.preparationManifest.productContext.featureInventory.length,
    );
    if (input.flowSpec.features.length !== expectedFeatureCount) {
      throw new Error(
        `FlowSpec must select exactly ${expectedFeatureCount} grounded features when the maker supplied no feature list`,
      );
    }
    if (
      input.flowSpec.features.some(
        (feature) => feature.requestedFeature !== undefined,
      )
    ) {
      throw new Error(
        "Inferred FlowSpec features must not claim a maker-requested feature",
      );
    }
  }
}

function assertExactRequestedFeatureCoverage(
  requestedFeatures: string[],
  coveredFeatures: string[],
): void {
  const requested = countNormalizedFeatures(requestedFeatures);
  const covered = countNormalizedFeatures(coveredFeatures);
  const missing = readFeatureCountDifference(requested, covered);
  const unexpected = readFeatureCountDifference(covered, requested);
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  throw new Error(
    [
      "FlowSpec must cover every requested demo feature exactly once.",
      ...(missing.length === 0 ? [] : [`Missing: ${missing.join(", ")}.`]),
      ...(unexpected.length === 0
        ? []
        : [`Unexpected: ${unexpected.join(", ")}.`]),
    ].join(" "),
  );
}

function countNormalizedFeatures(features: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const normalized = normalizeFeature(feature);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function normalizeFeature(feature: string): string {
  return feature.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function readFeatureCountDifference(
  left: Map<string, number>,
  right: Map<string, number>,
): string[] {
  const difference: string[] = [];
  for (const [feature, leftCount] of left) {
    const missingCount = Math.max(0, leftCount - (right.get(feature) ?? 0));
    difference.push(...Array.from({ length: missingCount }, () => feature));
  }
  return difference;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readWorkspaceContentSnapshot(
  workspace: AgentHarnessWorkspace,
  options: { includeMakeADemoArtifacts?: boolean } = {},
): Promise<ScriptWritingContentSnapshot> {
  const result = await workspace.execute(
    `bash -lc ${shellQuote(
      [
        "fingerprint_file() {",
        '  path="$1"',
        '  if test -L "$path"; then fingerprint="link:$(readlink -- "$path")"',
        '  elif test -f "$path"; then fingerprint="file:$(sha256sum -- "$path" | cut -d " " -f 1)"',
        '  else fingerprint="missing"',
        "  fi",
        '  printf "%s\\0%s\\0" "$path" "$fingerprint"',
        "}",
        `cd ${shellQuote(workspaceRepoDirectory)}`,
        'git ls-files -co -z -x node_modules -x .pnpm-store -x .yarn -x .npm -x .bun -x .turbo -x .cache | while IFS= read -r -d "" relative; do fingerprint_file "$PWD/$relative"; done',
        ...(options.includeMakeADemoArtifacts === false
          ? []
          : [
              `if test -d ${shellQuote(makeADemoDirectory)}; then find ${shellQuote(makeADemoDirectory)} \\( -type f -o -type l \\) -print0 | sort -z | while IFS= read -r -d "" path; do fingerprint_file "$path"; done; fi`,
            ]),
      ].join("\n"),
    )}`,
    { timeoutMs: preparationDiffCommandTimeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fingerprint Script Writing workspace: ${result.stderr || result.stdout}`,
    );
  }

  const values = result.stdout.split("\0");
  if (values.at(-1) === "") {
    values.pop();
  }
  if (values.length % 2 !== 0) {
    throw new Error(
      "Script Writing workspace fingerprint output was malformed.",
    );
  }
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const path = values[index];
    const fingerprint = values[index + 1];
    if (
      path === undefined ||
      fingerprint === undefined ||
      (!path.startsWith(`${workspaceRepoDirectory}/`) &&
        !path.startsWith(`${makeADemoDirectory}/`))
    ) {
      throw new Error(
        "Script Writing workspace fingerprint output was unsafe.",
      );
    }
    snapshot[path] = fingerprint;
  }
  return snapshot;
}

async function readPreparationWorkspaceDiff(
  workspace: AgentHarnessWorkspace,
): Promise<{
  changedFileSha256: Record<string, `sha256:${string}` | null>;
  changedPaths: string[];
  patch: string;
}> {
  const result = await workspace.execute(
    `bash -lc ${shellQuote(
      [
        `cd ${shellQuote(workspaceRepoDirectory)}`,
        "temporary_index=$(mktemp)",
        "changed_paths=$(mktemp)",
        'rm -f "$temporary_index"',
        'cleanup_index() { rm -f "$temporary_index" "$changed_paths"; }',
        "trap cleanup_index EXIT",
        'GIT_INDEX_FILE="$temporary_index" git read-tree HEAD',
        'GIT_INDEX_FILE="$temporary_index" git add -A',
        'GIT_INDEX_FILE="$temporary_index" git ls-files -o -i --exclude-standard -z | grep -zEv "(^|/)(node_modules|\\.pnpm-store|\\.yarn|\\.npm|\\.bun|\\.turbo|\\.cache)(/|$)" | GIT_INDEX_FILE="$temporary_index" xargs -0 -r git add -f --',
        'GIT_INDEX_FILE="$temporary_index" git diff --cached --name-only -z HEAD > "$changed_paths"',
        'cat "$changed_paths"',
        "printf '\\0MAKEADEMO_HASHES\\0'",
        'while IFS= read -r -d "" path; do printf "%s\\0" "$path"; if [ -L "$path" ]; then digest="sha256:$(readlink -z -- "$path" | sha256sum | cut -d " " -f 1)"; elif [ -f "$path" ]; then digest="sha256:$(sha256sum -- "$path" | cut -d " " -f 1)"; else digest=deleted; fi; printf "%s\\0" "$digest"; done < "$changed_paths"',
        "printf '\\0MAKEADEMO_PATCH\\0'",
        'GIT_INDEX_FILE="$temporary_index" git diff --cached --binary --full-index HEAD',
      ].join(" && "),
    )}`,
    { timeoutMs: preparationDiffCommandTimeoutMs },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to capture prepared workspace diff: ${result.stderr || result.stdout}`,
    );
  }
  const hashMarkerIndex = result.stdout.indexOf(preparationHashMarker);
  const markerIndex = result.stdout.indexOf(preparationPatchMarker);
  if (
    hashMarkerIndex === -1 ||
    markerIndex === -1 ||
    hashMarkerIndex > markerIndex
  ) {
    throw new Error("Prepared workspace diff output was malformed.");
  }
  const relativePaths = result.stdout
    .slice(0, hashMarkerIndex)
    .split("\0")
    .filter((path) => path.length > 0);
  if (
    relativePaths.some(
      (path) => path.startsWith("/") || path.split("/").includes(".."),
    )
  ) {
    throw new Error("Prepared workspace diff contained an unsafe path.");
  }
  const hashFields = result.stdout
    .slice(hashMarkerIndex + preparationHashMarker.length, markerIndex)
    .split("\0")
    .filter((field) => field.length > 0);
  if (hashFields.length !== relativePaths.length * 2) {
    throw new Error("Prepared workspace file digest output was malformed.");
  }
  const changedFileSha256: Array<readonly [string, `sha256:${string}` | null]> =
    [];
  for (let index = 0; index < hashFields.length; index += 2) {
    const path = hashFields[index];
    const digest = hashFields[index + 1];
    if (
      path === undefined ||
      digest === undefined ||
      !relativePaths.includes(path) ||
      (digest !== "deleted" && !/^sha256:[0-9a-f]{64}$/.test(digest))
    ) {
      throw new Error("Prepared workspace file digest output was malformed.");
    }
    changedFileSha256.push([
      path,
      digest === "deleted" ? null : (digest as `sha256:${string}`),
    ]);
  }
  return {
    changedFileSha256: Object.fromEntries(changedFileSha256),
    changedPaths: relativePaths.map(
      (path) => `${workspaceRepoDirectory}/${path}`,
    ),
    patch: result.stdout.slice(markerIndex + preparationPatchMarker.length),
  };
}

function createPreparationDiffOperationError(error: unknown): Error {
  const detail = readUnknownErrorMessage(error);
  return new Error(`Preparation workspace patch capture failed: ${detail}`, {
    cause: error,
  });
}

function readUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeWorkspaceJson(
  workspace: AgentHarnessWorkspace,
  path: string,
  value: unknown,
): Promise<void> {
  await writeWorkspaceText(workspace, path, JSON.stringify(value, null, 2));
}

async function removeWorkspaceFile(
  workspace: AgentHarnessWorkspace,
  path: string,
): Promise<void> {
  const result = await workspace.execute(`rm -f ${shellQuote(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove stale workspace artifact ${path}: ${result.stderr || result.stdout}`,
    );
  }
}

async function writeWorkspaceText(
  workspace: AgentHarnessWorkspace,
  path: string,
  value: string,
): Promise<void> {
  const contents = `${value}\n`;
  const payloadBytes = Buffer.byteLength(contents);
  if (workspace.writeTextFile !== undefined) {
    try {
      await workspace.writeTextFile(path, contents);
      return;
    } catch (error) {
      throw new Error(
        `Failed to write workspace artifact ${path} through filesystem transfer (${payloadBytes} bytes): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const command = `sh -lc ${shellQuote(
    `mkdir -p ${shellQuote(makeADemoDirectory)} && printf '%s' ${shellQuote(
      contents,
    )} > ${shellQuote(path)}`,
  )}`;
  const commandBytes = Buffer.byteLength(command);
  if (commandBytes > maxShellArtifactWriteBytes) {
    throw new Error(
      `Cannot write workspace artifact ${path}: workspace has no filesystem transfer seam and the ${payloadBytes}-byte payload produces a ${commandBytes}-byte shell command, exceeding the ${maxShellArtifactWriteBytes}-byte compatibility limit.`,
    );
  }
  const result = await workspace.execute(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write workspace artifact ${path} through shell fallback (${payloadBytes} bytes, exit code ${result.exitCode}). stderr: ${result.stderr || "(empty)"} stdout: ${result.stdout || "(empty)"}`,
    );
  }
}

async function writeScriptContracts(
  workspace: AgentHarnessWorkspace,
  trustedStaticImageAssetIds: readonly string[],
): Promise<void> {
  await writeWorkspaceJson(
    workspace,
    artifactPaths.captureSdkContract,
    createCaptureSdkAgentContract(),
  );
  await writeWorkspaceJson(
    workspace,
    artifactPaths.demoScriptContract,
    createDemoScriptContract({ trustedStaticImageAssetIds }),
  );
}

type WorkspaceJsonReadResult =
  | { candidateFingerprint: string; ok: true; value: unknown }
  | {
      candidateFingerprint?: string;
      error: string;
      failureClassification: "invalid-json" | "missing";
      ok: false;
      rawCandidate?: string;
      syntaxDiagnostic?: JsonSyntaxDiagnostic;
    };

type PreparationManifestReadResult =
  | {
      candidate: unknown;
      candidateFingerprint: string;
      manifest: PreparationManifest;
      ok: true;
    }
  | {
      candidate?: unknown;
      candidateFingerprint?: string;
      error: string;
      failureClassification:
        | "agent-command"
        | "invalid-json"
        | "invalid-schema"
        | "missing"
        | "unchanged";
      ok: false;
      rawCandidate?: string;
      syntaxDiagnostic?: JsonSyntaxDiagnostic;
      syntaxEvidencePath?: string;
    };

async function tryReadWorkspaceJson(
  workspace: AgentHarnessWorkspace,
  path: string,
): Promise<WorkspaceJsonReadResult> {
  const result = await workspace.execute(`cat ${shellQuote(path)}`);
  if (result.exitCode !== 0) {
    return {
      error:
        [result.stderr.trim(), result.stdout.trim()]
          .filter(Boolean)
          .join("\n") || `cat exited with code ${result.exitCode}`,
      failureClassification: "missing",
      ok: false,
    };
  }

  try {
    return {
      candidateFingerprint: fingerprintArtifactText(result.stdout),
      ok: true,
      value: JSON.parse(result.stdout),
    };
  } catch (error) {
    const syntaxDiagnostic = diagnoseJsonSyntax(result.stdout, error);
    return {
      candidateFingerprint: fingerprintArtifactText(result.stdout),
      error: `Invalid JSON in ${path}: ${syntaxDiagnostic.message} at line ${syntaxDiagnostic.line}, column ${syntaxDiagnostic.column} (offset ${syntaxDiagnostic.offset})`,
      failureClassification: "invalid-json",
      ok: false,
      rawCandidate: result.stdout,
      syntaxDiagnostic,
    };
  }
}

async function tryReadPreparationManifest(
  workspace: AgentHarnessWorkspace,
  path: string,
  featureValidation?: {
    demoBrief: AgentHarnessPipelineInput["demoBrief"];
    repoProfile: RepoProfile;
    repoSourcePaths: string[];
    runPlan: RunPlan;
  },
): Promise<PreparationManifestReadResult> {
  let json = await tryReadWorkspaceJson(workspace, path);
  if (!json.ok && path === artifactPaths.preparationManifest) {
    const misplaced = await tryReadWorkspaceJson(
      workspace,
      misplacedPreparationManifestPath,
    );
    if (misplaced.ok) {
      await writeWorkspaceJson(workspace, path, misplaced.value);
      await workspace.execute(
        `rm -f ${shellQuote(misplacedPreparationManifestPath)}`,
      );
      json = misplaced;
    }
  }
  if (!json.ok) {
    return json;
  }

  try {
    const manifest = readPreparationManifest(json.value);
    if (featureValidation !== undefined) {
      assertPreparedFeatureInventory({
        demoBrief: featureValidation.demoBrief,
        preparationManifest: manifest,
        repoProfile: featureValidation.repoProfile,
        repoSourcePaths: new Set(featureValidation.repoSourcePaths),
        runPlan: featureValidation.runPlan,
      });
    }
    return {
      candidate: json.value,
      candidateFingerprint: json.candidateFingerprint,
      manifest,
      ok: true,
    };
  } catch (error) {
    return {
      candidate: json.value,
      candidateFingerprint: json.candidateFingerprint,
      error: `Invalid PreparationManifest in ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      failureClassification: "invalid-schema",
      ok: false,
    };
  }
}

/**
 * Exploration screenshots and aria snapshots exist only inside the sandbox
 * and are destroyed with it, yet on a failed exploration they are the
 * evidence that explains blank or ungrounded routes. Mirroring them is
 * best-effort: evidence transfer must never turn a diagnosable pipeline
 * failure into an infrastructure error.
 */
async function persistExplorationEvidence(input: {
  logger: PipelineEventLogger | undefined;
  outputRoot: string;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  const localDirectory = join(input.outputRoot, "exploration-evidence");
  try {
    await downloadSubmittedCodeArchive({
      archiveName: "exploration-evidence.tar",
      compression: "none",
      entries: ["exploration"],
      localDirectory,
      remoteDirectory: makeADemoDirectory,
      workspace: input.workspace,
    });
    await input.logger?.info({
      event: "exploration.evidence.persisted",
      path: localDirectory,
    });
  } catch (error) {
    await input.logger?.warn({
      error: readUnknownErrorMessage(error),
      event: "exploration.evidence.unavailable",
    });
  }
}

async function persistAgentArtifactAttempt(input: {
  artifactStore: DefaultHarnessDependenciesOptions["artifactStore"];
  attempt: number;
  result: PreparationManifestReadResult;
  route: string;
  sessionId: string | undefined;
}): Promise<void> {
  await input.artifactStore.writeJson(
    `${artifactPaths.agentArtifactAttempts}/${input.route}/attempt-${input.attempt}.json`,
    {
      attempt: input.attempt,
      ...(input.result.candidate === undefined
        ? {}
        : { candidate: redactArtifactCandidate(input.result.candidate) }),
      ...(input.result.candidateFingerprint === undefined
        ? {}
        : { candidateFingerprint: input.result.candidateFingerprint }),
      ...(input.result.ok ? {} : { error: input.result.error }),
      ...(input.result.ok
        ? {}
        : { failureClassification: input.result.failureClassification }),
      route: input.route,
      ...(input.sessionId === undefined
        ? {}
        : { opencodeSessionId: input.sessionId }),
      status: input.result.ok ? "passed" : "failed",
      ...(!input.result.ok && input.result.syntaxDiagnostic !== undefined
        ? { syntaxDiagnostic: input.result.syntaxDiagnostic }
        : {}),
      ...(!input.result.ok && input.result.syntaxEvidencePath !== undefined
        ? { syntaxEvidencePath: input.result.syntaxEvidencePath }
        : {}),
    },
  );
}

function formatPreparationManifestReadError(
  result: Exclude<PreparationManifestReadResult, { ok: true }>,
): string {
  if (result.syntaxEvidencePath === undefined) {
    return result.error;
  }
  return [
    result.error,
    `The malformed candidate is preserved at ${result.syntaxEvidencePath}.`,
    `The canonical manifest was reset from ${artifactPaths.preparationManifestTemplate}; rebuild it there using useful values from the preserved candidate.`,
  ].join("\n");
}

function redactArtifactCandidate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactArtifactCandidate);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(api[_-]?key|authorization|password|secret|token)/i.test(key)
        ? "[Redacted]"
        : redactArtifactCandidate(entry),
    ]),
  );
}

async function writeAgentArtifactValidationLog(input: {
  attempt: number;
  logger: PipelineEventLogger | undefined;
  result: PreparationManifestReadResult;
  route: string;
  sessionId: string | undefined;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  const level = input.result.ok ? "info" : "error";
  const entry = {
    attempt: input.attempt,
    event: input.result.ok
      ? "agent.artifact.validation.succeeded"
      : "agent.artifact.validation.failed",
    ...(input.result.ok ? {} : { error: input.result.error }),
    message: `${input.route} artifact validation ${input.result.ok ? "succeeded" : "failed"}.`,
    ...(input.sessionId === undefined
      ? {}
      : { opencodeSessionId: input.sessionId }),
    stage: input.route,
  };
  await input.logger?.[level](entry);
  await writeSandboxLogBestEffort({
    entry: {
      ...entry,
      source: "agent-harness",
      timestamp: new Date().toISOString(),
    },
    logger: input.logger,
    workspace: input.workspace,
  });
}

function validationReport(input: {
  attemptedCommand?: string;
  blockedNetworkAttempts?: ValidationReport["blockedNetworkAttempts"];
  exitCode?: number;
  failureClassification?: string;
  logsSummary: string;
  networkAttempts?: ValidationReport["networkAttempts"];
  runtimeProbe?: RuntimeProbeDiagnostics;
  stage: string;
  status?: "failed" | "passed";
  stderrExcerpts?: string[];
  stdoutExcerpts?: string[];
  suggestedRepairHints?: string[];
  urlChecked?: string;
}): ValidationReport {
  return {
    artifactReferences: [],
    blockedNetworkAttempts: input.blockedNetworkAttempts ?? [],
    browserObservations: [],
    consoleErrors: [],
    failureClassification:
      input.failureClassification ??
      (input.status === "failed" ? "harness/internal failure" : "none"),
    logsSummary: input.logsSummary,
    networkAttempts: input.networkAttempts ?? [],
    pageErrors: [],
    retryCount: 0,
    ...(input.runtimeProbe === undefined
      ? {}
      : { runtimeProbe: input.runtimeProbe }),
    screenshots: [],
    stage: input.stage,
    status: input.status ?? "passed",
    stderrExcerpts: input.stderrExcerpts ?? [],
    stdoutExcerpts: input.stdoutExcerpts ?? [],
    suggestedRepairHints: input.suggestedRepairHints ?? [],
    ...(input.attemptedCommand === undefined
      ? {}
      : { attemptedCommand: input.attemptedCommand }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.urlChecked === undefined ? {} : { urlChecked: input.urlChecked }),
  };
}

function createScriptCandidate(input: {
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  demoScript: unknown;
  flowSpec: FlowSpec;
  preparationManifest: PreparationManifest;
  trustedStaticImageAssetIds: readonly string[];
}): ScriptCandidate {
  let scriptJsonContent = input.demoScript;
  try {
    scriptJsonContent = assembleDemoNarrative({
      draft: input.demoScript,
      flowSpec: input.flowSpec,
      productName: input.preparationManifest.productContext.name,
    });
  } catch {
    // Preserve the original candidate so static validation can return a typed
    // repair report for malformed or ungrounded agent output.
  }
  const candidate = {
    assumptions: [],
    browserActionCompilerVersion: BROWSER_ACTION_COMPILER_VERSION,
    bunRuntimeVersion: BUN_RUNTIME_VERSION,
    captureSdkVersion: CAPTURE_SDK_CONTRACT_VERSION,
    conformanceResult: validationReport({
      logsSummary: "Pending static Demo Script contract validation.",
      stage: "static-script-contract-validation",
      urlChecked: input.preparationManifest.baseUrl,
    }),
    contractVersion: DEMO_SCRIPT_CONTRACT_VERSION,
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    playwrightRuntimeVersion: PLAYWRIGHT_RUNTIME_VERSION,
    scriptJsonContent,
    sourceAppMapId: input.appMap.id,
    sourceFlowSpecId: input.flowSpec.id,
    sourcePreparationManifestId: input.preparationManifest.id,
    unsupportedPieces: [],
    validationArtifacts: [],
  } satisfies ScriptCandidate;
  return {
    ...candidate,
    conformanceResult: validateDemoScriptCandidateContract({
      actionCatalog: input.actionCatalog,
      flowSpec: input.flowSpec,
      preparationManifest: input.preparationManifest,
      requireCanonicalNarrative: true,
      scriptCandidate: candidate,
      trustedStaticImageAssetIds: input.trustedStaticImageAssetIds,
    }),
  };
}

function failedPreparationValidation(input: {
  attemptedCommand?: string;
  blockedNetworkAttempts?: NetworkAttempt[];
  classification: string;
  exitCode?: number;
  logsSummary: string;
  manifest: PreparationManifest;
  stage: string;
  stderr?: string;
  stdout?: string;
  suggestedRepairHints?: string[];
}): ValidationReport {
  return validationReport({
    ...(input.attemptedCommand === undefined
      ? {}
      : { attemptedCommand: input.attemptedCommand }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    blockedNetworkAttempts: input.blockedNetworkAttempts ?? [],
    failureClassification: input.classification,
    logsSummary: input.logsSummary,
    stage: input.stage,
    status: "failed",
    networkAttempts: input.blockedNetworkAttempts ?? [],
    stderrExcerpts: input.stderr ? [input.stderr.slice(-500)] : [],
    stdoutExcerpts: input.stdout ? [input.stdout.slice(-500)] : [],
    ...(input.suggestedRepairHints === undefined
      ? {}
      : { suggestedRepairHints: input.suggestedRepairHints }),
    urlChecked: input.manifest.baseUrl,
  });
}

/**
 * Extracts the unreachable host (and the package when the package manager
 * names it) from a network-signature install failure that already survived
 * the gate's in-window retry, so the repair prompt can pin a registry-hosted
 * version or vendor the dependency instead of retrying an unreachable URL.
 */
function readUnreachableDependencyHost(result: {
  stderr: string;
  stdout: string;
}): { host: string; packageName?: string } | undefined {
  if (!hasNetworkInstallFailureSignature({ ...result, exitCode: 1 })) {
    return undefined;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  const tarball = /tarball ([^@\s]+)@(https?:\/\/[^\s"'`]+)/.exec(output);
  const url = tarball?.[2] ?? /https?:\/\/[^\s"'`]+/.exec(output)?.[0];
  if (url === undefined) {
    return undefined;
  }
  try {
    return {
      host: new URL(url).host,
      ...(tarball?.[1] === undefined ? {} : { packageName: tarball[1] }),
    };
  } catch {
    return undefined;
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readErrorDiagnostic(error: unknown): {
  details: string[];
  summary: string;
} {
  if (!(error instanceof Error)) {
    const summary = String(error);
    return { details: [summary], summary };
  }
  const summary = `${error.name}: ${error.message}`;
  return {
    details: [summary, ...(error.stack === undefined ? [] : [error.stack])],
    summary,
  };
}

function optionalSessionId(sessionId: string | undefined) {
  return sessionId === undefined ? {} : { sessionId };
}

function attachOpenCodeSession(
  error: Error,
  sessionId: string | undefined,
): Error & { opencodeSessionId?: string } {
  return sessionId === undefined
    ? error
    : Object.assign(error, { opencodeSessionId: sessionId });
}

function formatOpenCodeArtifactContractError(input: {
  path: string;
  readError: string;
  result: { stderr: string; stdout: string };
  stage: string;
}): string {
  return [
    `${input.stage} did not produce valid required artifact ${input.path}.`,
    `Artifact validation error: ${input.readError}`,
    `OpenCode output excerpt:\n${formatOpenCodeOutputExcerpt(input.result)}`,
  ].join("\n");
}

// Callers must invoke this only when the required artifact was NOT readable:
// a readable artifact that merely failed validation proves the denial did not
// cause the failure, and throwing would suppress the repairable error
// (2026-08-03 homer run).
function throwIfRequiredArtifactWriteWasDenied(input: {
  artifactError: string;
  path: string;
  result: Pick<OpenCodeHarnessRunResult, "stderr" | "stdout">;
  stage: string;
}): void {
  const artifactName = input.path.slice(input.path.lastIndexOf("/") + 1);
  const denialPattern =
    /(?:write|create|edit)[^\n]{0,120}(?:blocked|denied)[^\n]{0,120}permission|(?:blocked|denied)[^\n]{0,120}(?:permission|write|creation)|specified a rule which prevents you from using this specific tool call/i;
  // OpenCode reports a denied tool call and its arguments on one event line,
  // so the denial line itself names the file it concerns. A denial about some
  // other path is agent noise a retry can route around — reporting it as a
  // harness configuration failure would suppress the real validation error.
  const deniedLine = `${input.result.stderr}\n${input.result.stdout}`
    .split("\n")
    .find(
      (line) =>
        (line.includes(input.path) || line.includes(artifactName)) &&
        denialPattern.test(line),
    );
  if (deniedLine !== undefined) {
    throw new Error(
      `${input.stage} harness configuration failure: required artifact write was denied for ${input.path}. Denied call: ${redactSecretText(deniedLine.trim().slice(0, 240))} Last artifact error: ${input.artifactError}`,
    );
  }
}

/** Bounded, redacted agent-facing summary of a failed OpenCode command. */
function formatAgentCommandFailure(result: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): string {
  return `OpenCode exited with code ${result.exitCode}: ${redactSecretText(
    tail(result.stderr || result.stdout, 2000),
  )}`;
}

function formatOpenCodeOutputExcerpt(result: {
  stderr: string;
  stdout: string;
}): string {
  const parts = [
    result.stderr.trim().length === 0
      ? ""
      : `stderr:\n${redactSecretText(tail(result.stderr, 2000))}`,
    result.stdout.trim().length === 0
      ? ""
      : `stdout:\n${redactSecretText(tail(result.stdout, 2000))}`,
  ].filter(Boolean);
  return parts.length === 0 ? "(no OpenCode output)" : parts.join("\n");
}

function tail(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(-maxLength) : trimmed;
}

function requireWorkspace(
  handle: AgentHarnessWorkspaceHandle | undefined,
): AgentHarnessWorkspace {
  return requireWorkspaceHandle(handle).workspace;
}

function requireWorkspaceHandle(
  handle: AgentHarnessWorkspaceHandle | undefined,
): AgentHarnessWorkspaceHandle {
  if (handle === undefined) {
    throw new Error("Daytona workspace has not been created.");
  }
  return handle;
}

function createRuntimeTargetSelectionContract(repoProfile: RepoProfile) {
  return {
    candidates: (repoProfile.browserRuntimeCandidates ?? []).map(
      ({ dir, evidencePaths }) => ({ evidencePaths, targetId: dir }),
    ),
    output: {
      candidates: [
        {
          evidencePaths: ["screened evidence path from the candidate"],
          reason: "source-backed classification reason",
          role: "admin | docs | marketing | product | showcase | unknown",
          targetId: "candidate targetId",
        },
      ],
      reason: "selection or ambiguity reason",
      selectedTargetId: "candidate targetId, or null when ambiguous",
    },
  };
}

function createRuntimeTargetSelectionPrompt(previousError?: string): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.repoProfile,
      artifactPaths.demoBrief,
      artifactPaths.supportingDocuments,
      artifactPaths.runtimeTargetSelectionContract,
      artifactPaths.runtimeTargetSelection,
    ],
    instructions: [
      "Inspect /workspace/repo and classify every runnable browser application listed in the contract.",
      "Select the application that contains the actual user-facing product and best covers the demo brief. Marketing, documentation, component-showcase, and product applications are distinct roles; a difficult authentication or data dependency is not evidence that a marketing sibling is the product.",
      "Use maker-provided supporting documents when present to disambiguate the intended product or feature set.",
      "Assess every candidate exactly once and cite only evidencePaths allowed for that candidate by the contract.",
      "If the source evidence and demo brief do not distinguish one intended application, set selectedTargetId to null and explain the ambiguity. Never choose by candidate order.",
      "This stage is read-only. Do not modify anything under /workspace/repo.",
      "Write only the completed JSON decision to /workspace/.makeademo/runtime-target-selection.json. After writing it, do not call another tool.",
      ...(previousError === undefined
        ? []
        : [`Repair this previous artifact error: ${previousError}`]),
    ].join("\n"),
    stage: "runtime-target-selection",
  });
}

const offCameraAuthenticationInstruction =
  "For a feature blocked by authentication, keep the normal path unchanged when demo mode is off and conditionally select the narrowest existing identity, session, middleware, or route seam with MAKEADEMO_DEMO=true (or only a framework-required public prefix) recorded in envUsed. Read the flag directly or once through a small shared helper, and use that source-backed gate in every modified auth or integration file. The demo path must supply the complete non-null user, session, claims, and organization/team/tenant context consumed downstream; returning null is not a bypass. Record the secret-free strategy in authStrategy and authBypassOrDemoIdentity; never depend on credentials or OAuth, change rendered markup or styling, or show authentication unless an exact keyProductFeature requests it.";

const offlineFeatureStateInstruction =
  "Follow every selected feature beyond authentication through its API, RPC, GraphQL, client, repository, database, and service calls. Add deterministic local adapters or fixtures at existing seams, conditionally select them with the same source-backed demo gate, and retain the normal adapter when it is off; a feature that still requires an external API or database is not prepared under Runtime Network Lockdown. Server-side demo adapters must invoke fixtures or local service code directly, never send HTTP back through the prepared app's own baseUrl or listening port; browser clients may use relative same-origin routes only in code that never executes during server-side rendering — a data-fetching layer shared with SSR cannot fetch a relative URL, so gate it to run client-side only or invoke the fixture module directly on the server — and a truly separate local service must use its own declared port.";

function createRepoPreparationPrompt(input: {
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
  repoProfile: RepoProfile;
  runPlan: RunPlan;
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.repoProfile,
      artifactPaths.runPlan,
      artifactPaths.demoBrief,
      artifactPaths.supportingDocuments,
      artifactPaths.preparationManifestContract,
      artifactPaths.preparationManifestTemplate,
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Prepare the cloned app in /workspace/repo for a local MakeADemo run.",
      "Before editing, inspect the README and package metadata, then use route definitions to follow only the page components, state/API layers, authentication guards, and fixtures needed for browser-demonstrable flows.",
      `The RunPlan has locked the demo to ${input.runPlan.appDir}. Prepare only that browser application and its internal dependencies; never substitute a marketing, docs, showcase, or other runnable sibling. appDir must remain ${input.runPlan.appDir}.`,
      "You may modify app files in /workspace/repo only when needed to make a deterministic local demo mode.",
      "Preserve the original product: captured routes must continue to use its existing route tree, UI components, design system, styles, brand assets, and interaction logic. Do not create an alternate frontend, standalone demo server, replacement page, or copied approximation of the product.",
      "Make demo changes at integration seams only: authentication/session providers, API or data adapters, external-service clients, fixtures, seed state, environment/configuration, and locally vendored copies of existing remote assets. Mock the data behind the original screen, never the screen itself.",
      "Do not remove workspace configuration, replace the package graph or lockfile with a smaller demo project, or redirect an app command to a newly authored application entrypoint. Additive package-script or dependency changes are allowed only when they still launch the original app.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      "Use one repo-wide search to inventory browser-reachable external dependencies, including scripts, stylesheets, fonts, icons, images, analytics, API calls, WebSockets, and protocol-relative URLs beginning with //. Preserve original public presentation-resource references because the backend snapshots and replays them locally. Adapt only authenticated/stateful APIs or external services that prevent a requested feature from working offline; never remove or substitute visible product assets merely to silence network attempts.",
      "Do not install dependencies, build, start, or execute submitted application code in the agent sandbox. The backend runs those commands in the secret-free submitted-code sandbox.",
      "Omit buildCommandUsed when the selected start command runs a development server. When a build is required in a monorepo, use the narrowest app-scoped build command and never a root aggregate build that compiles unrelated packages.",
      "Do not add cd, --cwd, --prefix, or --dir to runtime commands. Cite the selected application in feature sourcePaths; the backend owns command working directories and workspace scoping.",
      "Read /workspace/.makeademo/supporting-documents.json when it contains maker-provided context and incorporate relevant setup or demo requirements.",
      "Replace every placeholder in productContext. productContext.name and summary must describe the actual product; evidencePaths and every feature sourcePaths entry must reference original screened repository files that support the claim.",
      "When keyProductFeatures is non-empty, prepare every requested feature exactly once and preserve its exact text in requestedFeature. Make every entryPaths route browser-reachable under local demo mode.",
      "When keyProductFeatures is empty, select and fully prepare up to three strong source-backed browser features. Each selected feature must be reachable with deterministic local authentication and data fixtures where needed; candidate identification alone is not sufficient.",
      offCameraAuthenticationInstruction,
      offlineFeatureStateInstruction,
      "Do not invent core product behavior that is absent from the source. If a requested capability is truly absent, leave concrete evidence in knownLimitations rather than fabricating it.",
      "Every feature sourcePaths list must cite at least one original browser route, page, component, or UI module used by the prepared route. If the original app cannot be prepared through the allowed seams, do not synthesize a substitute product.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "Write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "Read /workspace/.makeademo/preparation-manifest-contract.json first and satisfy the complete contract, including every required field on every featureInventory entry.",
      "Start by copying /workspace/.makeademo/preparation-manifest-template.json; preserve every field type and replace or enrich its values.",
      "Complete all inspection, edits, and checks before the final manifest write. Writing /workspace/.makeademo/preparation-manifest.json is the terminal action: after writing it, do not call another tool; return a concise completion response immediately.",
      "The manifest must include every field required by the backend-owned contract. Changed files and validation evidence are recorded by the backend, not authored in the manifest.",
      'appDir must be relative to /workspace/repo: use "." for the repo root or a path such as "frontend"; never use an absolute path.',
      'envUsed must be a flat JSON object whose keys and values are strings, such as {"NODE_ENV":"development"}; use {} when no environment values are used. Do not put arrays or nested objects under envUsed.',
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
      `Repo profile: ${JSON.stringify(input.repoProfile)}`,
    ].join("\n"),
    stage: "repo-preparation",
  });
}

function createRepoPreparationRepairPrompt(input: {
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
  previousResult: { stderr: string; stdout: string };
  readError: string;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.repoProfile,
      artifactPaths.runPlan,
      artifactPaths.demoBrief,
      artifactPaths.preparationManifestContract,
      artifactPaths.preparationManifestTemplate,
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Repo Preparation completed without producing the required artifact /workspace/.makeademo/preparation-manifest.json.",
      "The artifact may be missing, unreadable, invalid JSON, or schema-invalid.",
      `The RunPlan target is immutable: prepare only ${input.runPlan.appDir}, keep appDir equal to ${input.runPlan.appDir}, and do not use evidence from a runnable sibling application.`,
      `Backend artifact validation failed with: ${input.readError}`,
      "Repair only the Repo Preparation output contract. Inspect /workspace/repo and the durable artifacts, then write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "Read /workspace/.makeademo/preparation-manifest-contract.json and use /workspace/.makeademo/preparation-manifest-template.json as the canonical shape.",
      "Do not patch only the named field. Rebuild and validate every productContext.featureInventory entry against the complete contract before finishing.",
      "Inspect the source paths needed to replace productContext placeholders. Every requested feature must have one source-backed inventory entry and at least one browser entry path; do not solve validation by deleting a requested feature.",
      offCameraAuthenticationInstruction,
      offlineFeatureStateInstruction,
      "Preserve original routes, UI components, styles, brand assets, and interaction logic. Repair only authentication, data, external-service, fixture, seed, asset-vendoring, environment, or configuration seams; never create a replacement app or standalone demo server.",
      "Do not finish until the manifest exists at that exact path.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      "Omit buildCommandUsed for development-server starts. If a monorepo build is required, select an app-scoped package script instead of the root aggregate build.",
      "Do not add command-level working directory flags; workspace command resolution is backend-owned.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "The manifest must include every field required by the backend-owned contract. Changed files and validation evidence are recorded by the backend, not authored in the manifest.",
      'appDir must be relative to /workspace/repo: use "." for the repo root or a path such as "frontend"; never use an absolute path.',
      'envUsed must be a flat JSON object whose keys and values are strings, such as {"NODE_ENV":"development"}; use {} when no environment values are used. Do not put arrays or nested objects under envUsed.',
      `Previous OpenCode output excerpt:\n${formatOpenCodeOutputExcerpt(
        input.previousResult,
      )}`,
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
      `Repo profile: ${JSON.stringify(input.repoProfile)}`,
    ].join("\n"),
    stage: "repo-preparation-repair",
  });
}

function createRuntimePreparationRepairPrompt(input: {
  artifactError?: string;
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
  failureReport: ValidationReport;
  preparationManifest: PreparationManifest;
  repoProfile: RepoProfile;
  runPlan: RunPlan;
}): string {
  const dependencyRepair = isDependencyRepairFailure(
    input.failureReport.failureClassification,
  );
  const rebuildFromScreenedSource =
    input.failureReport.stage === "preparation-fidelity";
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.repoProfile,
      artifactPaths.runPlan,
      artifactPaths.demoBrief,
      artifactPaths.preparationManifestContract,
      artifactPaths.preparationManifestTemplate,
      artifactPaths.preparationManifest,
      validationArtifactPath(input.failureReport.stage),
    ],
    instructions: [
      "Backend-owned submitted-code validation failed. Repair the prepared repo and update the PreparationManifest; do not claim success yourself.",
      `Failure classification: ${input.failureReport.failureClassification ?? "unknown"}`,
      `Failure summary: ${input.failureReport.logsSummary}`,
      `Browser observations: ${JSON.stringify(input.failureReport.browserObservations)}`,
      `Blocked network attempts: ${JSON.stringify(input.failureReport.blockedNetworkAttempts)}`,
      `Console errors: ${JSON.stringify(input.failureReport.consoleErrors)}`,
      `Page errors: ${JSON.stringify(input.failureReport.pageErrors)}`,
      `stderr evidence: ${JSON.stringify(input.failureReport.stderrExcerpts)}`,
      `stdout evidence: ${JSON.stringify(input.failureReport.stdoutExcerpts)}`,
      `Suggested repair hints: ${JSON.stringify(input.failureReport.suggestedRepairHints)}`,
      ...(input.artifactError === undefined
        ? []
        : [
            `The previous repaired manifest was rejected: ${input.artifactError}`,
          ]),
      ...(rebuildFromScreenedSource
        ? [
            "The repository was restored from the immutable screened source and the failed manifest was removed. Rebuild the complete preparation candidate and manifest from this clean baseline; no prior workspace edit remains.",
          ]
        : []),
      "Do not run the app, install dependencies, or use the network. The backend will rerun install, build, start, and browser validation in the isolated submitted-code sandbox.",
      "Omit buildCommandUsed for development-server starts. If validation reports that a root aggregate build is too broad, use the exact app-scoped command from the failure summary.",
      "Preserve backend-resolved appDir, install, build, start, port, and base URL fields unless the failure summary explicitly reports a runtime-configuration error.",
      `The selected browser application remains ${input.runPlan.appDir}; validation difficulty never authorizes switching to a runnable sibling.`,
      ...(dependencyRepair
        ? [
            "Change only package manifests or recognized package-manager configuration required to resolve the reported dependency failure. Do not edit executable source, application scripts, workspace topology, or presentation files.",
            "Do not rewrite the PreparationManifest; the accepted runtime, authentication, fixtures, and Product Context remain authoritative for an install repair.",
          ]
        : []),
      "Do not edit lockfiles (bun.lock, package-lock.json, pnpm-lock.yaml, yarn.lock) in any repair; the backend regenerates and verifies them with the detected package manager after your changes.",
      "Any authentication or integration change must be conditionally selected by the repository's active MAKEADEMO_DEMO gate and must keep the original behavior reachable on the non-demo branch; deleting original behavior fails fidelity validation.",
      "For browser network failures, repair only unresolved URLs in the failure report. The backend already replays safe public GET resources, so preserve original product images, media, fonts, styles, and scripts. Adapt authenticated or stateful APIs at their service/data seams and never substitute visible assets.",
      ...(dependencyRepair
        ? ["Edit only the dependency files under /workspace/repo."]
        : [
            "You may edit /workspace/repo and must rewrite /workspace/.makeademo/preparation-manifest.json to match the actual repaired state.",
          ]),
      "The repaired runtime must still be the original product. Preserve its route tree, UI components, design system, styles, brand assets, and interaction logic; remove alternate demo servers, replacement pages, and commands that bypass the original app.",
      "Repair only authentication/session, data/API, external-service, fixture/seed, local asset, environment, or configuration seams. Do not remove workspace configuration or replace the package graph or lockfile with a smaller demo project.",
      "Preserve every selected productContext feature, including every requested feature, and retain its source evidence and entryPaths.",
      offCameraAuthenticationInstruction,
      offlineFeatureStateInstruction,
      "Read /workspace/.makeademo/preparation-manifest-contract.json and use /workspace/.makeademo/preparation-manifest-template.json as the canonical shape.",
      "Do not patch only the reported failure. Revalidate the complete manifest and every productContext.featureInventory entry before finishing.",
      'appDir must remain relative to /workspace/repo: use "." for the repo root or a path such as "frontend"; never use an absolute path.',
      'envUsed must remain a flat string-to-string object such as {"NODE_ENV":"development","MAKEADEMO_DEMO":"true"}; nested values, arrays, and descriptive objects are invalid.',
      ...(rebuildFromScreenedSource
        ? []
        : [`Current manifest: ${JSON.stringify(input.preparationManifest)}`]),
      `Run plan: ${JSON.stringify(input.runPlan)}`,
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
      `Repo profile: ${JSON.stringify(input.repoProfile)}`,
    ].join("\n"),
    stage: "repo-preparation-repair",
  });
}

function validationArtifactPath(stage: string): string {
  if (stage === "preparation-fidelity") {
    return artifactPaths.preparationFidelity;
  }
  if (stage === "app-exploration") {
    return artifactPaths.appExplorationValidation;
  }
  if (stage === "capture-path-validation") {
    return artifactPaths.capturePathValidation;
  }
  return artifactPaths.preparationPreflight;
}

function createFlowPlanningPrompt(artifactError?: string): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.appMap,
      artifactPaths.actionCatalog,
      artifactPaths.demoBrief,
      artifactPaths.preparationManifest,
      artifactPaths.flowSpecContract,
      artifactPaths.flowSpec,
    ],
    instructions: [
      "Plan one feature-scoped flow entry for every maker-requested feature using PreparationManifest productContext, AppMap, and ActionCatalog evidence.",
      "When the maker supplied requested features, include exactly that normalized set with no omissions or extra feature entries. Duration is a pacing target and never permission to drop a feature.",
      "When the maker supplied no features, select exactly min(3, productContext.featureInventory.length) source-backed features with the strongest browser evidence.",
      "Each feature must use its prepared featureId and only ActionCatalog actions tagged with that featureId.",
      "Preserve each selected feature's prepared display label so backend-owned feature introduction cards remain source-grounded.",
      "For each feature, select a browser-exercised ActionCatalog interaction (exercised=true) and a visible assertion. Navigation does not replace an available exercised interaction. Only when no exercised action exists for a genuinely read-only feature may you use navigation plus a unique visible assertion. At least one selected action must not be reused by another feature.",
      "Read /workspace/.makeademo/flow-spec-contract.json and satisfy every required field, property type, and invariant it defines.",
      "Write a valid FlowSpec JSON object to /workspace/.makeademo/flow-spec.json.",
      "Do not invent alternate field names or object-shaped steps. Every steps entry and every repairConstraints entry must be a string.",
      ...(artifactError === undefined
        ? []
        : [
            `The previous artifact was rejected by the backend: ${artifactError}`,
            "Correct the artifact at the exact path before finishing.",
          ]),
    ].join("\n"),
    stage: "flow-planning",
  });
}

function createScriptWritingPrompt(input: {
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.preparationManifest,
      artifactPaths.appMap,
      artifactPaths.actionCatalog,
      artifactPaths.flowSpec,
      artifactPaths.demoScriptContract,
      artifactPaths.captureSdkContract,
      artifactPaths.demoScript,
    ],
    instructions: [
      "Write the final capture-ready Demo Script JSON.",
      "Read /workspace/.makeademo/demo-script-contract.json before writing. Use the browser Scene portion of its example as the authoring shape; Synthetic Scenes in the final schema are backend-owned. The Capture SDK artifact documents the backend-generated runtime only.",
      "Do not edit app source files. Only write /workspace/.makeademo/demo-script.json.",
      "Do not write demoPlaywrightScript; the backend compiles typed browser actions into versioned Capture SDK and Playwright source.",
      "Write only playwright-recording feature demonstration Scenes. The backend deterministically adds the product intro, one brief feature intro before each feature, and the product outro.",
      "Every browser Scene must include featureId matching exactly one FlowSpec feature. Include at least one browser Scene for every FlowSpec feature and no Scene for an unselected feature.",
      "Every playwright-recording Scene requires typed actions and expectedVisibleOutcome. Each locator action must copy one browser-verified ActionCatalog locator exactly and include its locatorCandidateId; sourceActionId must reference ActionCatalog evidence selected by FlowSpec.",
      "The prepared runtime already owns authentication prerequisites. Use setupActions only for grounded off-camera browser state such as navigation or seeded UI setup. Every setup action must include a sourceActionId grounded in ActionCatalog. Put authentication in a Scene only when FlowSpec explicitly selected it as a maker-requested feature; keep all other product demonstration inside Scene actions.",
      "Do not author full-screen-text or static-image narrative cards; they are backend-owned.",
      "Scene description is optional human-readable metadata.",
      "presentation.music, presentation.textOverlays, and presentation.transitions are optional. When omitted they default to disabled music, no overlays, and direct back-to-back Scene playback.",
      "Each browser Scene must end with assert-visible or assert-text; the compiler emits explicit Playwright visibility proof.",
      "When optional textOverlays or transitions are present, their Scene IDs must match adjacent declared Scenes.",
      `Target demo length seconds: ${input.demoBrief.demoLengthSeconds ?? 30}`,
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
    ].join("\n"),
    stage: "script-writing",
  });
}

function createScriptArtifactRepairPrompt(input: {
  artifactError: string;
  demoBrief: AgentHarnessPipelineInput["demoBrief"];
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.preparationManifest,
      artifactPaths.appMap,
      artifactPaths.actionCatalog,
      artifactPaths.flowSpec,
      artifactPaths.demoScriptContract,
      artifactPaths.captureSdkContract,
      artifactPaths.demoScript,
    ],
    instructions: [
      "The previous Script Writing attempt did not produce readable JSON at /workspace/.makeademo/demo-script.json.",
      "Re-read /workspace/.makeademo/demo-script-contract.json and satisfy its strict JSON Schema. Browser source is backend-compiled from typed setupActions and Scene actions.",
      `Backend artifact error: ${input.artifactError}`,
      "Repair only the Demo Script artifact at that exact path. Do not edit app source or preparation files.",
      "The JSON must include version, scriptId, title, format, scenes, and presentation. Do not add demoPlaywrightScript.",
      "Use only playwright-recording Scenes. Every Scene must carry a FlowSpec featureId, and every FlowSpec feature must retain at least one Scene.",
      "Scene description is optional; do not spend a repair attempt adding one when id and expectedVisibleOutcome are already valid.",
      "presentation.music, presentation.textOverlays, and presentation.transitions may be omitted; the backend supplies safe defaults.",
      "Every playwright-recording Scene must use supported typed actions, an explicit visibility assertion action, sourceActionId references grounded in AppMap, ActionCatalog, and FlowSpec evidence, and locatorCandidateId references for every locator action.",
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
    ].join("\n"),
    stage: "script-repair",
  });
}

function createScriptRepairPrompt(input: {
  artifactError?: string;
  failureReport: ValidationReport;
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.preparationManifest,
      artifactPaths.appMap,
      artifactPaths.actionCatalog,
      artifactPaths.flowSpec,
      artifactPaths.demoScriptContract,
      artifactPaths.captureSdkContract,
      input.failureReport.stage === "capture-path-validation"
        ? artifactPaths.capturePathValidation
        : "/workspace/.makeademo/static-script-contract-validation.json",
      artifactPaths.demoScript,
    ],
    instructions: [
      "Backend validation rejected the Demo Script. Repair only /workspace/.makeademo/demo-script.json.",
      "Re-read /workspace/.makeademo/demo-script-contract.json. Its JSON Schema and mixed-Scene example are authoritative; the backend owns Playwright source generation.",
      "Do not write or repair demoPlaywrightScript. Repair the typed setupActions or playwright-recording Scene actions identified by validation evidence.",
      "Preserve every FlowSpec featureId and at least one browser Scene per feature. Product intro, feature intro, and outro cards are reassembled by the backend.",
      "Do not edit app source or preparation files. Durable artifacts are the source of truth.",
      `Failure classification: ${input.failureReport.failureClassification ?? "unknown"}`,
      `Failure summary: ${input.failureReport.logsSummary}`,
      `Browser observations: ${JSON.stringify(input.failureReport.browserObservations)}`,
      `Console errors: ${JSON.stringify(input.failureReport.consoleErrors)}`,
      `Page errors: ${JSON.stringify(input.failureReport.pageErrors)}`,
      `Blocked network attempts: ${JSON.stringify(input.failureReport.blockedNetworkAttempts)}`,
      `stderr evidence: ${JSON.stringify(input.failureReport.stderrExcerpts)}`,
      `Suggested repair hints: ${JSON.stringify(input.failureReport.suggestedRepairHints)}`,
      "Scene description is optional human-readable metadata and is not required for capture or validation.",
      "presentation.music, presentation.textOverlays, and presentation.transitions are optional and default to disabled music, no overlays, and direct back-to-back Scene playback when omitted.",
      ...(input.artifactError === undefined
        ? []
        : [
            `The previous repaired Demo Script artifact was unreadable: ${input.artifactError}`,
          ]),
      "Preserve the selected FlowSpec unless the evidence proves a locator or timing adjustment is required.",
      "The backend will rerun the full static contract and dynamic capture validation after this repair.",
    ].join("\n"),
    stage: "script-repair",
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

import { createHash } from "node:crypto";
import { join } from "node:path";
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
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "../../shared/integrations/agents/opencode-provider-secrets";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import type { PipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import { exploreSubmittedApp } from "../app-explorer/submitted-app-explorer";
import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceCommandResult,
  AgentHarnessWorkspaceHandle,
  AgentHarnessWorkspaceProvider,
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
import { synthesizeRunPlan } from "../run-planner/run-plan-synthesis";
import {
  type ActionCatalog,
  type AppMap,
  DEMO_SCRIPT_OUTPUT_PATH,
  type FlowSpec,
  type PreparationManifest,
  type RepoProfile,
  type RunPlan,
  type ScriptCandidate,
  type ValidationReport,
  readFlowSpec,
  readPreparationManifest,
} from "../schemas/artifacts";
import { createFlowSpecContract } from "../schemas/flow-spec-contract";
import { createPreparationManifestTemplate } from "../schemas/preparation-manifest-template";
import {
  createDemoScriptContract,
  validateDemoScriptCandidateContract,
} from "../script-contract/demo-script-contract";
import {
  type ScriptWritingContentSnapshot,
  findScriptWritingContentChanges,
} from "../script-generation/read-only-boundary";
import { runDependencyInstallThroughGate } from "../tools/dependency-install-gate";
import { planLockfileReconciliation } from "../tools/lockfile-reconciliation";
import { validateDynamicCapturePath } from "../validation/dynamic-capture-path-validation";
import { validatePreparedWorkspaceCapturePath } from "../validation/prepared-workspace-capture-path-validator";
import {
  createRuntimeNetworkGuardSource,
  readRuntimeNetworkAttempts,
  runtimeNetworkGuardPath,
} from "../validation/runtime-network-guard";
import {
  type RepoSourceArchive,
  assertRepoSourceArchiveIntegrity,
} from "./repo-snapshot";

export type DefaultHarnessDependenciesOptions = {
  artifactStore: NonNullable<AgentHarnessPipelineDependencies["artifactStore"]>;
  env?: Record<string, string | undefined>;
  logger?: PipelineEventLogger;
  modelID?: string;
  openCodeRunner?: OpenCodeHarnessRunner;
  outputRoot: string;
  providerID?: string;
  /** Exact screened revision to materialize; production callers must provide it. */
  repoSourceArchive?: RepoSourceArchive;
  staticImageAssets?: Readonly<Record<string, { sourcePath: string }>>;
  workspaceProvider?: AgentHarnessWorkspaceProvider;
};

export type DefaultHarnessDependencies = {
  dependencies: AgentHarnessPipelineDependencies;
  getWorkspaceHandle(): AgentHarnessWorkspaceHandle | undefined;
};

const workspaceRepoDirectory = "/workspace/repo";
const makeADemoDirectory = "/workspace/.makeademo";
const misplacedPreparationManifestPath =
  "/workspace/repo/.makeademo/preparation-manifest.json";
const openCodeConfigDirectory = "/tmp/makeademo/opencode";

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
  flowSpec: "/workspace/.makeademo/flow-spec.json",
  flowSpecContract: "/workspace/.makeademo/flow-spec-contract.json",
  preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
  preparationManifestTemplate:
    "/workspace/.makeademo/preparation-manifest-template.json",
  preparationPreflight:
    "/workspace/.makeademo/preparation-preflight-validation-report.json",
  repoProfile: "/workspace/.makeademo/repo-profile.json",
  runPlan: "/workspace/.makeademo/run-plan.json",
  supportingDocuments: "/workspace/.makeademo/supporting-documents.json",
};

export async function createDefaultAgentHarnessDependencies(
  options: DefaultHarnessDependenciesOptions,
): Promise<DefaultHarnessDependencies> {
  const env = options.env ?? process.env;
  const providerID = options.providerID ?? "openai";
  const modelID = options.modelID ?? "gpt-5";
  const openCodeRunner =
    options.openCodeRunner ?? new DefaultOpenCodeHarnessRunner();
  let workspaceHandle: AgentHarnessWorkspaceHandle | undefined;
  let opencodeSessionId: string | undefined;
  let runtimeRepairArtifactAttempt = 0;
  let preparationBaseline: ScriptWritingContentSnapshot = {};
  let scriptWritingBaseline: ScriptWritingContentSnapshot = {};
  const trustedStaticImageAssetIds = Object.keys(
    options.staticImageAssets ?? {},
  ).sort();
  const runOpenCode = (input: OpenCodeHarnessRunInput) =>
    runLoggedOpenCode({ input, logger: options.logger, openCodeRunner });

  const dependencies: AgentHarnessPipelineDependencies = {
    artifactStore: options.artifactStore,
    async capturePreparationWorkspaceDiff({ workspace }) {
      const after = await readWorkspaceContentSnapshot(workspace, {
        includeMakeADemoArtifacts: false,
      });
      const patch = await readPreparationWorkspacePatch(workspace);
      return {
        changedPaths: findScriptWritingContentChanges({
          after,
          before: preparationBaseline,
        }),
        patch,
        patchSha256: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
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
    async exploreApp({ preparationManifest, workspace }) {
      return await exploreSubmittedApp({
        baseUrl: preparationManifest.baseUrl,
        preparationManifestId: preparationManifest.id,
        workspace,
      });
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
      for (let attempt = 1; attempt <= 3; attempt += 1) {
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
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
                ok: false as const,
              };
        if (flowSpecResult.ok) {
          try {
            const flowSpec = readFlowSpec(flowSpecResult.value);
            assertFlowSpecGrounded({ actionCatalog, appMap, flowSpec });
            return flowSpec;
          } catch (error) {
            artifactError = `Invalid FlowSpec: ${readErrorMessage(error)}`;
          }
        } else {
          artifactError = flowSpecResult.error;
        }
        throwIfRequiredArtifactWriteWasDenied({
          path: artifactPaths.flowSpec,
          result,
          stage: "Flow Planning",
        });
        if (attempt === 3) {
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
      runPlan,
      workspace,
    }) {
      await materializeScreenedRepo({
        repoProfile,
        sourceArchive: options.repoSourceArchive,
        workspace,
      });
      preparationBaseline = await readWorkspaceContentSnapshot(workspace, {
        includeMakeADemoArtifacts: false,
      });
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(workspace, artifactPaths.runPlan, runPlan);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifestTemplate,
        createPreparationManifestTemplate(runPlan),
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
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const stage =
          attempt === 1 ? "repo-preparation" : "repo-preparation-repair";
        const result = await runOpenCode({
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
        opencodeSessionId = result.sessionId ?? opencodeSessionId;
        previousResult = result;
        const manifestResult =
          result.exitCode === 0
            ? await tryReadPreparationManifest(
                workspace,
                artifactPaths.preparationManifest,
              )
            : {
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
                ok: false as const,
              };
        await persistAgentArtifactAttempt({
          artifactStore: options.artifactStore,
          attempt,
          result: manifestResult,
          route: "repo-preparation",
          sessionId: opencodeSessionId,
        });
        await writeAgentArtifactValidationLog({
          attempt,
          logger: options.logger,
          result: manifestResult,
          route: "repo-preparation",
          sessionId: opencodeSessionId,
          workspace,
        });
        if (manifestResult.ok) {
          return {
            manifest: manifestResult.manifest,
            ...(opencodeSessionId === undefined ? {} : { opencodeSessionId }),
          };
        }
        readError = manifestResult.error;
        throwIfRequiredArtifactWriteWasDenied({
          path: artifactPaths.preparationManifest,
          result,
          stage: "Repo Preparation",
        });
        if (attempt === 3) {
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
      runPlan,
      workspace,
    }) {
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.preparationManifest,
        preparationManifest,
      );
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
        artifactPaths.preparationManifestTemplate,
        createPreparationManifestTemplate(runPlan),
      );
      let artifactError: string | undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
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
        const manifestResult =
          result.exitCode === 0
            ? await tryReadPreparationManifest(
                workspace,
                artifactPaths.preparationManifest,
              )
            : {
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
                ok: false as const,
              };
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
        if (manifestResult.ok) {
          return {
            manifest: manifestResult.manifest,
            ...(opencodeSessionId === undefined ? {} : { opencodeSessionId }),
          };
        }
        artifactError = manifestResult.error;
        throwIfRequiredArtifactWriteWasDenied({
          path: artifactPaths.preparationManifest,
          result,
          stage: "Repo Preparation Repair",
        });
        if (attempt === 3) {
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
      for (let attempt = 1; attempt <= 3; attempt += 1) {
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
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
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
          path: DEMO_SCRIPT_OUTPUT_PATH,
          result,
          stage: "Script Repair",
        });
        if (attempt === 3) {
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
    async resetCaptureRuntime({ preparationManifest, runPlan, workspace }) {
      return await validateSubmittedCodeRuntime({
        installDependencies: false,
        preparationManifest,
        runPlan,
        stage: "capture-runtime-reset",
        workspace,
      });
    },
    async synthesizeRunPlan({ repoProfile }) {
      return synthesizeRunPlan(repoProfile);
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
              if (demoScript.demoPlaywrightScript === undefined) {
                throw new Error(
                  "Demo Script browser Scenes did not compile to Playwright source.",
                );
              }
              const result = await validatePreparedWorkspaceCapturePath({
                baseUrl: preparationManifest.baseUrl,
                demoPlaywrightScript: demoScript.demoPlaywrightScript,
                expectedStepIdsByScene: Object.fromEntries([
                  [
                    "setup",
                    demoScript.setupActions?.map((action) => action.id) ?? [],
                  ],
                  ...browserScenes.map((scene) => [
                    scene.id,
                    scene.actions?.map((action) => action.id) ?? [],
                  ]),
                ]),
                localRunDirectory: join(
                  options.outputRoot,
                  "capture-path-validation",
                  `capture-path-validation-${Date.now()}`,
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
              return result;
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
    async validatePreparation({ preparationManifest, runPlan, workspace }) {
      return await validateSubmittedCodeRuntime({
        preparationManifest,
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
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const stage = attempt === 1 ? "script-writing" : "script-repair";
        const result = await runOpenCode({
          availableTools: ["read", "write"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt:
            attempt === 1
              ? createScriptWritingPrompt({
                  demoBrief,
                  trustedStaticImageAssetIds,
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
                error: `OpenCode exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
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
          path: DEMO_SCRIPT_OUTPUT_PATH,
          result,
          stage:
            stage === "script-writing" ? "Script Writing" : "Script Repair",
        });
        if (attempt === 3) {
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
    getWorkspaceHandle: () => workspaceHandle,
  };
}

async function runLoggedOpenCode(input: {
  input: OpenCodeHarnessRunInput;
  logger: PipelineEventLogger | undefined;
  openCodeRunner: OpenCodeHarnessRunner;
}): Promise<OpenCodeHarnessRunResult> {
  const startedAt = Date.now();
  let partialStderr = "";
  let partialStdout = "";
  const startedEntry = {
    event: "agent.command.started",
    message: `${input.input.stage} agent command started.`,
    model: input.input.model,
    stage: input.input.stage,
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
        partialStderr = appendTail(partialStderr, chunk, 4_000);
        input.input.onStderr?.(chunk);
      },
      onStdout: (chunk) => {
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
        stderrExcerpt: tail(result.stderr, 4_000),
        stdoutExcerpt: tail(result.stdout, 4_000),
      },
      level,
    );
    return result;
  } catch (error) {
    await writeAgentStageLog(
      input,
      {
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error),
        event: "agent.command.failed",
        message: `${input.input.stage} agent command failed before completion.`,
        ...(partialStderr.length === 0
          ? {}
          : { partialStderrExcerpt: partialStderr }),
        ...(partialStdout.length === 0
          ? {}
          : { partialStdoutExcerpt: partialStdout }),
        stage: input.input.stage,
      },
      "error",
    );
    if (isAgentHarnessCommandTimeout(error)) {
      return {
        exitCode: 124,
        ...(input.input.sessionId === undefined
          ? {}
          : { sessionId: input.input.sessionId }),
        stderr: [readErrorMessage(error), partialStderr]
          .filter((value) => value.length > 0)
          .join("\n"),
        stdout: partialStdout,
      };
    }
    throw error;
  }
}

function appendTail(current: string, chunk: string, maxLength: number): string {
  return `${current}${chunk}`.slice(-maxLength);
}

function isAgentHarnessCommandTimeout(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "AgentHarnessCommandTimeoutError"
  );
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
  installDependencies?: boolean;
  preparationManifest: PreparationManifest;
  runPlan: RunPlan;
  stage?: string;
  workspace: AgentHarnessWorkspace;
}): Promise<ValidationReport> {
  const manifest = input.preparationManifest;
  const stage = input.stage ?? "preparation-preflight";
  try {
    await stopSubmittedCodeApp(input.workspace);
    await setSubmittedCodeNetwork(input.workspace, false);
    await input.workspace.syncSubmittedCodeWorkspace?.();
  } catch (error) {
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
            commandInAppDirectory(manifest.appDir, command),
          ),
      });
    let result = await runInstall(installCommand);
    const reconciliationCommand =
      result.status === "failed"
        ? planLockfileReconciliation({
            installCommand,
            stderr: result.stderr,
            stdout: result.stdout,
          })
        : undefined;
    if (reconciliationCommand !== undefined) {
      const reconciliation = await runInstall(reconciliationCommand);
      if (reconciliation.status === "succeeded") {
        result = await runInstall(installCommand);
      } else if (reconciliation.status === "failed") {
        result = {
          ...reconciliation,
          stderr: [
            "Automatic lockfile reconciliation failed.",
            reconciliation.stderr || reconciliation.stdout,
          ]
            .filter((value) => value.length > 0)
            .join("\n"),
        };
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

  if (manifest.buildCommandUsed !== undefined) {
    const buildResult = await executeSubmitted(
      input.workspace,
      commandInAppDirectory(manifest.appDir, manifest.buildCommandUsed),
      { env: manifest.envUsed },
    );
    if (buildResult.exitCode !== 0) {
      return failedPreparationValidation({
        attemptedCommand: manifest.buildCommandUsed,
        classification: "build failure",
        exitCode: buildResult.exitCode,
        logsSummary: `Submitted-code build failed: ${buildResult.stderr || buildResult.stdout}`,
        manifest,
        stage,
        stderr: buildResult.stderr,
        stdout: buildResult.stdout,
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
    MAKEADEMO_ALLOWED_RUNTIME_HOSTS: readRuntimeAllowedHosts(manifest.baseUrl),
    NODE_OPTIONS: [existingNodeOptions, `--require=${runtimeNetworkGuardPath}`]
      .filter(
        (value): value is string => value !== undefined && value.length > 0,
      )
      .join(" "),
  };
  try {
    await input.workspace.startSubmittedCodeApp({
      command: manifest.startCommandUsed,
      cwd: absoluteAppDirectory(manifest.appDir),
      env: guardedRuntimeEnv,
    });
  } catch (error) {
    return failedPreparationValidation({
      attemptedCommand: manifest.startCommandUsed,
      classification: "harness/internal failure",
      logsSummary: `Daytona could not start the managed submitted-code app session: ${readErrorMessage(error)}`,
      manifest,
      stage,
    });
  }

  const preflightResult = await probeSubmittedCodeRuntime(
    input.workspace,
    manifest.baseUrl,
  );
  const probeExecutionFailed =
    isReadinessProbeExecutionFailure(preflightResult);
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
  const blockedRuntimeNetworkAttempts = readRuntimeNetworkAttempts(appOutput);
  const failedLogs = [
    `Prepared submitted-code runtime did not respond: ${preflightResult.stderr || preflightResult.stdout}`,
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
    attemptedCommand: `curl ${manifest.baseUrl}`,
    exitCode: preflightResult.exitCode,
    blockedNetworkAttempts: blockedRuntimeNetworkAttempts,
    failureClassification:
      blockedRuntimeNetworkAttempts.length > 0
        ? "external network attempted"
        : preflightResult.exitCode === 0
          ? "none"
          : probeExecutionFailed
            ? "harness/internal failure"
            : "start failure",
    logsSummary:
      blockedRuntimeNetworkAttempts.length > 0
        ? `Prepared submitted-code runtime attempted ${blockedRuntimeNetworkAttempts.length} blocked external network request(s).`
        : preflightResult.exitCode === 0
          ? "Prepared submitted-code runtime responded successfully."
          : failedLogs,
    stage,
    networkAttempts: blockedRuntimeNetworkAttempts,
    status:
      preflightResult.exitCode === 0 &&
      blockedRuntimeNetworkAttempts.length === 0
        ? "passed"
        : "failed",
    stderrExcerpts: preflightResult.stderr
      ? [preflightResult.stderr.slice(-500)]
      : [],
    stdoutExcerpts: preflightResult.stdout
      ? [preflightResult.stdout.slice(-500)]
      : [],
    urlChecked: manifest.baseUrl,
  });
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

function readRuntimeAllowedHosts(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  return [...new Set([host, "localhost", "127.0.0.1", "::1", "0.0.0.0"])].join(
    ",",
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
  if (enabled) {
    if (workspace.openSubmittedCodeDependencyNetwork !== undefined) {
      await workspace.openSubmittedCodeDependencyNetwork();
      return;
    }
    await workspace.setSubmittedCodeNetworkAccess?.(true);
    return;
  }

  if (workspace.closeSubmittedCodeDependencyNetwork !== undefined) {
    await workspace.closeSubmittedCodeDependencyNetwork();
    return;
  }
  if (workspace.enforceSubmittedCodeRuntimeNetworkLockdown !== undefined) {
    await workspace.enforceSubmittedCodeRuntimeNetworkLockdown();
    return;
  }
  await workspace.setSubmittedCodeNetworkAccess?.(false);
}

async function executeSubmitted(
  workspace: AgentHarnessWorkspace,
  command: string,
  options: { env?: Record<string, string> } = {},
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

async function probeSubmittedCodeRuntime(
  workspace: AgentHarnessWorkspace,
  url: string,
): Promise<AgentHarnessWorkspaceCommandResult> {
  let result: AgentHarnessWorkspaceCommandResult = {
    exitCode: 1,
    stderr: "Readiness probe did not run.",
    stdout: "",
  };
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    result = await executeSubmitted(
      workspace,
      `curl -fsS --max-time 10 ${shellQuote(url)} -o /tmp/makeademo/preflight.html`,
    );
    if (result.exitCode === 0 || isReadinessProbeExecutionFailure(result)) {
      return result;
    }
    if (attempt < 10) {
      await wait(2_000);
    }
  }
  return result;
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
  flowSpec: FlowSpec;
}): void {
  if (input.actionCatalog.appMapId !== input.appMap.id) {
    throw new Error("ActionCatalog must reference the current AppMap");
  }
  const observedRoutes = new Set(
    input.appMap.discoveredRoutes.map((route) => route.path),
  );
  for (const route of input.flowSpec.referencedAppMapRoutePaths) {
    if (!observedRoutes.has(route)) {
      throw new Error(`FlowSpec references unknown AppMap route ${route}`);
    }
  }

  const actionsById = new Map(
    input.actionCatalog.actions.map((action) => [action.id, action]),
  );
  for (const actionId of input.flowSpec.referencedActionIds) {
    const action = actionsById.get(actionId);
    if (action === undefined) {
      throw new Error(
        `FlowSpec references unknown ActionCatalog action ${actionId}`,
      );
    }
    if (!input.flowSpec.referencedAppMapRoutePaths.includes(action.route)) {
      throw new Error(
        `FlowSpec action ${actionId} belongs to unselected route ${action.route}`,
      );
    }
  }
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
        'git ls-files -co --exclude-standard -z | while IFS= read -r -d "" relative; do fingerprint_file "$PWD/$relative"; done',
        ...(options.includeMakeADemoArtifacts === false
          ? []
          : [
              `if test -d ${shellQuote(makeADemoDirectory)}; then find ${shellQuote(makeADemoDirectory)} \\( -type f -o -type l \\) -print0 | sort -z | while IFS= read -r -d "" path; do fingerprint_file "$path"; done; fi`,
            ]),
      ].join("\n"),
    )}`,
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

async function readPreparationWorkspacePatch(
  workspace: AgentHarnessWorkspace,
): Promise<string> {
  const result = await workspace.execute(
    `sh -lc ${shellQuote(
      [
        `cd ${shellQuote(workspaceRepoDirectory)}`,
        "temporary_index=$(mktemp)",
        'rm -f "$temporary_index"',
        'cleanup_index() { rm -f "$temporary_index"; }',
        "trap cleanup_index EXIT",
        'GIT_INDEX_FILE="$temporary_index" git read-tree HEAD',
        'GIT_INDEX_FILE="$temporary_index" git add -A',
        'GIT_INDEX_FILE="$temporary_index" git diff --cached --binary --full-index HEAD',
      ].join(" && "),
    )}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to capture prepared workspace diff: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

async function writeWorkspaceJson(
  workspace: AgentHarnessWorkspace,
  path: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  const result = await workspace.execute(
    `sh -lc ${shellQuote(
      `mkdir -p ${shellQuote(makeADemoDirectory)} && printf '%s\n' ${shellQuote(
        json,
      )} > ${shellQuote(path)}`,
    )}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write workspace artifact ${path}: ${result.stderr}`,
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
  | { ok: true; value: unknown }
  | { error: string; ok: false };

type PreparationManifestReadResult =
  | { candidate: unknown; manifest: PreparationManifest; ok: true }
  | { candidate?: unknown; error: string; ok: false };

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
      ok: false,
    };
  }

  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      error: `Invalid JSON in ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ok: false,
    };
  }
}

async function tryReadPreparationManifest(
  workspace: AgentHarnessWorkspace,
  path: string,
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
    return {
      candidate: json.value,
      manifest: readPreparationManifest(json.value),
      ok: true,
    };
  } catch (error) {
    return {
      candidate: json.value,
      error: `Invalid PreparationManifest in ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ok: false,
    };
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
      ...(input.result.ok ? {} : { error: input.result.error }),
      route: input.route,
      ...(input.sessionId === undefined
        ? {}
        : { opencodeSessionId: input.sessionId }),
      status: input.result.ok ? "passed" : "failed",
    },
  );
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
  stage: string;
  status?: "failed" | "passed";
  stderrExcerpts?: string[];
  stdoutExcerpts?: string[];
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
    screenshots: [],
    stage: input.stage,
    status: input.status ?? "passed",
    stderrExcerpts: input.stderrExcerpts ?? [],
    stdoutExcerpts: input.stdoutExcerpts ?? [],
    suggestedRepairHints: [],
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
    scriptJsonContent: input.demoScript,
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
      scriptCandidate: candidate,
      trustedStaticImageAssetIds: input.trustedStaticImageAssetIds,
    }),
  };
}

function failedPreparationValidation(input: {
  attemptedCommand?: string;
  classification: string;
  exitCode?: number;
  logsSummary: string;
  manifest: PreparationManifest;
  stage: string;
  stderr?: string;
  stdout?: string;
}): ValidationReport {
  return validationReport({
    ...(input.attemptedCommand === undefined
      ? {}
      : { attemptedCommand: input.attemptedCommand }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    failureClassification: input.classification,
    logsSummary: input.logsSummary,
    stage: input.stage,
    status: "failed",
    stderrExcerpts: input.stderr ? [input.stderr.slice(-500)] : [],
    stdoutExcerpts: input.stdout ? [input.stdout.slice(-500)] : [],
    urlChecked: input.manifest.baseUrl,
  });
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

function throwIfRequiredArtifactWriteWasDenied(input: {
  path: string;
  result: Pick<OpenCodeHarnessRunResult, "stderr" | "stdout">;
  stage: string;
}): void {
  const output = `${input.result.stderr}\n${input.result.stdout}`;
  const artifactName = input.path.slice(input.path.lastIndexOf("/") + 1);
  const mentionsArtifact =
    output.includes(input.path) || output.includes(artifactName);
  const reportsPermissionDenial =
    /(?:write|create|edit)[^\n]{0,120}(?:blocked|denied)[^\n]{0,120}permission|(?:blocked|denied)[^\n]{0,120}(?:permission|write|creation)|specified a rule which prevents you from using this specific tool call/i.test(
      output,
    );
  if (mentionsArtifact && reportsPermissionDenial) {
    throw new Error(
      `${input.stage} harness configuration failure: required artifact write was denied for ${input.path}.`,
    );
  }
}

function formatOpenCodeOutputExcerpt(result: {
  stderr: string;
  stdout: string;
}): string {
  const parts = [
    result.stderr.trim().length === 0
      ? ""
      : `stderr:\n${tail(result.stderr, 2000)}`,
    result.stdout.trim().length === 0
      ? ""
      : `stdout:\n${tail(result.stdout, 2000)}`,
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
      artifactPaths.preparationManifestTemplate,
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Prepare the cloned app in /workspace/repo for a local MakeADemo run.",
      "You may modify app files in /workspace/repo only when needed to make a deterministic local demo mode.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      "Inventory every browser-reachable external dependency, including scripts, stylesheets, fonts, icons, images, analytics, API calls, WebSockets, and protocol-relative URLs beginning with //. The prepared app must attempt zero outbound browser requests; remove, vendor, or replace every dependency locally.",
      "Do not install dependencies, build, start, or execute submitted application code in the agent sandbox. The backend runs those commands in the secret-free submitted-code sandbox.",
      "Read /workspace/.makeademo/supporting-documents.json when it contains maker-provided context and incorporate relevant setup or demo requirements.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "Write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "Start by copying /workspace/.makeademo/preparation-manifest-template.json; preserve every field type and replace or enrich its values.",
      "The manifest must include id, appDir, installCommandUsed, startCommandUsed, baseUrl, ports, envUsed, localDemoModeChanges, createdFiles, modifiedFiles, mocksAndFixturesAdded, blockedExternalServicesReplaced, requiredLocalOnlyAssumptions, knownLimitations, appExplorationHints, scriptGenerationContext, validationEvidence, and cleanupAndReproInstructions.",
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
      artifactPaths.preparationManifestTemplate,
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Repo Preparation completed without producing the required artifact /workspace/.makeademo/preparation-manifest.json.",
      "The artifact may be missing, unreadable, invalid JSON, or schema-invalid.",
      `Backend artifact validation failed with: ${input.readError}`,
      "Repair only the Repo Preparation output contract. Inspect /workspace/repo and the durable artifacts, then write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "Use /workspace/.makeademo/preparation-manifest-template.json as the canonical shape; preserve every field type while repairing all reported violations.",
      "Do not finish until the manifest exists at that exact path.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "The manifest must include id, appDir, installCommandUsed, startCommandUsed, baseUrl, ports, envUsed, localDemoModeChanges, createdFiles, modifiedFiles, mocksAndFixturesAdded, blockedExternalServicesReplaced, requiredLocalOnlyAssumptions, knownLimitations, appExplorationHints, scriptGenerationContext, validationEvidence, and cleanupAndReproInstructions.",
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
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.repoProfile,
      artifactPaths.runPlan,
      artifactPaths.demoBrief,
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
      "Do not run the app, install dependencies, or use the network. The backend will rerun install, build, start, and browser validation in the isolated submitted-code sandbox.",
      "For browser network failures, repair every unique blocked URL shown above. Handle protocol-relative //host/path assets as external, and make the browser attempt zero outbound requests by removing, vendoring, mocking, or replacing them locally.",
      "You may edit /workspace/repo and must rewrite /workspace/.makeademo/preparation-manifest.json to match the actual repaired state.",
      "Use /workspace/.makeademo/preparation-manifest-template.json as the canonical shape; preserve every field type while repairing all reported violations.",
      'appDir must remain relative to /workspace/repo: use "." for the repo root or a path such as "frontend"; never use an absolute path.',
      'envUsed must remain a flat string-to-string object such as {"NODE_ENV":"development","DEMO_MODE":"true"}; nested values, arrays, and descriptive objects are invalid.',
      `Current manifest: ${JSON.stringify(input.preparationManifest)}`,
      `Run plan: ${JSON.stringify(input.runPlan)}`,
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
      `Repo profile: ${JSON.stringify(input.repoProfile)}`,
    ].join("\n"),
    stage: "repo-preparation-repair",
  });
}

function validationArtifactPath(stage: string): string {
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
      artifactPaths.flowSpecContract,
      artifactPaths.flowSpec,
    ],
    instructions: [
      "Plan one short demo flow from the AppMap, ActionCatalog, and demo brief.",
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
  trustedStaticImageAssetIds: readonly string[];
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
      "Read /workspace/.makeademo/demo-script-contract.json before writing and follow its JSON Schema and mixed-Scene example exactly. The Capture SDK artifact documents the backend-generated runtime only.",
      "Do not edit app source files. Only write /workspace/.makeademo/demo-script.json.",
      "Do not write demoPlaywrightScript; the backend compiles typed browser actions into versioned Capture SDK and Playwright source.",
      ...(input.trustedStaticImageAssetIds.length === 0
        ? [
            "Use playwright-recording and full-screen-text Scene types. No trusted static-image assets are registered for this run, so static-image is unavailable.",
          ]
        : [
            `Use playwright-recording, full-screen-text, and static-image Scene types. The only trusted static-image asset IDs are: ${input.trustedStaticImageAssetIds.join(", ")}.`,
          ]),
      "Every playwright-recording Scene requires typed actions and expectedVisibleOutcome. Each locator action must copy one browser-verified ActionCatalog locator exactly and include its locatorCandidateId; sourceActionId must reference ActionCatalog evidence selected by FlowSpec.",
      "Use setupActions only for off-camera browser setup such as navigation or login. Every setup action must also include a sourceActionId grounded in ActionCatalog. Keep the product demonstration inside Scene actions.",
      "A full-screen-text Scene requires durationSeconds, backgroundColor, and text. Use static-image only when a backend-trusted assetId is present in the durable artifacts; never invent paths or asset IDs.",
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

import { join } from "node:path";
import { captureScenesFromScript } from "../../pipeline/06-footage-capture/capture-scenes";
import {
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "../../shared/integrations/agents/opencode-provider-secrets";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import type { PipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceHandle,
  AgentHarnessWorkspaceProvider,
} from "../daytona/workspace.interface";
import { DefaultOpenCodeHarnessRunner } from "../opencode/default-opencode-harness-runner";
import {
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
  readActionCatalog,
  readAppMap,
  readFlowSpec,
  readPreparationManifest,
} from "../schemas/artifacts";
import { validateDemoScriptCandidateContract } from "../script-contract/demo-script-contract";
import { validateDynamicCapturePath } from "../validation/dynamic-capture-path-validation";

export type DefaultHarnessDependenciesOptions = {
  artifactStore: NonNullable<AgentHarnessPipelineDependencies["artifactStore"]>;
  env?: Record<string, string | undefined>;
  logger?: PipelineEventLogger;
  modelID?: string;
  openCodeRunner?: OpenCodeHarnessRunner;
  outputRoot: string;
  providerID?: string;
  workspaceProvider?: AgentHarnessWorkspaceProvider;
};

export type DefaultHarnessDependencies = {
  dependencies: AgentHarnessPipelineDependencies;
  getWorkspaceHandle(): AgentHarnessWorkspaceHandle | undefined;
};

const workspaceRepoDirectory = "/workspace/repo";
const makeADemoDirectory = "/workspace/.makeademo";
const openCodeConfigDirectory = "/tmp/makeademo/opencode";

const artifactPaths = {
  actionCatalog: "/workspace/.makeademo/action-catalog.json",
  appMap: "/workspace/.makeademo/app-map.json",
  capturePathValidation:
    "/workspace/.makeademo/capture-path-validation-report.json",
  demoBrief: "/workspace/.makeademo/demo-brief.json",
  demoScript: DEMO_SCRIPT_OUTPUT_PATH,
  flowSpec: "/workspace/.makeademo/flow-spec.json",
  preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
  preparationPreflight:
    "/workspace/.makeademo/preparation-preflight-validation-report.json",
  repoProfile: "/workspace/.makeademo/repo-profile.json",
  runPlan: "/workspace/.makeademo/run-plan.json",
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
  let scriptWritingBaseline = new Set<string>();

  const dependencies: AgentHarnessPipelineDependencies = {
    artifactStore: options.artifactStore,
    async captureWorkspaceDiff({ workspace }) {
      const current = await readGitStatus(workspace);
      return [...current].filter((path) => !scriptWritingBaseline.has(path));
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
    async exploreApp({
      actionCatalogPath,
      appMapPath,
      demoBrief,
      preparationManifest,
      preparationValidation,
      repoProfile,
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
        artifactPaths.preparationPreflight,
        preparationValidation,
      );
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      const result = await openCodeRunner.run({
        availableTools: ["read", "write", "bash"],
        configDir: openCodeConfigDirectory,
        model: `${providerID}/${modelID}`,
        prompt: createAppExplorationPrompt({
          actionCatalogPath,
          appMapPath,
          preparationManifest,
        }),
        ...optionalSessionId(opencodeSessionId),
        stage: "app-exploration",
        timeoutMs: 10 * 60_000,
        workingDirectory: workspaceRepoDirectory,
        workspace,
      });
      assertOpenCodeSucceeded("App Exploration", result);
      opencodeSessionId = result.sessionId;

      return {
        actionCatalog: readActionCatalog(
          await readWorkspaceJson(workspace, actionCatalogPath),
        ),
        appMap: readAppMap(await readWorkspaceJson(workspace, appMapPath)),
        validationReport: validationReport({
          logsSummary: "App Exploration produced typed artifacts.",
          stage: "app-exploration",
          urlChecked: preparationManifest.baseUrl,
        }),
      };
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
      const result = await openCodeRunner.run({
        availableTools: ["read", "write"],
        configDir: openCodeConfigDirectory,
        model: `${providerID}/${modelID}`,
        prompt: createFlowPlanningPrompt(),
        ...optionalSessionId(opencodeSessionId),
        stage: "flow-planning",
        timeoutMs: 10 * 60_000,
        workingDirectory: workspaceRepoDirectory,
        workspace,
      });
      assertOpenCodeSucceeded("Flow Planning", result);
      opencodeSessionId = result.sessionId;
      return readFlowSpec(
        await readWorkspaceJson(workspace, artifactPaths.flowSpec),
      );
    },
    async prepareRepo({ demoBrief, repoProfile, runPlan, workspace }) {
      await cloneRepoInWorkspace({ repoUrl: repoProfile.repoUrl, workspace });
      await writeWorkspaceJson(workspace, artifactPaths.demoBrief, demoBrief);
      await writeWorkspaceJson(
        workspace,
        artifactPaths.repoProfile,
        repoProfile,
      );
      await writeWorkspaceJson(workspace, artifactPaths.runPlan, runPlan);
      const result = await openCodeRunner.run({
        availableTools: ["read", "write", "bash"],
        configDir: openCodeConfigDirectory,
        model: `${providerID}/${modelID}`,
        prompt: createRepoPreparationPrompt({
          demoBrief,
          repoProfile,
          runPlan,
        }),
        ...optionalSessionId(opencodeSessionId),
        stage: "repo-preparation",
        timeoutMs: 20 * 60_000,
        workingDirectory: workspaceRepoDirectory,
        workspace,
      });
      assertOpenCodeSucceeded("Repo Preparation", result);
      opencodeSessionId = result.sessionId;
      let manifestResult = await tryReadPreparationManifest(
        workspace,
        artifactPaths.preparationManifest,
      );
      if (!manifestResult.ok) {
        const repairResult = await openCodeRunner.run({
          availableTools: ["read", "write", "bash"],
          configDir: openCodeConfigDirectory,
          model: `${providerID}/${modelID}`,
          prompt: createRepoPreparationRepairPrompt({
            demoBrief,
            previousResult: result,
            readError: manifestResult.error,
            repoProfile,
            runPlan,
          }),
          ...optionalSessionId(opencodeSessionId),
          stage: "repo-preparation-repair",
          timeoutMs: 10 * 60_000,
          workingDirectory: workspaceRepoDirectory,
          workspace,
        });
        assertOpenCodeSucceeded("Repo Preparation Repair", repairResult);
        opencodeSessionId = repairResult.sessionId ?? opencodeSessionId;
        manifestResult = await tryReadPreparationManifest(
          workspace,
          artifactPaths.preparationManifest,
        );
        if (!manifestResult.ok) {
          throw new Error(
            formatOpenCodeArtifactContractError({
              path: artifactPaths.preparationManifest,
              readError: manifestResult.error,
              result: repairResult,
              stage: "Repo Preparation Repair",
            }),
          );
        }
      }
      const manifest = manifestResult.manifest;
      await syncAndInstallSubmittedCode({ manifest, runPlan, workspace });
      await startSubmittedCodeApp({ manifest, workspace });
      return {
        manifest,
        ...(opencodeSessionId === undefined ? {} : { opencodeSessionId }),
      };
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
              const captureManifest = await captureScenesFromScript({
                baseUrl: preparationManifest.baseUrl,
                keepTemp: true,
                preparationWorkspace: handle,
                runId: `capture-path-validation-${Date.now()}`,
                scriptPackage: scriptCandidate.scriptJsonContent,
                tempRoot: join(options.outputRoot, "capture-path-validation"),
              });
              return {
                blockedNetworkAttempts: [],
                browserUrl: preparationManifest.baseUrl,
                logs: [
                  `Captured ${captureManifest.scenes.length} Demo Script scene(s).`,
                ],
                runDirectory: captureManifest.runDirectory,
                scriptPath: scriptCandidate.outputPath,
                status: "succeeded" as const,
                warnings: captureManifest.qualityFindings,
              };
            } catch (error) {
              return {
                blockedNetworkAttempts: [],
                browserUrl: preparationManifest.baseUrl,
                failureReason:
                  error instanceof Error ? error.message : String(error),
                logs: [],
                scriptPath: scriptCandidate.outputPath,
                status: "failed" as const,
                warnings: [],
              };
            }
          },
        },
      );
    },
    async validatePreparation({ preparationManifest, workspace }) {
      const result = await executeSubmitted(
        workspace,
        createCurlRetryCommand(preparationManifest.baseUrl),
      );
      return validationReport({
        attemptedCommand: `curl ${preparationManifest.baseUrl}`,
        exitCode: result.exitCode,
        logsSummary:
          result.exitCode === 0
            ? "Prepared submitted-code runtime responded successfully."
            : `Prepared submitted-code runtime did not respond: ${result.stderr || result.stdout}`,
        stage: "preparation-preflight",
        status: result.exitCode === 0 ? "passed" : "failed",
        stderrExcerpts: result.stderr ? [result.stderr.slice(-500)] : [],
        stdoutExcerpts: result.stdout ? [result.stdout.slice(-500)] : [],
        urlChecked: preparationManifest.baseUrl,
      });
    },
    async validateScriptContract({
      flowSpec,
      preparationManifest,
      scriptCandidate,
    }) {
      return validateDemoScriptCandidateContract({
        flowSpec,
        preparationManifest,
        scriptCandidate,
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
      scriptWritingBaseline = await readGitStatus(workspace);
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
      const result = await openCodeRunner.run({
        availableTools: ["read", "write"],
        configDir: openCodeConfigDirectory,
        model: `${providerID}/${modelID}`,
        prompt: createScriptWritingPrompt({ demoBrief }),
        ...optionalSessionId(opencodeSessionId),
        stage: "script-writing",
        timeoutMs: 15 * 60_000,
        workingDirectory: workspaceRepoDirectory,
        workspace,
      });
      assertOpenCodeSucceeded("Script Writing", result);
      opencodeSessionId = result.sessionId;
      const demoScript = await readWorkspaceJson(
        workspace,
        DEMO_SCRIPT_OUTPUT_PATH,
      );
      const candidate = {
        assumptions: [],
        conformanceResult: validationReport({
          logsSummary: "Pending static Demo Script contract validation.",
          stage: "static-script-contract-validation",
          urlChecked: preparationManifest.baseUrl,
        }),
        contractVersion: "2026-07-08",
        outputPath: DEMO_SCRIPT_OUTPUT_PATH,
        scriptJsonContent: demoScript,
        sourceAppMapId: appMap.id,
        sourceFlowSpecId: flowSpec.id,
        sourcePreparationManifestId: preparationManifest.id,
        unsupportedPieces: [],
        validationArtifacts: [],
      } satisfies ScriptCandidate;
      return {
        ...candidate,
        conformanceResult: validateDemoScriptCandidateContract({
          flowSpec,
          preparationManifest,
          scriptCandidate: candidate,
        }),
      };
    },
  };

  return {
    dependencies,
    getWorkspaceHandle: () => workspaceHandle,
  };
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

async function cloneRepoInWorkspace(input: {
  repoUrl: string;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  await input.workspace.setOutboundNetworkAccess?.(true);
  const result = await input.workspace.execute(
    `sh -lc ${shellQuote(
      [
        `rm -rf ${shellQuote(workspaceRepoDirectory)}`,
        [
          "{",
          "makeademo_git_ca=${GIT_SSL_CAINFO:-};",
          'for makeademo_candidate_ca in "$makeademo_git_ca" "${SSL_CERT_FILE:-}" "${CURL_CA_BUNDLE:-}" /etc/daytona/netleash/ca.crt /etc/ssl/certs/ca-certificates.crt; do',
          'if test -n "$makeademo_candidate_ca" && test -f "$makeademo_candidate_ca"; then makeademo_git_ca="$makeademo_candidate_ca"; break; fi;',
          "done;",
          'if test -n "$makeademo_git_ca" && test -f "$makeademo_git_ca"; then',
          `git -c http.sslCAInfo="$makeademo_git_ca" clone --depth 1 ${shellQuote(input.repoUrl)} ${shellQuote(
            workspaceRepoDirectory,
          )};`,
          "else",
          `git clone --depth 1 ${shellQuote(input.repoUrl)} ${shellQuote(
            workspaceRepoDirectory,
          )};`,
          "fi;",
          "}",
        ].join(" "),
        `mkdir -p ${shellQuote(makeADemoDirectory)}`,
      ].join(" && "),
    )}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Repo clone failed: ${result.stderr || result.stdout}`);
  }
}

async function syncAndInstallSubmittedCode(input: {
  manifest: PreparationManifest;
  runPlan: RunPlan;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  await input.workspace.syncSubmittedCodeWorkspace?.();
  await setSubmittedCodeNetwork(input.workspace, true);
  try {
    const result = await executeSubmitted(
      input.workspace,
      commandInAppDirectory(
        input.manifest.appDir,
        input.manifest.installCommandUsed || input.runPlan.installCommand,
      ),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Submitted-code dependency install failed: ${
          result.stderr || result.stdout
        }`,
      );
    }
  } finally {
    await setSubmittedCodeNetwork(input.workspace, false);
  }
}

async function startSubmittedCodeApp(input: {
  manifest: PreparationManifest;
  workspace: AgentHarnessWorkspace;
}): Promise<void> {
  const result = await executeSubmitted(
    input.workspace,
    commandInAppDirectory(
      input.manifest.appDir,
      [
        "mkdir -p /tmp/makeademo",
        `nohup sh -lc ${shellQuote(
          input.manifest.startCommandUsed,
        )} > /tmp/makeademo/app.log 2>&1 &`,
        "echo $! > /tmp/makeademo/app.pid",
      ].join(" && "),
    ),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Submitted-code app start failed: ${result.stderr || result.stdout}`,
    );
  }
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
) {
  if (workspace.executeSubmittedCode === undefined) {
    throw new Error("Submitted-code execution is not configured.");
  }
  return await workspace.executeSubmittedCode(command);
}

function commandInAppDirectory(appDir: string, command: string): string {
  const absoluteAppDir = `${workspaceRepoDirectory}/${appDir.replace(/^\/+/, "")}`;
  return `sh -lc ${shellQuote(`cd ${shellQuote(absoluteAppDir)} && ${command}`)}`;
}

function createCurlRetryCommand(url: string): string {
  return `sh -lc ${shellQuote(
    [
      "for attempt in 1 2 3 4 5 6 7 8 9 10; do",
      `curl -fsS --max-time 10 ${shellQuote(url)} >/tmp/makeademo/preflight.html && exit 0`,
      "sleep 2",
      "done",
      "cat /tmp/makeademo/app.log 2>/dev/null || true",
      "exit 1",
    ].join(" "),
  )}`;
}

async function readGitStatus(
  workspace: AgentHarnessWorkspace,
): Promise<Set<string>> {
  const result = await workspace.execute(
    `sh -lc ${shellQuote(
      `cd ${shellQuote(workspaceRepoDirectory)} && git status --porcelain`,
    )}`,
  );
  if (result.exitCode !== 0) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 3)
      .map((line) => `${workspaceRepoDirectory}/${line.slice(3)}`),
  );
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

async function readWorkspaceJson(
  workspace: AgentHarnessWorkspace,
  path: string,
): Promise<unknown> {
  const result = await workspace.execute(`cat ${shellQuote(path)}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read workspace artifact ${path}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

type WorkspaceJsonReadResult =
  | { ok: true; value: unknown }
  | { error: string; ok: false };

type PreparationManifestReadResult =
  | { manifest: PreparationManifest; ok: true }
  | { error: string; ok: false };

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
  const json = await tryReadWorkspaceJson(workspace, path);
  if (!json.ok) {
    return json;
  }

  try {
    return { manifest: readPreparationManifest(json.value), ok: true };
  } catch (error) {
    return {
      error: `Invalid PreparationManifest in ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ok: false,
    };
  }
}

function validationReport(input: {
  attemptedCommand?: string;
  exitCode?: number;
  logsSummary: string;
  stage: string;
  status?: "failed" | "passed";
  stderrExcerpts?: string[];
  stdoutExcerpts?: string[];
  urlChecked?: string;
}): ValidationReport {
  return {
    artifactReferences: [],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    failureClassification:
      input.status === "failed" ? "harness/internal failure" : "none",
    logsSummary: input.logsSummary,
    networkAttempts: [],
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

function assertOpenCodeSucceeded(
  stage: string,
  result: { exitCode: number; stderr: string; stdout: string },
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${stage} OpenCode run failed: ${result.stderr || result.stdout}`,
    );
  }
}

function optionalSessionId(sessionId: string | undefined) {
  return sessionId === undefined ? {} : { sessionId };
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
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Prepare the cloned app in /workspace/repo for a local MakeADemo run.",
      "You may modify app files in /workspace/repo only when needed to make a deterministic local demo mode.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "Write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "The manifest must include id, appDir, installCommandUsed, startCommandUsed, baseUrl, ports, envUsed, localDemoModeChanges, createdFiles, modifiedFiles, mocksAndFixturesAdded, blockedExternalServicesReplaced, requiredLocalOnlyAssumptions, knownLimitations, appExplorationHints, scriptGenerationContext, validationEvidence, and cleanupAndReproInstructions.",
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
      artifactPaths.preparationManifest,
    ],
    instructions: [
      "Repo Preparation completed without producing the required artifact /workspace/.makeademo/preparation-manifest.json.",
      "The artifact may be missing, unreadable, invalid JSON, or schema-invalid.",
      `Backend artifact validation failed with: ${input.readError}`,
      "Repair only the Repo Preparation output contract. Inspect /workspace/repo and the durable artifacts, then write a valid PreparationManifest JSON object to /workspace/.makeademo/preparation-manifest.json.",
      "Do not finish until the manifest exists at that exact path.",
      "Do not write secrets into files. Replace external services with local fixtures or mocks.",
      `Use this local runtime URL in the manifest: ${input.runPlan.expectedLocalUrl}`,
      `Use this install command unless you have a stronger repo-specific reason: ${input.runPlan.installCommand}`,
      `Use this start command unless you have a stronger repo-specific reason: ${input.runPlan.startCommand}`,
      "The manifest must include id, appDir, installCommandUsed, startCommandUsed, baseUrl, ports, envUsed, localDemoModeChanges, createdFiles, modifiedFiles, mocksAndFixturesAdded, blockedExternalServicesReplaced, requiredLocalOnlyAssumptions, knownLimitations, appExplorationHints, scriptGenerationContext, validationEvidence, and cleanupAndReproInstructions.",
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

function createAppExplorationPrompt(input: {
  actionCatalogPath: string;
  appMapPath: string;
  preparationManifest: PreparationManifest;
}): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.preparationManifest,
      artifactPaths.preparationPreflight,
      artifactPaths.demoBrief,
      input.appMapPath,
      input.actionCatalogPath,
    ],
    instructions: [
      "Explore the prepared app context and repository to produce typed AppMap and ActionCatalog artifacts.",
      "Use durable artifacts as source of truth. Do not self-certify runtime validation.",
      `The prepared app base URL is ${input.preparationManifest.baseUrl}.`,
      `Write AppMap JSON to ${input.appMapPath}.`,
      `Write ActionCatalog JSON to ${input.actionCatalogPath}.`,
      "AppMap must include at least one discovered route and stable locator candidates.",
      "ActionCatalog must include at least one action that can support the requested demo flow.",
    ].join("\n"),
    stage: "app-exploration",
  });
}

function createFlowPlanningPrompt(): string {
  return createStagePrompt({
    artifactPaths: [
      artifactPaths.appMap,
      artifactPaths.actionCatalog,
      artifactPaths.demoBrief,
      artifactPaths.flowSpec,
    ],
    instructions: [
      "Plan one short demo flow from the AppMap, ActionCatalog, and demo brief.",
      "Write a valid FlowSpec JSON object to /workspace/.makeademo/flow-spec.json.",
      "The FlowSpec must include a non-empty steps array, selectedFlowName, objective, referenced route paths, referenced action IDs, expected visible assertions, and repair constraints.",
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
      artifactPaths.demoScript,
    ],
    instructions: [
      "Write the final capture-ready Demo Script JSON.",
      "Do not edit app source files. Only write /workspace/.makeademo/demo-script.json.",
      "The JSON must conform to the Capture SDK contract: version, scriptId, title, format 16:9, scenes, demoPlaywrightScript, and presentation.",
      "The demoPlaywrightScript must import { setup, scene } from './makeademo-capture-sdk', use the provided baseUrl, avoid external URLs, and include visible assertions.",
      "Use scene IDs that match the scenes array and presentation overlays.",
      `Target demo length seconds: ${input.demoBrief.demoLengthSeconds ?? 30}`,
      `Demo brief: ${JSON.stringify(input.demoBrief)}`,
    ].join("\n"),
    stage: "script-writing",
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

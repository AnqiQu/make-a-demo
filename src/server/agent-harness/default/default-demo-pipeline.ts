import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureScenesFromScript } from "../../pipeline/06-footage-capture/capture-scenes";
import type { CaptureManifest } from "../../pipeline/06-footage-capture/capture-scenes";
import { demoScriptLimits } from "../../pipeline/06-footage-capture/demo-script.schema";
import {
  type CompositeVideoFromScriptInput,
  type CompositedVideoManifest,
  compositeVideoFromScript,
} from "../../pipeline/07-compositing/composite-video";
import { createGitHubAppIntegrationFromEnv } from "../../shared/integrations/github/github-app";
import {
  type PipelineEventLogger,
  createFilePipelineLogSink,
  createPipelineEventLogger,
  createPrettyPipelineLogSink,
} from "../../shared/logging/pipeline-event-logger";
import type { AgentHarnessWorkspaceHandle } from "../daytona/workspace.interface";
import {
  type AgentHarnessPipelineDependencies,
  type AgentHarnessPipelineResult,
  runAgentHarnessPipeline,
} from "../orchestration/agent-harness";
import type { BulkTransferLimiter } from "./bulk-transfer-limiter";
import {
  type DefaultHarnessDependencies,
  createDefaultAgentHarnessDependencies,
} from "./default-harness-dependencies";
import { assertSafeGithubRepoUrl } from "./github-repo-url";
import {
  LocalJsonArtifactStore,
  writeJsonFile,
} from "./local-json-artifact-store";
import {
  type GithubInstallationTokenProvider,
  type RepoSnapshot,
  type RepoSourceArchive,
  readGithubRepoSnapshot,
} from "./repo-snapshot";
import {
  type AgentHarnessRetryPolicy,
  readAgentHarnessRetryPolicy,
} from "./retry-policy";

export type DefaultDemoPipelineInput = {
  demoLengthSeconds: number;
  githubInstallationId?: string;
  importantFeatures: string[];
  normalizedSupportingDocuments?: Array<Record<string, unknown>>;
  preferredAppDir?: string;
  productSummary?: string;
  repoUrl: string;
  targetUsers?: string;
};

export type DefaultDemoPipelineResult = {
  artifactDirectory: string;
  captureManifestPath: string;
  compositeManifestPath: string;
  finalVideoPath: string;
  logPath: string;
  pipelineManifestPath: string;
  runDirectory: string;
  scriptPath: string;
};

export type DefaultDemoPipelineOptions = {
  /**
   * Shared by every pipeline in a batch to run bulk transfers (the clone
   * plus archive, and the screened-archive upload) one at a time; solo runs
   * omit it and transfer immediately.
   */
  bulkTransferLimiter?: BulkTransferLimiter;
  captureScenes?: typeof captureScenesFromScript;
  compositeVideo?: typeof compositeVideoFromScript;
  createHarnessDependencies?: (input: {
    artifactStore: LocalJsonArtifactStore;
    bulkTransferLimiter?: BulkTransferLimiter;
    env?: Record<string, string | undefined>;
    logger: PipelineEventLogger;
    outputRoot: string;
    repoSourceArchive: RepoSourceArchive;
    retryPolicy: AgentHarnessRetryPolicy;
    staticImageAssets?: CompositeVideoFromScriptInput["staticImageAssets"];
  }) => Promise<DefaultHarnessDependencies>;
  env?: Record<string, string | undefined>;
  installationTokenProvider?: GithubInstallationTokenProvider;
  outputRoot?: string;
  readRepoSnapshot?: typeof readGithubRepoSnapshot;
  retryPolicy?: Partial<AgentHarnessRetryPolicy>;
  runHarnessPipeline?: typeof runAgentHarnessPipeline;
  runId?: string;
  staticImageAssets?: CompositeVideoFromScriptInput["staticImageAssets"];
};

const defaultOutputRoot = ".makeademo-terminal-runs";

export async function runDefaultDemoPipeline(
  input: DefaultDemoPipelineInput,
  options: DefaultDemoPipelineOptions = {},
): Promise<DefaultDemoPipelineResult> {
  assertSafeGithubRepoUrl(input.repoUrl);
  assertRequestedFeaturesFitSceneBudget(input.importantFeatures);

  const runId = options.runId ?? createRunId();
  const outputRoot = options.outputRoot ?? defaultOutputRoot;
  const retryPolicy = readAgentHarnessRetryPolicy(
    options.env ?? process.env,
    options.retryPolicy,
  );
  const runDirectory = join(outputRoot, runId);
  const artifactDirectory = join(runDirectory, "artifacts");
  const logPath = join(runDirectory, "pipeline-log.jsonl");
  const scriptPath = join(runDirectory, "demo-script.json");
  await mkdir(artifactDirectory, { recursive: true });

  const logger = createPipelineEventLogger({
    base: { component: "default-demo-pipeline", runId },
    sinks: [
      createFilePipelineLogSink(logPath),
      createPrettyPipelineLogSink({
        write: (text) => process.stdout.write(text),
      }),
    ],
  });
  const log = async (event: string, fields: Record<string, unknown> = {}) => {
    await logger.info({ event, ...fields });
  };

  await log("pipeline.started", {
    demoLengthSeconds: input.demoLengthSeconds,
    repoUrl: input.repoUrl,
  });
  await writeJsonFile(join(runDirectory, "input.json"), input);

  const installationTokenProvider =
    input.githubInstallationId === undefined
      ? undefined
      : (options.installationTokenProvider ??
        createGitHubAppIntegrationFromEnv());
  const bulkTransferLimiter: BulkTransferLimiter =
    options.bulkTransferLimiter ?? { run: (task) => task() };
  const repoSnapshot = await bulkTransferLimiter.run(() =>
    (options.readRepoSnapshot ?? readGithubRepoSnapshot)(
      {
        ...(input.githubInstallationId === undefined
          ? {}
          : { githubInstallationId: input.githubInstallationId }),
        log,
        repoUrl: input.repoUrl,
        runDirectory,
      },
      {
        ...(installationTokenProvider === undefined
          ? {}
          : {
              installationTokenProvider,
            }),
      },
    ),
  );
  await writeRepoSnapshotSummary(runDirectory, repoSnapshot);

  const artifactStore = new LocalJsonArtifactStore(artifactDirectory, log);
  const harnessDependencies = await (
    options.createHarnessDependencies ?? createDefaultAgentHarnessDependencies
  )({
    artifactStore,
    ...(options.bulkTransferLimiter === undefined
      ? {}
      : { bulkTransferLimiter: options.bulkTransferLimiter }),
    ...(options.env === undefined ? {} : { env: options.env }),
    logger,
    outputRoot: runDirectory,
    repoSourceArchive: repoSnapshot.sourceArchive,
    retryPolicy,
    ...(options.staticImageAssets === undefined
      ? {}
      : { staticImageAssets: options.staticImageAssets }),
  });
  const workspaceHandle = () => harnessDependencies.getWorkspaceHandle();
  let cleanupFailure: unknown;
  let completedResult: DefaultDemoPipelineResult | undefined;
  let primaryFailure: unknown;

  try {
    const pipelineResult = await (
      options.runHarnessPipeline ?? runAgentHarnessPipeline
    )(
      {
        ...(repoSnapshot.commitSha === undefined
          ? {}
          : { commitSha: repoSnapshot.commitSha }),
        demoBrief: {
          demoLengthSeconds: input.demoLengthSeconds,
          keyProductFeatures: input.importantFeatures,
          ...(input.preferredAppDir === undefined
            ? {}
            : { preferredAppDir: input.preferredAppDir }),
          ...(input.productSummary === undefined
            ? {}
            : { productSummary: input.productSummary }),
          ...(input.targetUsers === undefined
            ? {}
            : { targetUsers: input.targetUsers }),
        },
        files: repoSnapshot.files,
        ...(input.normalizedSupportingDocuments === undefined
          ? {}
          : {
              normalizedSupportingDocuments:
                input.normalizedSupportingDocuments,
            }),
        repoUrl: input.repoUrl,
        runId,
        secretQuarantineManifest: repoSnapshot.secretQuarantineManifest,
      },
      harnessDependencies.dependencies,
      {
        destroyWorkspaceOnCompletion: false,
        jobDeadlineMs: retryPolicy.jobDeadlineMinutes * 60_000,
        repoPreparationRepairLimit: retryPolicy.repoPreparationRepairs,
        scriptRepairLimit: retryPolicy.scriptRepairs,
      },
    );
    assertHarnessPassed(pipelineResult, logPath);

    const scriptPackage = pipelineResult.scriptCandidate?.scriptJsonContent;
    if (scriptPackage === undefined) {
      throw new Error("Default demo pipeline passed without a Demo Script.");
    }
    await writeJsonFile(scriptPath, scriptPackage);

    const captureManifest = await runFootageCapture({
      captureScenes: options.captureScenes ?? captureScenesFromScript,
      externalResourceCache: harnessDependencies.getExternalResourceCache?.(),
      pipelineResult,
      runDirectory,
      scriptPackage,
      workspaceHandle: requireWorkspaceHandle(workspaceHandle()),
    });
    const compositeManifest = await runCompositing({
      captureManifest,
      compositeVideo: options.compositeVideo ?? compositeVideoFromScript,
      runDirectory,
      scriptPath,
      ...(options.staticImageAssets === undefined
        ? {}
        : { staticImageAssets: options.staticImageAssets }),
    });
    if (compositeManifest.outputVideoPath === undefined) {
      throw new Error("Compositing did not retain a local final video.");
    }

    const pipelineManifestPath = artifactStore.resolveArtifactPath(
      "/workspace/.makeademo/pipeline-run-manifest.json",
    );
    completedResult = {
      artifactDirectory,
      captureManifestPath: captureManifest.manifestPath,
      compositeManifestPath: compositeManifest.manifestPath,
      finalVideoPath: compositeManifest.outputVideoPath,
      logPath,
      pipelineManifestPath,
      runDirectory,
      scriptPath,
    };
  } catch (error) {
    primaryFailure = error;
    try {
      await logger.error({
        error: error instanceof Error ? error.message : String(error),
        event: "pipeline.failed",
      });
      await logger.flush();
    } catch {
      // Preserve the pipeline failure when observability is unavailable.
    }
  } finally {
    const handle = workspaceHandle();
    try {
      await persistSandboxLogs(handle, runDirectory, logger);
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await handle?.destroy();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== undefined) {
      attachCleanupFailure(primaryFailure, cleanupFailure);
      try {
        await logger.warn({
          error:
            cleanupFailure instanceof Error
              ? cleanupFailure.message
              : String(cleanupFailure),
          event: "sandbox.cleanup.failed",
        });
        await logger.flush();
      } catch {
        // Preserve the primary pipeline or cleanup failure.
      }
    }
  }

  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  if (completedResult === undefined) {
    throw new Error("Default demo pipeline finished without a result.");
  }
  await log("pipeline.succeeded", {
    captureManifestPath: completedResult.captureManifestPath,
    compositeManifestPath: completedResult.compositeManifestPath,
    finalVideoPath: completedResult.finalVideoPath,
    pipelineManifestPath: completedResult.pipelineManifestPath,
    scriptPath: completedResult.scriptPath,
  });
  await logger.flush();
  return completedResult;
}

function assertRequestedFeaturesFitSceneBudget(features: string[]): void {
  const maxRequestedFeatures = Math.floor((demoScriptLimits.maxScenes - 2) / 2);
  if (features.length > maxRequestedFeatures) {
    throw new Error(
      `A demo can include at most ${maxRequestedFeatures} requested features so every feature retains an introduction and demonstration Scene.`,
    );
  }
  const normalized = features.map((feature) =>
    feature.trim().replaceAll(/\s+/g, " ").toLowerCase(),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Requested demo features must be unique");
  }
}

function attachCleanupFailure(
  primaryFailure: unknown,
  cleanupFailure: unknown,
): void {
  if (
    (typeof primaryFailure !== "object" || primaryFailure === null) &&
    typeof primaryFailure !== "function"
  ) {
    return;
  }
  try {
    Reflect.set(primaryFailure, "cleanupError", cleanupFailure);
  } catch {
    // The primary error remains authoritative when it is non-extensible.
  }
}

async function persistSandboxLogs(
  handle: AgentHarnessWorkspaceHandle | undefined,
  runDirectory: string,
  logger: PipelineEventLogger,
): Promise<void> {
  if (handle === undefined) {
    return;
  }

  try {
    const lines = await handle.workspace.collectSandboxLogs();
    const path = join(runDirectory, "sandbox-log.jsonl");
    await writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    await logger.info({
      event: "sandbox.logs.persisted",
      lineCount: lines.length,
      path,
    });
    await logger.flush();
  } catch (error) {
    await logger.warn({
      error: error instanceof Error ? error.message : String(error),
      event: "sandbox.logs.persistence.failed",
    });
    await logger.flush();
  }
}

async function runFootageCapture(input: {
  captureScenes: typeof captureScenesFromScript;
  externalResourceCache?: ReturnType<
    NonNullable<DefaultHarnessDependencies["getExternalResourceCache"]>
  >;
  pipelineResult: AgentHarnessPipelineResult;
  runDirectory: string;
  scriptPackage: unknown;
  workspaceHandle: AgentHarnessWorkspaceHandle;
}): Promise<CaptureManifest> {
  return await input.captureScenes({
    baseUrl:
      input.pipelineResult.preparationManifest?.baseUrl ??
      "http://127.0.0.1:3000",
    keepTemp: false,
    captureRuntimeReset: readCaptureRuntimeResetProof(input.pipelineResult),
    ...(input.externalResourceCache === undefined
      ? {}
      : { externalResourceCache: input.externalResourceCache }),
    preparationWorkspace: input.workspaceHandle,
    runId: "capture",
    scriptPackage: input.scriptPackage,
    tempRoot: input.runDirectory,
  });
}

function readCaptureRuntimeResetProof(
  pipelineResult: AgentHarnessPipelineResult,
) {
  const report = [...pipelineResult.validationReports]
    .reverse()
    .find((candidate) => candidate.stage === "capture-runtime-reset");
  if (report?.status !== "passed") {
    throw new Error(
      "Default demo pipeline cannot capture without a passed capture-runtime-reset report.",
    );
  }
  const artifactPath =
    pipelineResult.pipelineRunManifest.artifactPaths.captureRuntimeReset;
  if (artifactPath === undefined || artifactPath.trim().length === 0) {
    throw new Error(
      "Passed capture-runtime-reset report is missing its durable artifact path.",
    );
  }
  return {
    artifactPath,
    stage: "capture-runtime-reset" as const,
    status: "passed" as const,
  };
}

async function runCompositing(input: {
  captureManifest: CaptureManifest;
  compositeVideo: typeof compositeVideoFromScript;
  runDirectory: string;
  scriptPath: string;
  staticImageAssets?: CompositeVideoFromScriptInput["staticImageAssets"];
}): Promise<CompositedVideoManifest> {
  return await input.compositeVideo({
    captureManifestPath: input.captureManifest.manifestPath,
    outputRoot: input.runDirectory,
    projectRoot: process.cwd(),
    retainLocalOutput: true,
    runId: "composite",
    scriptPath: input.scriptPath,
    ...(input.staticImageAssets === undefined
      ? {}
      : { staticImageAssets: input.staticImageAssets }),
  });
}

function assertHarnessPassed(
  pipelineResult: AgentHarnessPipelineResult,
  logPath: string,
): void {
  if (pipelineResult.status !== "passed") {
    throw new Error(
      `Default demo pipeline failed with status ${pipelineResult.status}. See ${logPath}.`,
    );
  }
}

async function writeRepoSnapshotSummary(
  runDirectory: string,
  repoSnapshot: RepoSnapshot,
): Promise<void> {
  await writeJsonFile(join(runDirectory, "repo-snapshot.json"), {
    commitSha: repoSnapshot.commitSha,
    files: repoSnapshot.files.map((file) => ({
      path: file.path,
      textBytes: file.text?.length ?? 0,
    })),
    repoStats: repoSnapshot.repoStats,
    secretQuarantineManifest: repoSnapshot.secretQuarantineManifest,
    sourceArchive: repoSnapshot.sourceArchive,
  });
}

function requireWorkspaceHandle(
  handle: AgentHarnessWorkspaceHandle | undefined,
): AgentHarnessWorkspaceHandle {
  if (handle === undefined) {
    throw new Error(
      "Default demo pipeline did not create a Daytona workspace.",
    );
  }
  return handle;
}

function createRunId(): string {
  return `terminal-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

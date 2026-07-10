import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureScenesFromScript } from "../../pipeline/06-footage-capture/capture-scenes";
import type { CaptureManifest } from "../../pipeline/06-footage-capture/capture-scenes";
import {
  type CompositedVideoManifest,
  compositeVideoFromScript,
} from "../../pipeline/07-compositing/composite-video";
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
import {
  type DefaultHarnessDependencies,
  createDefaultAgentHarnessDependencies,
} from "./default-harness-dependencies";
import { assertSafeGithubRepoUrl } from "./github-repo-url";
import {
  LocalJsonArtifactStore,
  writeJsonFile,
} from "./local-json-artifact-store";
import { type RepoSnapshot, readGithubRepoSnapshot } from "./repo-snapshot";

export type DefaultDemoPipelineInput = {
  demoLengthSeconds: number;
  importantFeatures: string[];
  normalizedSupportingDocuments?: Array<Record<string, unknown>>;
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
  captureScenes?: typeof captureScenesFromScript;
  compositeVideo?: typeof compositeVideoFromScript;
  createHarnessDependencies?: (input: {
    artifactStore: LocalJsonArtifactStore;
    logger: PipelineEventLogger;
    outputRoot: string;
  }) => Promise<DefaultHarnessDependencies>;
  outputRoot?: string;
  readRepoSnapshot?: typeof readGithubRepoSnapshot;
  runHarnessPipeline?: typeof runAgentHarnessPipeline;
  runId?: string;
};

const defaultOutputRoot = ".makeademo-terminal-runs";

export async function runDefaultDemoPipeline(
  input: DefaultDemoPipelineInput,
  options: DefaultDemoPipelineOptions = {},
): Promise<DefaultDemoPipelineResult> {
  assertSafeGithubRepoUrl(input.repoUrl);

  const runId = options.runId ?? createRunId();
  const outputRoot = options.outputRoot ?? defaultOutputRoot;
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

  const repoSnapshot = await (
    options.readRepoSnapshot ?? readGithubRepoSnapshot
  )({
    log,
    repoUrl: input.repoUrl,
    runDirectory,
  });
  await writeRepoSnapshotSummary(runDirectory, repoSnapshot);

  const artifactStore = new LocalJsonArtifactStore(artifactDirectory, log);
  const harnessDependencies = await (
    options.createHarnessDependencies ?? createDefaultAgentHarnessDependencies
  )({
    artifactStore,
    logger,
    outputRoot: runDirectory,
  });
  const workspaceHandle = () => harnessDependencies.getWorkspaceHandle();

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
        repoStats: repoSnapshot.repoStats,
        repoUrl: input.repoUrl,
        runId,
      },
      harnessDependencies.dependencies,
      { destroyWorkspaceOnCompletion: false },
    );
    assertHarnessPassed(pipelineResult, logPath);

    const scriptPackage = pipelineResult.scriptCandidate?.scriptJsonContent;
    if (scriptPackage === undefined) {
      throw new Error("Default demo pipeline passed without a Demo Script.");
    }
    await writeJsonFile(scriptPath, scriptPackage);

    const captureManifest = await runFootageCapture({
      captureScenes: options.captureScenes ?? captureScenesFromScript,
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
    });
    if (compositeManifest.outputVideoPath === undefined) {
      throw new Error("Compositing did not retain a local final video.");
    }

    const pipelineManifestPath = artifactStore.resolveArtifactPath(
      "/workspace/.makeademo/pipeline-run-manifest.json",
    );
    await log("pipeline.succeeded", {
      captureManifestPath: captureManifest.manifestPath,
      compositeManifestPath: compositeManifest.manifestPath,
      finalVideoPath: compositeManifest.outputVideoPath,
      pipelineManifestPath,
      scriptPath,
    });
    await logger.flush();

    return {
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
    try {
      await logger.error({
        error: error instanceof Error ? error.message : String(error),
        event: "pipeline.failed",
      });
      await logger.flush();
    } catch {
      // Preserve the pipeline failure when observability is unavailable.
    }
    throw error;
  } finally {
    const handle = workspaceHandle();
    let cleanupFailure: unknown;
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
}

async function persistSandboxLogs(
  handle: AgentHarnessWorkspaceHandle | undefined,
  runDirectory: string,
  logger: PipelineEventLogger,
): Promise<void> {
  if (handle?.workspace.collectSandboxLogs === undefined) {
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
  pipelineResult: AgentHarnessPipelineResult;
  runDirectory: string;
  scriptPackage: unknown;
  workspaceHandle: AgentHarnessWorkspaceHandle;
}): Promise<CaptureManifest> {
  return await input.captureScenes({
    baseUrl:
      input.pipelineResult.preparationManifest?.baseUrl ??
      "http://127.0.0.1:3000",
    keepTemp: true,
    preparationWorkspace: input.workspaceHandle,
    runId: "capture",
    scriptPackage: input.scriptPackage,
    tempRoot: input.runDirectory,
  });
}

async function runCompositing(input: {
  captureManifest: CaptureManifest;
  compositeVideo: typeof compositeVideoFromScript;
  runDirectory: string;
  scriptPath: string;
}): Promise<CompositedVideoManifest> {
  return await input.compositeVideo({
    captureManifestPath: input.captureManifest.manifestPath,
    outputRoot: input.runDirectory,
    projectRoot: process.cwd(),
    retainLocalOutput: true,
    runId: "composite",
    scriptPath: input.scriptPath,
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

import { mkdir } from "node:fs/promises";
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
import {
  LocalJsonArtifactStore,
  writeJsonFile,
} from "./local-json-artifact-store";
import { type RepoSnapshot, readGithubRepoSnapshot } from "./repo-snapshot";

export type DefaultDemoPipelineInput = {
  demoLengthSeconds: number;
  importantFeatures: string[];
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
  assertGithubRepoUrl(input.repoUrl);

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
    await logger.error({
      error: error instanceof Error ? error.message : String(error),
      event: "pipeline.failed",
    });
    await logger.flush();
    throw error;
  } finally {
    await workspaceHandle()?.destroy();
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

function assertGithubRepoUrl(repoUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error("GitHub repo URL must be a valid https://github.com URL.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parts.length < 2
  ) {
    throw new Error(
      "GitHub repo URL must be a valid https://github.com owner/repo URL.",
    );
  }
}

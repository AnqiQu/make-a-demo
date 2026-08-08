import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  downloadSubmittedCodeArchive,
  uploadSubmittedCodeArchive,
} from "../../agent-harness/daytona/submitted-code-artifact-archive";
import { uploadSubmittedCodeExternalResourceCache } from "../../agent-harness/daytona/submitted-code-external-resource-cache";
import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceHandle,
} from "../../agent-harness/daytona/workspace.interface";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { shellQuote } from "../../shared/shell/shell-quote";
import {
  CAPTURE_COMMAND_TIMEOUT_MS,
  CAPTURE_SCRIPT_TIMEOUT_MS,
} from "./capture-execution-budget";
import {
  type CaptureRuntimeProtocol,
  formatCaptureRuntimeProtocolLog,
  readCaptureRuntimeProtocol,
  readSuccessfulCaptureProtocol,
} from "./capture-runtime-protocol";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-contract";
import type {
  RecordSceneInput,
  RecordedScene,
  SceneRecorder,
} from "./scene-recorder.interface";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

const interactiveSceneHoldMs = 1_000;
const staticRevealSceneHoldMs = 3_000;
const staticRevealActionTypes = new Set([
  "assert-text",
  "assert-title",
  "assert-url",
  "assert-visible",
  "goto",
]);

export type SceneClipTrimmer = (input: {
  durationMs: number;
  outputVideoPath: string;
  rawTakePath: string;
  sceneId: string;
  startMs: number;
}) => Promise<{ durationSeconds: number }>;

type SceneScriptResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export class PreparedWorkspacePlaywrightSceneRecorder implements SceneRecorder {
  private readonly clipTrimmer: SceneClipTrimmer;
  private readonly headed: boolean;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;

  constructor(
    private readonly options: {
      clipTrimmer?: SceneClipTrimmer;
      headed?: boolean;
      externalResourceCache?: {
        directory: string;
        manifest: ExternalResourceManifest;
      };
      postRollMs?: number;
      preRollMs?: number;
      preparationWorkspace: AgentHarnessWorkspaceHandle;
      sceneTimeoutMs?: number;
    },
  ) {
    this.clipTrimmer = options.clipTrimmer ?? trimSceneClipWithFfmpeg;
    this.headed = options.headed ?? false;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? CAPTURE_SCRIPT_TIMEOUT_MS;
  }

  async recordScenes(input: RecordSceneInput): Promise<RecordedScene[]> {
    const sceneHoldMsById = createSceneHoldMsById(input.scenes);
    const captureTimeoutMs =
      this.sceneTimeoutMs + sumSceneHoldMs(sceneHoldMsById);
    const workspace = this.options.preparationWorkspace.workspace;
    const runId = basename(input.runDirectory);
    const remoteRunDirectory = `/workspace/.makeademo/footage-capture-runs/${runId}`;
    const remoteSceneWorkspace = `${remoteRunDirectory}/work/continuous-take`;
    const remoteVideoScratchDirectory = `${remoteSceneWorkspace}/playwright-videos`;
    const remoteRawScenesDirectory = `${remoteRunDirectory}/raw-scenes`;
    const remoteScenePath = `${remoteSceneWorkspace}/demo-script.ts`;
    const remoteRawTakePath = `${remoteRawScenesDirectory}/continuous-take.webm`;
    const localSceneWorkspace = join(
      input.runDirectory,
      "work",
      "continuous-take",
    );
    const localRawScenesDirectory = join(input.runDirectory, "raw-scenes");
    const localSceneClipsDirectory = join(input.runDirectory, "scene-clips");
    const localScenePath = join(localSceneWorkspace, "demo-script.ts");
    const markerLogPath = join(input.runDirectory, "scene-markers.jsonl");
    await mkdir(localSceneWorkspace, { recursive: true });
    await mkdir(localRawScenesDirectory, { recursive: true });
    await mkdir(localSceneClipsDirectory, { recursive: true });
    await writeGeneratedCaptureSdkHarness(localSceneWorkspace);
    await validateDemoScriptCaptureSdkTypes({
      demoPlaywrightScript: input.demoPlaywrightScript,
      directory: localSceneWorkspace,
    });
    await writeFile(
      localScenePath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        ...(input.externalResourceManifest === undefined
          ? {}
          : { externalResourceManifest: input.externalResourceManifest }),
        headed: this.headed,
        sceneHoldMsById,
        videoDirectory: remoteVideoScratchDirectory,
      }),
    );

    if (this.options.externalResourceCache !== undefined) {
      await uploadSubmittedCodeExternalResourceCache({
        directory: this.options.externalResourceCache.directory,
        manifest: this.options.externalResourceCache.manifest,
        workspace,
      });
    }

    // A retried capture must never inherit a prior attempt's scratch: a stale
    // Playwright video would make the single-take lookup ambiguous.
    await workspace.executeSubmittedCode(
      `rm -rf ${shellQuote(remoteRunDirectory)}`,
    );
    await workspace.executeSubmittedCode(
      `mkdir -p ${shellQuote(remoteSceneWorkspace)} ${shellQuote(remoteVideoScratchDirectory)} ${shellQuote(remoteRawScenesDirectory)}`,
    );
    await uploadSubmittedCodeArchive({
      archiveName: "capture-inputs.tgz",
      entries: [
        "makeademo-capture-sdk.js",
        "makeademo-capture-sdk.d.ts",
        "makeademo-capture-sdk.instructions.md",
        "demo-script.contract.ts",
        "demo-script.ts",
      ],
      localDirectory: localSceneWorkspace,
      remoteDirectory: remoteSceneWorkspace,
      workspace,
    });

    const result = await workspace.executeSubmittedCode(
      `cd ${shellQuote(remoteSceneWorkspace)} && NODE_PATH="\${MAKEADEMO_TOOLS_NODE_MODULES:-$(npm root -g)}" timeout -k 10s ${Math.ceil(captureTimeoutMs / 1000)}s bun ${shellQuote(remoteScenePath)}`,
      {
        timeoutMs:
          captureTimeoutMs +
          (CAPTURE_COMMAND_TIMEOUT_MS - CAPTURE_SCRIPT_TIMEOUT_MS),
      },
    );
    const protocol = readCaptureRuntimeProtocol(result);
    await Promise.all([
      writeFile(markerLogPath, formatCaptureRuntimeProtocolLog(protocol)),
      writeFile(join(input.runDirectory, "stdout.log"), result.stdout),
      writeFile(join(input.runDirectory, "stderr.log"), result.stderr),
    ]);
    const appStatus = await workspace.readSubmittedCodeAppStatus();
    const appOutput = [appStatus.stderr, appStatus.stdout]
      .filter((value) => value.length > 0)
      .join("\n");
    await writeFile(
      join(input.runDirectory, "submitted-app-runtime.log"),
      appOutput,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        formatSceneFailure(
          "continuous-take",
          {
            ...result,
            // 124 is timeout's own exit; 137 is its SIGKILL escalation after
            // the grace period (also the OOM-kill signature).
            timedOut: result.exitCode === 124 || result.exitCode === 137,
          },
          input.runDirectory,
        ),
      );
    }

    const remoteRecordedVideoPath = await findSingleRemoteVideo({
      directory: remoteVideoScratchDirectory,
      workspace,
    });
    await workspace.executeSubmittedCode(
      `rm -f ${shellQuote(remoteRawTakePath)} && mv ${shellQuote(remoteRecordedVideoPath)} ${shellQuote(remoteRawTakePath)}`,
    );

    // Encoding never runs in the sandbox: it competes for memory with the
    // dev server there, and a sandbox-side encode can be OOM-killed while
    // still reporting exit 0. Download the raw take and trim locally, so the
    // clips compositing consumes are the ones that were probed.
    await downloadSubmittedCodeArchive({
      archiveName: "capture-outputs.tar",
      compression: "none",
      entries: ["raw-scenes/continuous-take.webm"],
      localDirectory: input.runDirectory,
      remoteDirectory: remoteRunDirectory,
      workspace,
    });

    return trimRecordedScenes({
      clipTrimmer: this.clipTrimmer,
      postRollMs: this.postRollMs,
      preRollMs: this.preRollMs,
      protocol,
      rawTakePath: join(localRawScenesDirectory, "continuous-take.webm"),
      recordInput: input,
      sceneClipsDirectory: localSceneClipsDirectory,
    });
  }
}

/**
 * Derives per-Scene clip ranges from the capture protocol markers and trims
 * each clip out of the raw take, deleting the raw take afterwards unless the
 * caller retains it for diagnostics.
 */
async function trimRecordedScenes(input: {
  clipTrimmer: SceneClipTrimmer;
  postRollMs: number;
  preRollMs: number;
  protocol: CaptureRuntimeProtocol;
  rawTakePath: string;
  recordInput: RecordSceneInput;
  sceneClipsDirectory: string;
}): Promise<RecordedScene[]> {
  const sceneIds = input.recordInput.scenes.map((scene) => scene.id);
  const markerRanges = readSuccessfulCaptureProtocol({
    expectedStepIdsByScene: expectedStepIdsByScene(input.recordInput),
    protocol: input.protocol,
    requireValidationLifecycle: false,
    requireVisibleAssertions: false,
    sceneIds,
  }).sceneRanges;
  const clipRanges = createNonOverlappingClipRanges({
    markerRanges,
    postRollMs: input.postRollMs,
    preRollMs: input.preRollMs,
    sceneIds,
  });
  const recordedScenes: RecordedScene[] = [];

  for (const scene of input.recordInput.scenes) {
    const range = markerRanges.get(scene.id);
    if (range === undefined) {
      throw new Error(`Scene ${scene.id} did not emit complete markers.`);
    }

    const clipRange = clipRanges.get(scene.id);
    if (clipRange === undefined) {
      throw new Error(`Scene ${scene.id} did not receive a clip range.`);
    }
    const { endMs, startMs } = clipRange;
    const outputVideoPath = join(input.sceneClipsDirectory, `${scene.id}.webm`);
    const trimResult = await input.clipTrimmer({
      durationMs: endMs - startMs,
      outputVideoPath,
      rawTakePath: input.rawTakePath,
      sceneId: scene.id,
      startMs,
    });

    recordedScenes.push({
      durationSeconds: trimResult.durationSeconds,
      markerEndMs: range.endedAtMs,
      markerStartMs: range.startedAtMs,
      sceneId: scene.id,
      sectionId: input.recordInput.sectionId,
      videoPath: outputVideoPath,
    });
  }

  if (input.recordInput.retainRawTake === false) {
    await rm(input.rawTakePath, { force: true });
  }

  return recordedScenes;
}

function createNonOverlappingClipRanges(input: {
  markerRanges: ReadonlyMap<string, { endedAtMs: number; startedAtMs: number }>;
  postRollMs: number;
  preRollMs: number;
  sceneIds: readonly string[];
}) {
  const ranges = new Map<string, { endMs: number; startMs: number }>();

  for (const sceneId of input.sceneIds) {
    const markerRange = input.markerRanges.get(sceneId);
    if (markerRange === undefined) {
      continue;
    }
    ranges.set(sceneId, {
      endMs: markerRange.endedAtMs + input.postRollMs,
      startMs: Math.max(0, markerRange.startedAtMs - input.preRollMs),
    });
  }

  for (
    let sceneIndex = 1;
    sceneIndex < input.sceneIds.length;
    sceneIndex += 1
  ) {
    const previousSceneId = input.sceneIds[sceneIndex - 1] as string;
    const sceneId = input.sceneIds[sceneIndex] as string;
    const previousClip = ranges.get(previousSceneId);
    const clip = ranges.get(sceneId);
    if (previousClip === undefined || clip === undefined) {
      continue;
    }
    if (previousClip.endMs <= clip.startMs) {
      continue;
    }

    const previousMarker = input.markerRanges.get(previousSceneId);
    const marker = input.markerRanges.get(sceneId);
    if (previousMarker === undefined || marker === undefined) {
      continue;
    }
    const sharedBoundaryMs = Math.floor(
      (previousMarker.endedAtMs + marker.startedAtMs) / 2,
    );
    previousClip.endMs = Math.max(previousClip.startMs + 1, sharedBoundaryMs);
    clip.startMs = Math.min(clip.endMs - 1, previousClip.endMs);
  }

  return ranges;
}

function createSceneHoldMsById(
  scenes: RecordSceneInput["scenes"],
): Record<string, number> {
  return Object.fromEntries(
    scenes.map((scene) => [
      scene.id,
      scene.actions?.every((action) => staticRevealActionTypes.has(action.type))
        ? staticRevealSceneHoldMs
        : interactiveSceneHoldMs,
    ]),
  );
}

function sumSceneHoldMs(sceneHoldMsById: Readonly<Record<string, number>>) {
  return Object.values(sceneHoldMsById).reduce(
    (total, holdMs) => total + holdMs,
    0,
  );
}

function expectedStepIdsByScene(input: RecordSceneInput) {
  return Object.fromEntries([
    ["setup", input.setupActions?.map((action) => action.id) ?? []],
    ...input.scenes.map((scene) => [
      scene.id,
      scene.actions?.map((action) => action.id) ?? [],
    ]),
  ]);
}

async function trimSceneClipWithFfmpeg(input: {
  durationMs: number;
  outputVideoPath: string;
  rawTakePath: string;
  sceneId: string;
  startMs: number;
}): Promise<{ durationSeconds: number }> {
  const durationSeconds = input.durationMs / 1000;
  const result = await runCommand("ffmpeg", [
    "-y",
    "-i",
    input.rawTakePath,
    "-ss",
    (input.startMs / 1000).toFixed(3),
    "-t",
    durationSeconds.toFixed(3),
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-crf",
    "30",
    "-b:v",
    "0",
    input.outputVideoPath,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to trim Scene ${input.sceneId} with ffmpeg.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }

  return {
    durationSeconds: await probeVideoDurationSeconds(input.outputVideoPath),
  };
}

async function probeVideoDurationSeconds(videoPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to probe trimmed Scene clip duration.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }

  const durationSeconds = Number(result.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${videoPath}`);
  }

  return durationSeconds;
}

const maxSceneFailureDetailLength = 1_600;

/**
 * The failure carries a bounded excerpt and points at the retained logs: the
 * full streams already live in the run directory, so inlining them would
 * only bloat every downstream record with the same bytes.
 */
function formatSceneFailure(
  sceneId: string,
  result: SceneScriptResult,
  runDirectory: string,
) {
  const details = [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n")
    .slice(0, maxSceneFailureDetailLength);
  const logsNote = `Full output: ${join(runDirectory, "stdout.log")}, ${join(runDirectory, "stderr.log")}.`;
  const summary = result.timedOut
    ? `Scene ${sceneId} timed out.`
    : `Scene ${sceneId} failed with exit code ${result.exitCode}.`;

  return [summary, ...(details.length > 0 ? [details] : []), logsNote].join(
    "\n",
  );
}

async function runCommand(command: string, args: string[]) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

async function findSingleRemoteVideo(input: {
  directory: string;
  workspace: AgentHarnessWorkspace;
}) {
  const result = await input.workspace.executeSubmittedCode(
    `find ${shellQuote(input.directory)} -type f -name '*.webm' | sort`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to find Playwright video in ${input.directory}.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }

  const videos = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (videos.length === 0) {
    throw new Error(`No Playwright video was created in ${input.directory}`);
  }
  if (videos.length > 1) {
    throw new Error(
      `Expected one Playwright video in ${input.directory}, found ${videos.length}`,
    );
  }

  const video = videos[0];
  if (video === undefined) {
    throw new Error(`No Playwright video was created in ${input.directory}`);
  }

  return video;
}

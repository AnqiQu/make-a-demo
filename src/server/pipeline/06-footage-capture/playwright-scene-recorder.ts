import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  downloadSubmittedCodeArchive,
  uploadSubmittedCodeArchive,
} from "../../agent-harness/daytona/submitted-code-artifact-archive";
import { executeSubmittedCode } from "../../agent-harness/daytona/submitted-code-execution";
import { uploadSubmittedCodeExternalResourceCache } from "../../agent-harness/daytona/submitted-code-external-resource-cache";
import type {
  AgentHarnessWorkspace,
  AgentHarnessWorkspaceHandle,
} from "../../agent-harness/daytona/workspace.interface";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import {
  CAPTURE_COMMAND_TIMEOUT_MS,
  CAPTURE_SCRIPT_TIMEOUT_MS,
} from "./capture-execution-budget";
import {
  formatCaptureRuntimeProtocolLog,
  readCaptureRuntimeProtocol,
  readSuccessfulCaptureSceneRanges,
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

export type PlaywrightSceneRecorderOptions = {
  clipTrimmer?: SceneClipTrimmer;
  headed?: boolean;
  postRollMs?: number;
  preRollMs?: number;
  rawVideoFinder?: RawVideoFinder;
  sceneScriptRunner?: SceneScriptRunner;
  sceneTimeoutMs?: number;
};

export type SceneClipTrimmer = (input: {
  durationMs: number;
  outputVideoPath: string;
  rawTakePath: string;
  sceneId: string;
  startMs: number;
}) => Promise<{ durationSeconds: number }>;

type SceneScriptRunner = (
  scenePath: string,
  timeoutMs: number,
) => Promise<SceneScriptResult>;

type SceneScriptResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type RawVideoFinder = (directory: string) => Promise<string>;

export class DefaultPlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;
  private readonly clipTrimmer: SceneClipTrimmer;
  private readonly rawVideoFinder: RawVideoFinder;
  private readonly sceneScriptRunner: SceneScriptRunner;

  constructor(options: PlaywrightSceneRecorderOptions = {}) {
    this.clipTrimmer = options.clipTrimmer ?? trimSceneClipWithFfmpeg;
    this.headed = options.headed ?? false;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
    this.rawVideoFinder = options.rawVideoFinder ?? findSingleVideo;
    this.sceneScriptRunner = options.sceneScriptRunner ?? runSceneScript;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? CAPTURE_SCRIPT_TIMEOUT_MS;
  }

  async recordScenes(input: RecordSceneInput): Promise<RecordedScene[]> {
    const sceneHoldMsById = createSceneHoldMsById(input.scenes);
    const captureTimeoutMs =
      this.sceneTimeoutMs + sumSceneHoldMs(sceneHoldMsById);
    const sceneWorkspace = join(input.runDirectory, "work", "continuous-take");
    const videoScratchDirectory = join(sceneWorkspace, "playwright-videos");
    const rawScenesDirectory = join(input.runDirectory, "raw-scenes");
    const sceneClipsDirectory = join(input.runDirectory, "scene-clips");
    const scenePath = join(sceneWorkspace, "demo-script.ts");
    const markerLogPath = join(input.runDirectory, "scene-markers.jsonl");
    const rawTakePath = join(rawScenesDirectory, "continuous-take.webm");

    await mkdir(videoScratchDirectory, { recursive: true });
    await mkdir(rawScenesDirectory, { recursive: true });
    await mkdir(sceneClipsDirectory, { recursive: true });
    await writeGeneratedCaptureSdkHarness(sceneWorkspace);
    await validateDemoScriptCaptureSdkTypes({
      demoPlaywrightScript: input.demoPlaywrightScript,
      directory: sceneWorkspace,
    });
    await writeFile(
      scenePath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        ...(input.externalResourceManifest === undefined
          ? {}
          : { externalResourceManifest: input.externalResourceManifest }),
        headed: this.headed,
        sceneHoldMsById,
        videoDirectory: videoScratchDirectory,
      }),
    );

    const result = await this.sceneScriptRunner(scenePath, captureTimeoutMs);
    const protocol = readCaptureRuntimeProtocol(result);
    await Promise.all([
      writeFile(markerLogPath, formatCaptureRuntimeProtocolLog(protocol)),
      writeFile(join(input.runDirectory, "stdout.log"), result.stdout),
      writeFile(join(input.runDirectory, "stderr.log"), result.stderr),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatSceneFailure("continuous-take", result));
    }

    const recordedVideoPath = await this.rawVideoFinder(videoScratchDirectory);
    await rm(rawTakePath, { force: true });
    await rename(recordedVideoPath, rawTakePath);

    const markerRanges = readSuccessfulCaptureSceneRanges({
      expectedStepIdsByScene: expectedStepIdsByScene(input),
      protocol,
      requireValidationLifecycle: false,
      requireVisibleAssertions: false,
      sceneIds: input.scenes.map((scene) => scene.id),
    });
    const recordedScenes: RecordedScene[] = [];
    const clipRanges = createNonOverlappingClipRanges({
      markerRanges,
      postRollMs: this.postRollMs,
      preRollMs: this.preRollMs,
      sceneIds: input.scenes.map((scene) => scene.id),
    });

    for (const scene of input.scenes) {
      const range = markerRanges.get(scene.id);
      if (range === undefined) {
        throw new Error(`Scene ${scene.id} did not emit complete markers.`);
      }

      const clipRange = clipRanges.get(scene.id);
      if (clipRange === undefined) {
        throw new Error(`Scene ${scene.id} did not receive a clip range.`);
      }
      const { endMs, startMs } = clipRange;
      const outputVideoPath = join(sceneClipsDirectory, `${scene.id}.webm`);
      const trimResult = await this.clipTrimmer({
        durationMs: endMs - startMs,
        outputVideoPath,
        rawTakePath,
        sceneId: scene.id,
        startMs,
      });

      recordedScenes.push({
        durationSeconds: trimResult.durationSeconds,
        markerEndMs: range.endedAtMs,
        markerStartMs: range.startedAtMs,
        sceneId: scene.id,
        sectionId: input.sectionId,
        videoPath: outputVideoPath,
      });
    }

    if (input.retainRawTake === false) {
      await rm(rawTakePath, { force: true });
    }

    return recordedScenes;
  }
}

export class PreparedWorkspacePlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;

  constructor(
    private readonly options: {
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
    if (workspace.downloadSubmittedCodeFiles === undefined) {
      throw new Error(
        "Prepared workspace Footage Capture requires artifact download support.",
      );
    }
    if (workspace.uploadSubmittedCodeFiles === undefined) {
      throw new Error(
        "Prepared workspace Footage Capture requires artifact upload support.",
      );
    }

    const runId = basename(input.runDirectory);
    const remoteRunDirectory = `/workspace/.makeademo/footage-capture-runs/${runId}`;
    const remoteSceneWorkspace = `${remoteRunDirectory}/work/continuous-take`;
    const remoteVideoScratchDirectory = `${remoteSceneWorkspace}/playwright-videos`;
    const remoteRawScenesDirectory = `${remoteRunDirectory}/raw-scenes`;
    const remoteSceneClipsDirectory = `${remoteRunDirectory}/scene-clips`;
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

    await executeSubmittedCode(
      workspace,
      `mkdir -p ${shellQuote(remoteSceneWorkspace)} ${shellQuote(remoteVideoScratchDirectory)} ${shellQuote(remoteRawScenesDirectory)} ${shellQuote(remoteSceneClipsDirectory)}`,
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

    const result = await executeSubmittedCode(
      workspace,
      `cd ${shellQuote(remoteSceneWorkspace)} && NODE_PATH="$(npm root -g)" timeout -k 10s ${Math.ceil(captureTimeoutMs / 1000)}s bun ${shellQuote(remoteScenePath)}`,
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
    if (workspace.readSubmittedCodeAppStatus !== undefined) {
      const appStatus = await workspace.readSubmittedCodeAppStatus();
      const appOutput = [appStatus.stderr, appStatus.stdout]
        .filter((value) => value.length > 0)
        .join("\n");
      await writeFile(
        join(input.runDirectory, "submitted-app-runtime.log"),
        appOutput,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        formatSceneFailure("continuous-take", {
          ...result,
          timedOut: result.exitCode === 124,
        }),
      );
    }

    const remoteRecordedVideoPath = await findSingleRemoteVideo({
      directory: remoteVideoScratchDirectory,
      workspace,
    });
    await executeSubmittedCode(
      workspace,
      `rm -f ${shellQuote(remoteRawTakePath)} && mv ${shellQuote(remoteRecordedVideoPath)} ${shellQuote(remoteRawTakePath)}`,
    );

    const markerRanges = readSuccessfulCaptureSceneRanges({
      expectedStepIdsByScene: expectedStepIdsByScene(input),
      protocol,
      requireValidationLifecycle: false,
      requireVisibleAssertions: false,
      sceneIds: input.scenes.map((scene) => scene.id),
    });
    const recordedScenes: RecordedScene[] = [];
    const downloadEntries =
      input.retainRawTake === false ? [] : ["raw-scenes/continuous-take.webm"];
    const clipRanges = createNonOverlappingClipRanges({
      markerRanges,
      postRollMs: this.postRollMs,
      preRollMs: this.preRollMs,
      sceneIds: input.scenes.map((scene) => scene.id),
    });

    for (const scene of input.scenes) {
      const range = markerRanges.get(scene.id);
      if (range === undefined) {
        throw new Error(`Scene ${scene.id} did not emit complete markers.`);
      }

      const clipRange = clipRanges.get(scene.id);
      if (clipRange === undefined) {
        throw new Error(`Scene ${scene.id} did not receive a clip range.`);
      }
      const { endMs, startMs } = clipRange;
      const remoteOutputVideoPath = `${remoteSceneClipsDirectory}/${scene.id}.webm`;
      const localOutputVideoPath = join(
        localSceneClipsDirectory,
        `${scene.id}.webm`,
      );
      const durationSeconds = (endMs - startMs) / 1000;
      const trimResult = await executeSubmittedCode(
        workspace,
        [
          "ffmpeg",
          "-y",
          "-i",
          shellQuote(remoteRawTakePath),
          "-ss",
          shellQuote((startMs / 1000).toFixed(3)),
          "-t",
          shellQuote(durationSeconds.toFixed(3)),
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
          shellQuote(remoteOutputVideoPath),
        ].join(" "),
      );
      if (trimResult.exitCode !== 0) {
        throw new Error(
          `Failed to trim Scene ${scene.id} with ffmpeg.\n${[trimResult.stdout, trimResult.stderr].filter(Boolean).join("\n")}`,
        );
      }
      const probedDurationSeconds = await probeRemoteVideoDurationSeconds({
        videoPath: remoteOutputVideoPath,
        workspace,
      });

      downloadEntries.push(`scene-clips/${scene.id}.webm`);
      recordedScenes.push({
        durationSeconds: probedDurationSeconds,
        markerEndMs: range.endedAtMs,
        markerStartMs: range.startedAtMs,
        sceneId: scene.id,
        sectionId: input.sectionId,
        videoPath: localOutputVideoPath,
      });
    }

    await downloadSubmittedCodeArchive({
      archiveName: "capture-outputs.tar",
      compression: "none",
      entries: downloadEntries,
      localDirectory: input.runDirectory,
      remoteDirectory: remoteRunDirectory,
      workspace,
    });

    return recordedScenes;
  }
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

async function probeRemoteVideoDurationSeconds(input: {
  videoPath: string;
  workspace: AgentHarnessWorkspace;
}): Promise<number> {
  const result = await executeSubmittedCode(
    input.workspace,
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      shellQuote(input.videoPath),
    ].join(" "),
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to probe trimmed Scene clip duration.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
    );
  }

  const durationSeconds = Number(result.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${input.videoPath}`);
  }

  return durationSeconds;
}

async function runSceneScript(scenePath: string, timeoutMs: number) {
  return await new Promise<SceneScriptResult>((resolve, reject) => {
    const child = spawn(process.execPath, [scenePath], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killChildProcessGroup(child.pid);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stderr, stdout, timedOut });
    });
  });
}

function formatSceneFailure(sceneId: string, result: SceneScriptResult) {
  const details = [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n");

  if (result.timedOut) {
    return `Scene ${sceneId} timed out.${details.length > 0 ? `\n${details}` : ""}`;
  }

  return `Scene ${sceneId} failed with exit code ${result.exitCode}.${
    details.length > 0 ? `\n${details}` : ""
  }`;
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

function killChildProcessGroup(pid: number | undefined) {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    // The child may already have exited between the timeout and signal delivery.
  }
}

async function findSingleVideo(directory: string) {
  const videos = await findVideoFiles(directory);

  if (videos.length === 0) {
    throw new Error(`No Playwright video was created in ${directory}`);
  }

  if (videos.length > 1) {
    throw new Error(
      `Expected one Playwright video in ${directory}, found ${videos.length}`,
    );
  }

  const video = videos[0];
  if (!video) {
    throw new Error(`No Playwright video was created in ${directory}`);
  }

  return video;
}

async function findSingleRemoteVideo(input: {
  directory: string;
  workspace: AgentHarnessWorkspace;
}) {
  const result = await executeSubmittedCode(
    input.workspace,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function findVideoFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const videos: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      videos.push(...(await findVideoFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".webm")) {
      videos.push(entryPath);
    }
  }

  return videos;
}

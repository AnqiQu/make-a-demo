import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import { uploadSubmittedCodeWorkspaceFiles } from "../03-repo-preparation/preparation-workspace-upload";
import type { PreparationWorkspace } from "../03-repo-preparation/preparation-workspace.interface";
import { executeSubmittedCode } from "../03-repo-preparation/submitted-code-execution";
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

export type PlaywrightSceneRecorderOptions = {
  clipTrimmer?: SceneClipTrimmer;
  headed?: boolean;
  pauseAfterSceneMs?: number;
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

type SceneMarker = {
  elapsedMs: number;
  event: "failed" | "started" | "succeeded";
  message?: string;
  sceneId: string;
};

export class DefaultPlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly pauseAfterSceneMs: number;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;
  private readonly clipTrimmer: SceneClipTrimmer;
  private readonly rawVideoFinder: RawVideoFinder;
  private readonly sceneScriptRunner: SceneScriptRunner;

  constructor(options: PlaywrightSceneRecorderOptions = {}) {
    this.clipTrimmer = options.clipTrimmer ?? trimSceneClipWithFfmpeg;
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
    this.rawVideoFinder = options.rawVideoFinder ?? findSingleVideo;
    this.sceneScriptRunner = options.sceneScriptRunner ?? runSceneScript;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? 120_000;
  }

  async recordScenes(input: RecordSceneInput): Promise<RecordedScene[]> {
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
        headed: this.headed,
        pauseAfterSceneMs: this.pauseAfterSceneMs,
        videoDirectory: videoScratchDirectory,
      }),
    );

    const result = await this.sceneScriptRunner(scenePath, this.sceneTimeoutMs);
    await writeFile(markerLogPath, extractMarkerLog(result.stdout));
    const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
    if (blockedNetworkAttempts.length > 0) {
      throw new Error(
        `Footage Capture blocked runtime network access from the generated Demo Script: ${blockedNetworkAttempts.map((attempt) => attempt.host).join(", ")}`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(formatSceneFailure("continuous-take", result));
    }

    const recordedVideoPath = await this.rawVideoFinder(videoScratchDirectory);
    await rm(rawTakePath, { force: true });
    await rename(recordedVideoPath, rawTakePath);

    const markers = parseSceneMarkers(result.stdout);
    const markerRanges = readMarkerRanges(
      markers,
      input.scenes.map((scene) => scene.id),
    );
    const recordedScenes: RecordedScene[] = [];

    for (const scene of input.scenes) {
      const range = markerRanges.get(scene.id);
      if (range === undefined) {
        throw new Error(`Scene ${scene.id} did not emit complete markers.`);
      }

      const startMs = Math.max(0, range.startedAtMs - this.preRollMs);
      const endMs = Math.max(startMs + 1, range.endedAtMs + this.postRollMs);
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

    return recordedScenes;
  }
}

export class PreparedWorkspacePlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly pauseAfterSceneMs: number;
  private readonly postRollMs: number;
  private readonly preRollMs: number;
  private readonly sceneTimeoutMs: number;

  constructor(
    private readonly options: {
      headed?: boolean;
      pauseAfterSceneMs?: number;
      postRollMs?: number;
      preRollMs?: number;
      preparationWorkspace: PreparationWorkspaceHandle;
      sceneTimeoutMs?: number;
    },
  ) {
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? 120_000;
  }

  async recordScenes(input: RecordSceneInput): Promise<RecordedScene[]> {
    const workspace = this.options.preparationWorkspace.workspace;
    if (workspace.downloadFiles === undefined) {
      throw new Error(
        "Prepared workspace Footage Capture requires artifact download support.",
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
    const localRawTakePath = join(
      localRawScenesDirectory,
      "continuous-take.webm",
    );

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
        headed: this.headed,
        pauseAfterSceneMs: this.pauseAfterSceneMs,
        videoDirectory: remoteVideoScratchDirectory,
      }),
    );

    await executeSubmittedCode(
      workspace,
      `mkdir -p ${shellQuote(remoteSceneWorkspace)} ${shellQuote(remoteVideoScratchDirectory)} ${shellQuote(remoteRawScenesDirectory)} ${shellQuote(remoteSceneClipsDirectory)}`,
    );
    await uploadSubmittedCodeWorkspaceFiles({
      files: [
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.js`,
          sourcePath: join(localSceneWorkspace, "makeademo-capture-sdk.js"),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.d.ts`,
          sourcePath: join(localSceneWorkspace, "makeademo-capture-sdk.d.ts"),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/makeademo-capture-sdk.instructions.md`,
          sourcePath: join(
            localSceneWorkspace,
            "makeademo-capture-sdk.instructions.md",
          ),
        },
        {
          destinationPath: `${remoteSceneWorkspace}/demo-script.contract.ts`,
          sourcePath: join(localSceneWorkspace, "demo-script.contract.ts"),
        },
        { destinationPath: remoteScenePath, sourcePath: localScenePath },
      ],
      workspace,
    });

    const result = await executeSubmittedCode(
      workspace,
      `cd ${shellQuote(remoteSceneWorkspace)} && ${createExposeGlobalPlaywrightCommand()} && timeout -s TERM ${Math.ceil(this.sceneTimeoutMs / 1000)} bun ${shellQuote(remoteScenePath)}`,
    );
    await writeFile(markerLogPath, extractMarkerLog(result.stdout));
    const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
    if (blockedNetworkAttempts.length > 0) {
      throw new Error(
        `Footage Capture blocked runtime network access from the generated Demo Script: ${blockedNetworkAttempts.map((attempt) => attempt.host).join(", ")}`,
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

    const markers = parseSceneMarkers(result.stdout);
    const markerRanges = readMarkerRanges(
      markers,
      input.scenes.map((scene) => scene.id),
    );
    const recordedScenes: RecordedScene[] = [];
    const downloads = [
      { destinationPath: localRawTakePath, sourcePath: remoteRawTakePath },
    ];

    for (const scene of input.scenes) {
      const range = markerRanges.get(scene.id);
      if (range === undefined) {
        throw new Error(`Scene ${scene.id} did not emit complete markers.`);
      }

      const startMs = Math.max(0, range.startedAtMs - this.preRollMs);
      const endMs = Math.max(startMs + 1, range.endedAtMs + this.postRollMs);
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
          "-ss",
          shellQuote((startMs / 1000).toFixed(3)),
          "-i",
          shellQuote(remoteRawTakePath),
          "-t",
          shellQuote(durationSeconds.toFixed(3)),
          "-c",
          "copy",
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

      downloads.push({
        destinationPath: localOutputVideoPath,
        sourcePath: remoteOutputVideoPath,
      });
      recordedScenes.push({
        durationSeconds: probedDurationSeconds,
        markerEndMs: range.endedAtMs,
        markerStartMs: range.startedAtMs,
        sceneId: scene.id,
        sectionId: input.sectionId,
        videoPath: localOutputVideoPath,
      });
    }

    await workspace.downloadFiles(downloads);

    return recordedScenes;
  }
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
    "-ss",
    (input.startMs / 1000).toFixed(3),
    "-i",
    input.rawTakePath,
    "-t",
    durationSeconds.toFixed(3),
    "-c",
    "copy",
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
  workspace: PreparationWorkspace;
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

function extractMarkerLog(stdout: string) {
  // scene-markers.jsonl is a derived capture protocol artifact, not a server audit log.
  return parseSceneMarkers(stdout)
    .map((marker) => `${JSON.stringify(marker)}\n`)
    .join("");
}

function parseSceneMarkers(stdout: string): SceneMarker[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:scene] "))
    .map((line) => readSceneMarker(line))
    .map((value): SceneMarker => {
      const marker = value as Partial<SceneMarker>;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof marker.sceneId !== "string" ||
        typeof marker.elapsedMs !== "number" ||
        !Number.isFinite(marker.elapsedMs) ||
        (marker.event !== "started" &&
          marker.event !== "succeeded" &&
          marker.event !== "failed")
      ) {
        throw new Error(
          "Malformed MakeADemo scene marker emitted by capture script.",
        );
      }

      return {
        elapsedMs: marker.elapsedMs,
        event: marker.event,
        ...(marker.message === undefined ? {} : { message: marker.message }),
        sceneId: marker.sceneId,
      };
    });
}

function readSceneMarker(line: string): unknown {
  try {
    return JSON.parse(line.slice("[makeademo:scene] ".length));
  } catch {
    throw new Error(
      `Malformed MakeADemo scene marker emitted by capture script: ${line}`,
    );
  }
}

function readMarkerRanges(markers: SceneMarker[], sceneIds: string[]) {
  const ranges = new Map<string, { endedAtMs: number; startedAtMs: number }>();
  const openScenes = new Map<string, number>();

  for (const marker of markers) {
    if (!sceneIds.includes(marker.sceneId)) {
      throw new Error(
        `Capture script emitted undeclared Scene marker ${marker.sceneId}.`,
      );
    }

    if (marker.event === "started") {
      if (openScenes.size > 0) {
        throw new Error("Capture script emitted nested Scene markers.");
      }
      if (ranges.has(marker.sceneId) || openScenes.has(marker.sceneId)) {
        throw new Error(
          `Capture script emitted duplicate markers for Scene ${marker.sceneId}.`,
        );
      }
      openScenes.set(marker.sceneId, marker.elapsedMs);
      continue;
    }

    const startedAtMs = openScenes.get(marker.sceneId);
    if (startedAtMs === undefined) {
      throw new Error(
        `Capture script emitted ${marker.event} marker before start for Scene ${marker.sceneId}.`,
      );
    }
    openScenes.delete(marker.sceneId);

    if (marker.event === "failed") {
      throw new Error(
        `Scene ${marker.sceneId} failed during Footage Capture.${marker.message ? ` ${marker.message}` : ""}`,
      );
    }

    ranges.set(marker.sceneId, {
      endedAtMs: marker.elapsedMs,
      startedAtMs,
    });
  }

  if (openScenes.size > 0) {
    throw new Error(
      "Capture script emitted Scene start marker without an end marker.",
    );
  }

  for (const sceneId of sceneIds) {
    if (!ranges.has(sceneId)) {
      throw new Error(`Scene ${sceneId} did not emit complete markers.`);
    }
  }

  return ranges;
}

function readBlockedNetworkAttempts(stderr: string) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:network-blocked] "))
    .map((line) =>
      JSON.parse(line.slice("[makeademo:network-blocked] ".length)),
    )
    .filter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        value.direction === "outbound" &&
        value.phase === "runtime" &&
        typeof value.host === "string",
    )
    .map((value) => ({ host: value.host as string }));
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
  workspace: PreparationWorkspace;
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

function createExposeGlobalPlaywrightCommand() {
  return [
    "global_node_modules=$(npm root -g 2>/dev/null || true)",
    'if [ -n "$global_node_modules" ]; then mkdir -p node_modules; fi',
    'if [ -e "$global_node_modules/@playwright" ]; then ln -sfn "$global_node_modules/@playwright" node_modules/@playwright; fi',
    'if [ -e "$global_node_modules/playwright" ]; then ln -sfn "$global_node_modules/playwright" node_modules/playwright; fi',
    'if [ -e "$global_node_modules/playwright-core" ]; then ln -sfn "$global_node_modules/playwright-core" node_modules/playwright-core; fi',
  ].join("; ");
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

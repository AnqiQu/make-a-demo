import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  sceneTimeoutMs?: number;
};

export type SceneClipTrimmer = (input: {
  durationMs: number;
  outputVideoPath: string;
  rawTakePath: string;
  sceneId: string;
  startMs: number;
}) => Promise<{ durationSeconds: number }>;

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

  constructor(options: PlaywrightSceneRecorderOptions = {}) {
    this.clipTrimmer = options.clipTrimmer ?? trimSceneClipWithFfmpeg;
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
    this.postRollMs = options.postRollMs ?? 350;
    this.preRollMs = options.preRollMs ?? 250;
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
    await writeFile(
      scenePath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        headed: this.headed,
        pauseAfterSceneMs: this.pauseAfterSceneMs,
        videoDirectory: videoScratchDirectory,
      }),
    );

    const result = await runSceneScript(scenePath, this.sceneTimeoutMs);
    await writeFile(markerLogPath, extractMarkerLog(result.stdout));

    if (result.exitCode !== 0) {
      throw new Error(formatSceneFailure("continuous-take", result));
    }

    const recordedVideoPath = await findSingleVideo(videoScratchDirectory);
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

  return { durationSeconds };
}

async function runSceneScript(scenePath: string, timeoutMs: number) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
  }>((resolve, reject) => {
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

function formatSceneFailure(
  sceneId: string,
  result: Awaited<ReturnType<typeof runSceneScript>>,
) {
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
  return parseSceneMarkers(stdout)
    .map((marker) => `${JSON.stringify(marker)}\n`)
    .join("");
}

function parseSceneMarkers(stdout: string): SceneMarker[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:scene] "))
    .map((line) => JSON.parse(line.slice("[makeademo:scene] ".length)))
    .map((value): SceneMarker => {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.sceneId !== "string" ||
        typeof value.elapsedMs !== "number" ||
        !Number.isFinite(value.elapsedMs) ||
        (value.event !== "started" &&
          value.event !== "succeeded" &&
          value.event !== "failed")
      ) {
        throw new Error(
          "Malformed MakeADemo scene marker emitted by capture script.",
        );
      }

      return value;
    });
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

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
  headed?: boolean;
  pauseAfterSceneMs?: number;
  sceneTimeoutMs?: number;
};

export class DefaultPlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly pauseAfterSceneMs: number;
  private readonly sceneTimeoutMs: number;

  constructor(options: PlaywrightSceneRecorderOptions = {}) {
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
    this.sceneTimeoutMs = options.sceneTimeoutMs ?? 120_000;
  }

  async recordScene(input: RecordSceneInput): Promise<RecordedScene> {
    const sceneWorkspace = join(input.runDirectory, "work", input.scene.id);
    const videoScratchDirectory = join(sceneWorkspace, "playwright-videos");
    const rawScenesDirectory = join(input.runDirectory, "raw-scenes");
    const scenePath = join(sceneWorkspace, `${input.scene.id}.ts`);
    const outputVideoPath = join(rawScenesDirectory, `${input.scene.id}.webm`);

    await mkdir(videoScratchDirectory, { recursive: true });
    await mkdir(rawScenesDirectory, { recursive: true });
    await writeFile(
      scenePath,
      prepareStylizedPlaywrightScript(input.scene.playwrightScript, {
        baseUrl: input.baseUrl,
        headed: this.headed,
        pauseAfterSceneMs: this.pauseAfterSceneMs,
        videoDirectory: videoScratchDirectory,
      }),
    );

    const startedAt = Date.now();
    const result = await runSceneScript(scenePath, this.sceneTimeoutMs);

    if (result.exitCode !== 0) {
      throw new Error(formatSceneFailure(input.scene.id, result));
    }

    const recordedVideoPath = await findSingleVideo(videoScratchDirectory);
    await rm(outputVideoPath, { force: true });
    await rename(recordedVideoPath, outputVideoPath);

    return {
      durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
      videoPath: outputVideoPath,
    };
  }
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

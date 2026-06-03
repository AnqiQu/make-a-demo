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
};

export class DefaultPlaywrightSceneRecorder implements SceneRecorder {
  private readonly headed: boolean;
  private readonly pauseAfterSceneMs: number;

  constructor(options: PlaywrightSceneRecorderOptions = {}) {
    this.headed = options.headed ?? false;
    this.pauseAfterSceneMs = options.pauseAfterSceneMs ?? 0;
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
    const result = await runSceneScript(scenePath);

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

async function runSceneScript(scenePath: string) {
  const child = Bun.spawn([process.execPath, scenePath], {
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stderr, stdout };
}

function formatSceneFailure(
  sceneId: string,
  result: Awaited<ReturnType<typeof runSceneScript>>,
) {
  const details = [result.stdout.trim(), result.stderr.trim()]
    .filter((output) => output.length > 0)
    .join("\n");

  return `Scene ${sceneId} failed with exit code ${result.exitCode}.${
    details.length > 0 ? `\n${details}` : ""
  }`;
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

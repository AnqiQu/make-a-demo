import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RecordSceneInput,
  RecordedScene,
  SceneRecorder,
} from "./scene-recorder.interface";

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
      preparePlaywrightScript(input.scene.playwrightScript, {
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

type PreparePlaywrightScriptInput = {
  baseUrl: string;
  headed: boolean;
  pauseAfterSceneMs: number;
  videoDirectory: string;
};

function preparePlaywrightScript(
  script: string,
  input: PreparePlaywrightScriptInput,
) {
  if (!script.includes("chromium.launch")) {
    return wrapActionBody(script, input);
  }

  let prepared = script.replaceAll("http://localhost:3000", input.baseUrl);
  prepared = prepared.replace(
    /dir:\s*(['"`])[^'"`]+?\1/,
    `dir: ${JSON.stringify(input.videoDirectory)}`,
  );

  if (input.headed) {
    prepared = prepared.replace(
      /chromium\.launch\(\s*\)/,
      "chromium.launch({ headless: false })",
    );
  }

  if (input.pauseAfterSceneMs > 0) {
    prepared = prepared.replace(
      /await\s+context\.close\(\);/,
      `await page.waitForTimeout(${input.pauseAfterSceneMs});\nawait context.close();`,
    );
  }

  return prepared;
}

function wrapActionBody(script: string, input: PreparePlaywrightScriptInput) {
  const launchOptions = input.headed ? "{ headless: false }" : "";
  const pauseLine =
    input.pauseAfterSceneMs > 0
      ? `await page.waitForTimeout(${input.pauseAfterSceneMs});`
      : "";

  return `import { chromium, expect } from "@playwright/test";

const baseUrl = ${JSON.stringify(input.baseUrl)};
const browser = await chromium.launch(${launchOptions});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: {
    dir: ${JSON.stringify(input.videoDirectory)},
    size: { width: 1280, height: 720 },
  },
});
const page = await context.newPage();

try {
${indentScriptBody(script)}
  ${pauseLine}
} finally {
  await context.close();
  await browser.close();
}
void expect;
`;
}

function indentScriptBody(script: string) {
  return script
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPlaywrightSceneRecorder } from "./playwright-scene-recorder";
import type { SceneRecorder } from "./scene-recorder.interface";
import {
  type CaptureReadyVideoScriptPackage,
  parseVideoScriptPackage,
} from "./video-script-package.schema";

type CapturedSceneManifestEntry = {
  durationSeconds: number;
  sceneId: string;
  sectionId: string;
  videoPath: string;
};

export type CaptureManifest = {
  baseUrl: string;
  createdAt: string;
  keepTemp: boolean;
  manifestPath: string;
  runDirectory: string;
  runId: string;
  scenes: CapturedSceneManifestEntry[];
  scriptId: string;
  temporary: true;
  title: string;
};

export type CaptureScenesFromScriptInput = {
  baseUrl: string;
  keepTemp?: boolean;
  recorder?: SceneRecorder;
  runId?: string;
  scriptPackage?: CaptureReadyVideoScriptPackage;
  scriptPath?: string;
  tempRoot?: string;
};

export async function captureScenesFromScript(
  input: CaptureScenesFromScriptInput,
): Promise<CaptureManifest> {
  const tempRoot = input.tempRoot ?? ".demo-capture-runs";
  const keepTemp = input.keepTemp ?? false;
  const runId = input.runId ?? createRunId();
  const runDirectory = await createRunDirectory(tempRoot, runId);
  const rawScenesDirectory = join(runDirectory, "raw-scenes");
  await mkdir(rawScenesDirectory, { recursive: true });

  const scriptPackage = await readScriptPackage(input);
  const recorder = input.recorder ?? new DefaultPlaywrightSceneRecorder();
  const scenes: CapturedSceneManifestEntry[] = [];

  try {
    for (const section of scriptPackage.sections) {
      for (const scene of section.scenes) {
        const recordedScene = await recorder.recordScene({
          baseUrl: input.baseUrl,
          runDirectory,
          scene,
          sectionId: section.id,
        });

        scenes.push({
          durationSeconds: recordedScene.durationSeconds,
          sceneId: scene.id,
          sectionId: section.id,
          videoPath: recordedScene.videoPath,
        });
      }
    }

    const manifestPath = join(runDirectory, "capture-manifest.json");
    const manifest: CaptureManifest = {
      baseUrl: input.baseUrl,
      createdAt: new Date().toISOString(),
      keepTemp,
      manifestPath,
      runDirectory,
      runId,
      scenes,
      scriptId: scriptPackage.scriptId,
      temporary: true,
      title: scriptPackage.title,
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    if (!keepTemp) {
      await rm(runDirectory, { force: true, recursive: true });
    }
    throw error;
  }
}

async function readScriptPackage(input: CaptureScenesFromScriptInput) {
  if (input.scriptPackage !== undefined) {
    return parseVideoScriptPackage(input.scriptPackage);
  }

  if (input.scriptPath === undefined) {
    throw new Error("scriptPath or scriptPackage is required");
  }

  return parseVideoScriptPackage(
    JSON.parse(await readFile(input.scriptPath, "utf8")),
  );
}

async function createRunDirectory(tempRoot: string, runId: string) {
  await mkdir(tempRoot, { recursive: true });

  if (runId.length > 0) {
    const runDirectory = join(tempRoot, runId);
    await mkdir(runDirectory, { recursive: false });
    return runDirectory;
  }

  return mkdtemp(join(tempRoot, "capture-"));
}

function createRunId() {
  return `capture-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

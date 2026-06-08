import {
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CaptureManifest } from "../06-capture/capture-scenes";
import type { FinalVideoEmailNotifier } from "../final-output/final-video-email-notifier.interface";
import type {
  DemoRequestFinalVideoStore,
  FinalVideoStorage,
  StoredFinalVideo,
} from "./final-video-storage.interface";
import type {
  CompositingFontAsset,
  CompositingMusicAsset,
  CompositingRenderPlan,
  CompositingScene,
  CompositingTextStyle,
  CompositingTransition,
  VideoRenderer,
} from "./video-renderer.interface";

const COMPOSITION_ID = "MakeADemoVideo";
const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;

const fontAssetFiles = {
  "Bricolage Grotesque": "BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf",
  Fraunces: "Fraunces-VariableFont_SOFT,WONK,opsz,wght.ttf",
  "IBM Plex Sans": "IBMPlexSans-VariableFont_wdth,wght.ttf",
  Inter: "Inter-VariableFont_opsz,wght.ttf",
  "JetBrains Mono": "JetBrainsMono-VariableFont_wght.ttf",
  Nunito: "Nunito-VariableFont_wght.ttf",
  "Playfair Display": "PlayfairDisplay-VariableFont_wght.ttf",
  "Space Grotesk": "SpaceGrotesk-VariableFont_wght.ttf",
} as const;

type ApprovedFontFamily = keyof typeof fontAssetFiles;

type FullVideoScriptPackage = {
  audio?: {
    enabled: boolean;
    music?: { id: string };
  };
  estimatedDurationSeconds: number;
  format: string;
  scriptId: string;
  sections: ScriptSection[];
  title: string;
  version: number;
};

type ScriptSection = {
  id: string;
  scenes: ScriptScene[];
  title: string;
};

type ScriptScene =
  | FullScreenTextScene
  | PlaywrightRecordingScene
  | StaticImageScene;

type BaseScriptScene = {
  description: string;
  durationSeconds: number;
  id: string;
  text?: CompositingTextStyle;
  transition?: CompositingTransition;
};

type FullScreenTextScene = BaseScriptScene & {
  backgroundColor: string;
  type: "full-screen-text";
};

type PlaywrightRecordingScene = BaseScriptScene & {
  playwrightSceneId: string;
  type: "playwright-recording";
};

type StaticImageScene = BaseScriptScene & {
  image: {
    alt: string;
    assetPath: string;
  };
  type: "static-image";
};

export type CompositedVideoManifest = {
  createdAt: string;
  durationInFrames: number;
  fps: number;
  finalVideo?: StoredFinalVideo;
  manifestPath: string;
  outputVideoPath?: string;
  renderPlanPath: string;
  runDirectory: string;
  runId: string;
  scriptId: string;
  title: string;
  viewUrl: string;
};

export type CompositeVideoFromScriptInput = {
  captureManifestPath: string;
  demoRequestId?: string;
  demoRequestStore?: DemoRequestFinalVideoStore;
  finalVideoEmailNotifier?: FinalVideoEmailNotifier;
  finalVideoStorage?: FinalVideoStorage;
  outputRoot?: string;
  projectRoot?: string;
  publicAppBaseUrl?: string;
  renderer?: VideoRenderer;
  runId?: string;
  scriptPath: string;
};

export async function compositeVideoFromScript(
  input: CompositeVideoFromScriptInput,
): Promise<CompositedVideoManifest> {
  assertFinalVideoDependencies(input);

  const projectRoot = input.projectRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? ".demo-composite-renders";
  const runId = input.runId ?? createRunId();
  const runDirectory = join(outputRoot, runId);
  const publicDir = join(runDirectory, "public");
  const outputVideoPath = join(runDirectory, "final-video.mp4");
  const manifestPath = join(runDirectory, "composite-manifest.json");
  const renderPlanPath = join(runDirectory, "render-plan.json");

  await mkdir(publicDir, { recursive: true });

  const scriptPackage = parseFullVideoScriptPackage(
    JSON.parse(await readFile(input.scriptPath, "utf8")),
  );
  const captureManifest = parseCaptureManifest(
    JSON.parse(await readFile(input.captureManifestPath, "utf8")),
  );

  if (captureManifest.scriptId !== scriptPackage.scriptId) {
    throw new Error(
      `capture manifest scriptId ${captureManifest.scriptId} does not match Video Script Package scriptId ${scriptPackage.scriptId}`,
    );
  }

  const scriptDirectory = dirname(resolve(input.scriptPath));
  const scenes = await stageScenes({
    captureManifest,
    projectRoot,
    publicDir,
    scriptDirectory,
    scriptPackage,
  });
  const fontAssets = await stageFontAssets({
    projectRoot,
    publicDir,
    scenes,
  });
  const music = await stageMusicAsset({
    projectRoot,
    publicDir,
    scriptPackage,
  });
  const durationInFrames = scenes.reduce(
    (total, scene) => total + scene.durationFrames,
    0,
  );
  const renderPlan: CompositingRenderPlan = {
    compositionId: COMPOSITION_ID,
    durationInFrames,
    fontAssets,
    fps: FPS,
    height: HEIGHT,
    ...(music ? { music } : {}),
    outputPath: outputVideoPath,
    publicDir,
    scenes,
    scriptId: scriptPackage.scriptId,
    title: scriptPackage.title,
    width: WIDTH,
  };

  await writeFile(renderPlanPath, `${JSON.stringify(renderPlan, null, 2)}\n`);
  const renderer = input.renderer ?? (await createDefaultRenderer());
  await renderer.renderVideo(renderPlan);
  const finalVideo = await storeAndLinkFinalVideo({
    demoRequestId: input.demoRequestId,
    demoRequestStore: input.demoRequestStore,
    finalVideoStorage: input.finalVideoStorage,
    outputVideoPath,
    publicAppBaseUrl: input.publicAppBaseUrl,
    runId,
    scriptId: scriptPackage.scriptId,
    title: scriptPackage.title,
    emailNotifier: input.finalVideoEmailNotifier,
  });

  const manifest: CompositedVideoManifest = {
    createdAt: new Date().toISOString(),
    durationInFrames,
    fps: FPS,
    ...(finalVideo ? { finalVideo } : {}),
    manifestPath,
    ...(finalVideo ? {} : { outputVideoPath }),
    renderPlanPath,
    runDirectory,
    runId,
    scriptId: scriptPackage.scriptId,
    title: scriptPackage.title,
    viewUrl: finalVideo?.r2Url ?? pathToFileURL(resolve(outputVideoPath)).href,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function assertFinalVideoDependencies(input: CompositeVideoFromScriptInput) {
  const dependencies = [
    input.demoRequestId,
    input.demoRequestStore,
    input.finalVideoStorage,
  ].filter(Boolean);

  if (dependencies.length > 0 && dependencies.length !== 3) {
    throw new Error(
      "demoRequestId, demoRequestStore, and finalVideoStorage are all required to store final Compositing output",
    );
  }

  if (input.finalVideoEmailNotifier && !input.publicAppBaseUrl) {
    throw new Error(
      "publicAppBaseUrl is required to email final Compositing output",
    );
  }
}

async function storeAndLinkFinalVideo(input: {
  demoRequestId: string | undefined;
  demoRequestStore: DemoRequestFinalVideoStore | undefined;
  emailNotifier: FinalVideoEmailNotifier | undefined;
  finalVideoStorage: FinalVideoStorage | undefined;
  outputVideoPath: string;
  publicAppBaseUrl: string | undefined;
  runId: string;
  scriptId: string;
  title: string;
}) {
  if (
    !input.demoRequestId ||
    !input.demoRequestStore ||
    !input.finalVideoStorage
  ) {
    return undefined;
  }

  const finalVideo = await input.finalVideoStorage.storeFinalVideo({
    body: await readFile(input.outputVideoPath),
    contentType: "video/mp4",
    demoRequestId: input.demoRequestId,
    fileName: "final-video.mp4",
    runId: input.runId,
    scriptId: input.scriptId,
  });

  const linkedDemoRequest = await input.demoRequestStore.linkFinalVideo({
    demoRequestId: input.demoRequestId,
    generatedDemoUrl: finalVideo.r2Url,
  });

  if (
    input.emailNotifier &&
    input.publicAppBaseUrl &&
    !linkedDemoRequest.finalVideoEmailSentAt
  ) {
    await input.emailNotifier.sendFinalVideoReadyEmail({
      demoRequestId: input.demoRequestId,
      title: input.title,
      to: linkedDemoRequest.makerEmail,
      videoUrl: createFinalVideoAppUrl({
        demoRequestId: input.demoRequestId,
        publicAppBaseUrl: input.publicAppBaseUrl,
      }),
    });
    await input.demoRequestStore.markFinalVideoEmailSent({
      demoRequestId: input.demoRequestId,
      sentAt: new Date().toISOString(),
    });
  }
  await unlink(input.outputVideoPath);

  return finalVideo;
}

function createFinalVideoAppUrl(input: {
  demoRequestId: string;
  publicAppBaseUrl: string;
}) {
  const baseUrl = input.publicAppBaseUrl.replace(/\/+$/g, "");
  return `${baseUrl}/api/demo-requests/${encodeURIComponent(
    input.demoRequestId,
  )}/video`;
}

async function stageScenes(input: {
  captureManifest: CaptureManifest;
  projectRoot: string;
  publicDir: string;
  scriptDirectory: string;
  scriptPackage: FullVideoScriptPackage;
}) {
  const capturedScenesById = new Map(
    input.captureManifest.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const scenes: CompositingScene[] = [];

  for (const section of input.scriptPackage.sections) {
    for (const scene of section.scenes) {
      if (scene.type === "full-screen-text") {
        scenes.push({
          backgroundColor: scene.backgroundColor,
          durationFrames: secondsToFrames(scene.durationSeconds),
          sceneId: scene.id,
          ...(scene.text ? { text: scene.text } : {}),
          ...(scene.transition ? { transition: scene.transition } : {}),
          type: scene.type,
        });
        continue;
      }

      if (scene.type === "playwright-recording") {
        const capturedScene = capturedScenesById.get(scene.playwrightSceneId);
        if (!capturedScene) {
          throw new Error(
            `missing captured Scene for playwrightSceneId ${scene.playwrightSceneId}`,
          );
        }

        const extension = extname(capturedScene.videoPath) || ".webm";
        const sourcePublicPath = `scenes/${scene.playwrightSceneId}${extension}`;
        await copyAsset(
          capturedScene.videoPath,
          join(input.publicDir, sourcePublicPath),
        );
        scenes.push({
          durationFrames: secondsToFrames(scene.durationSeconds),
          sceneId: scene.id,
          sourcePublicPath,
          ...(scene.text ? { text: scene.text } : {}),
          ...(scene.transition ? { transition: scene.transition } : {}),
          type: scene.type,
        });
        continue;
      }

      const imagePath = await resolveAssetPath({
        assetPath: scene.image.assetPath,
        projectRoot: input.projectRoot,
        scriptDirectory: input.scriptDirectory,
      });
      const extension = extname(imagePath) || ".png";
      const sourcePublicPath = `images/${scene.id}${extension}`;
      await copyAsset(imagePath, join(input.publicDir, sourcePublicPath));
      scenes.push({
        alt: scene.image.alt,
        durationFrames: secondsToFrames(scene.durationSeconds),
        sceneId: scene.id,
        sourcePublicPath,
        ...(scene.text ? { text: scene.text } : {}),
        ...(scene.transition ? { transition: scene.transition } : {}),
        type: scene.type,
      });
    }
  }

  return scenes;
}

async function stageFontAssets(input: {
  projectRoot: string;
  publicDir: string;
  scenes: CompositingScene[];
}) {
  const fontAssets: Record<string, CompositingFontAsset> = {};
  const fontFamilies = new Set(
    input.scenes.flatMap((scene) =>
      scene.text ? [scene.text.fontFamily] : [],
    ),
  );

  for (const fontFamily of fontFamilies) {
    if (!isApprovedFontFamily(fontFamily)) {
      throw new Error(`unsupported Compositing font ${fontFamily}`);
    }

    const filename = fontAssetFiles[fontFamily];
    const publicPath = `fonts/${filename}`;
    await copyAsset(
      join(input.projectRoot, "assets", "fonts", filename),
      join(input.publicDir, publicPath),
    );
    fontAssets[fontFamily] = { family: fontFamily, publicPath };
  }

  return fontAssets;
}

async function stageMusicAsset(input: {
  projectRoot: string;
  publicDir: string;
  scriptPackage: FullVideoScriptPackage;
}) {
  if (!input.scriptPackage.audio?.enabled || !input.scriptPackage.audio.music) {
    return undefined;
  }

  const musicId = input.scriptPackage.audio.music.id;
  const sourcePath = join(
    input.projectRoot,
    "assets",
    "music",
    `${musicId}.mp3`,
  );
  const publicPath = `music/${basename(sourcePath)}`;
  await copyAsset(sourcePath, join(input.publicDir, publicPath));

  return { id: musicId, publicPath } satisfies CompositingMusicAsset;
}

async function resolveAssetPath(input: {
  assetPath: string;
  projectRoot: string;
  scriptDirectory: string;
}) {
  if (input.assetPath.startsWith("/")) {
    return input.assetPath;
  }

  const scriptRelativePath = join(input.scriptDirectory, input.assetPath);
  if (await exists(scriptRelativePath)) {
    return scriptRelativePath;
  }

  return join(input.projectRoot, input.assetPath);
}

async function copyAsset(sourcePath: string, destinationPath: string) {
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseFullVideoScriptPackage(value: unknown): FullVideoScriptPackage {
  const record = assertRecord(value, "script package");
  const audio = readAudio(record);

  const scriptPackage: FullVideoScriptPackage = {
    estimatedDurationSeconds: readPositiveNumber(
      record,
      "estimatedDurationSeconds",
    ),
    format: readNonEmptyString(record, "format"),
    scriptId: readNonEmptyString(record, "scriptId"),
    sections: readSections(record),
    title: readNonEmptyString(record, "title"),
    version: readPositiveNumber(record, "version"),
    ...(audio ? { audio } : {}),
  };

  if (scriptPackage.format !== "16:9") {
    throw new Error("format must be 16:9 for Compositing");
  }

  return scriptPackage;
}

function readSections(record: Record<string, unknown>) {
  const sections = record.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("sections must be a non-empty array");
  }

  return sections.map((section, sectionIndex): ScriptSection => {
    const sectionPath = `sections[${sectionIndex}]`;
    const sectionRecord = assertRecord(section, sectionPath);
    const scenes = sectionRecord.scenes;
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new Error(`${sectionPath}.scenes must be a non-empty array`);
    }

    return {
      id: readNonEmptyString(sectionRecord, "id", sectionPath),
      scenes: scenes.map((scene, sceneIndex) =>
        readScene(scene, `${sectionPath}.scenes[${sceneIndex}]`),
      ),
      title: readNonEmptyString(sectionRecord, "title", sectionPath),
    };
  });
}

function readScene(value: unknown, path: string): ScriptScene {
  const record = assertRecord(value, path);
  const type = readNonEmptyString(record, "type", path);
  const text = readOptionalText(record, path);
  const transition = readOptionalTransition(record, path);
  const base = {
    description: readNonEmptyString(record, "description", path),
    durationSeconds: readPositiveNumber(record, "durationSeconds", path),
    id: readNonEmptyString(record, "id", path),
    ...(text ? { text } : {}),
    ...(transition ? { transition } : {}),
  };

  if (type === "full-screen-text") {
    return {
      ...base,
      backgroundColor: readBackgroundColor(record, path),
      type,
    };
  }

  if (type === "playwright-recording") {
    return {
      ...base,
      playwrightSceneId: readNonEmptyString(record, "playwrightSceneId", path),
      type,
    };
  }

  if (type === "static-image") {
    return {
      ...base,
      image: readImage(record, path),
      type,
    };
  }

  throw new Error(`${path}.type must be a supported Compositing scene type`);
}

function readBackgroundColor(record: Record<string, unknown>, path: string) {
  const background = assertRecord(record.background, `${path}.background`);
  const type = readNonEmptyString(background, "type", `${path}.background`);
  if (type !== "solid") {
    throw new Error(`${path}.background.type must be solid`);
  }
  return readNonEmptyString(background, "colour", `${path}.background`);
}

function readImage(record: Record<string, unknown>, path: string) {
  const image = assertRecord(record.image, `${path}.image`);
  return {
    alt: readNonEmptyString(image, "alt", `${path}.image`),
    assetPath: readNonEmptyString(image, "assetPath", `${path}.image`),
  };
}

function readOptionalText(
  record: Record<string, unknown>,
  path: string,
): CompositingTextStyle | undefined {
  if (record.text === undefined) {
    return undefined;
  }

  const text = assertRecord(record.text, `${path}.text`);
  return {
    color: readNonEmptyString(text, "text-colour", `${path}.text`),
    content: readNonEmptyString(text, "content", `${path}.text`),
    fontFamily: readNonEmptyString(text, "font", `${path}.text`),
    position: readTextPosition(text, path),
    size: readTextSize(text, path),
  };
}

function readTextPosition(
  record: Record<string, unknown>,
  path: string,
): CompositingTextStyle["position"] {
  const position = readNonEmptyString(record, "text-position", `${path}.text`);
  if (
    position !== "bottom-left" &&
    position !== "center" &&
    position !== "top-left"
  ) {
    throw new Error(`${path}.text.text-position must be a supported position`);
  }
  return position;
}

function readTextSize(
  record: Record<string, unknown>,
  path: string,
): CompositingTextStyle["size"] {
  const size = readNonEmptyString(record, "text-size", `${path}.text`);
  if (size !== "large" && size !== "medium" && size !== "small") {
    throw new Error(`${path}.text.text-size must be small, medium, or large`);
  }
  return size;
}

function readOptionalTransition(
  record: Record<string, unknown>,
  path: string,
): CompositingTransition | undefined {
  if (record.transition === undefined) {
    return undefined;
  }

  const transition = assertRecord(record.transition, `${path}.transition`);
  return {
    durationFrames: secondsToFrames(
      readPositiveNumber(transition, "durationSeconds", `${path}.transition`),
    ),
    in: readTransitionMode(transition, "in", path),
    out: readTransitionMode(transition, "out", path),
  };
}

function readTransitionMode(
  record: Record<string, unknown>,
  key: "in" | "out",
  path: string,
): CompositingTransition["in"] {
  const mode = readNonEmptyString(record, key, `${path}.transition`);
  if (mode !== "cut" && mode !== "fade") {
    throw new Error(`${path}.transition.${key} must be cut or fade`);
  }
  return mode;
}

function readAudio(
  record: Record<string, unknown>,
): FullVideoScriptPackage["audio"] {
  if (record.audio === undefined) {
    return undefined;
  }

  const audio = assertRecord(record.audio, "audio");
  const enabled = audio.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("audio.enabled must be a boolean");
  }

  const music =
    audio.music === undefined
      ? undefined
      : {
          id: readNonEmptyString(
            assertRecord(audio.music, "audio.music"),
            "id",
          ),
        };

  return { enabled, ...(music ? { music } : {}) };
}

function parseCaptureManifest(value: unknown): CaptureManifest {
  const record = assertRecord(value, "capture manifest");
  const scenes = record.scenes;
  if (!Array.isArray(scenes)) {
    throw new Error("capture manifest scenes must be an array");
  }

  return {
    baseUrl: readNonEmptyString(record, "baseUrl", "capture manifest"),
    createdAt: readNonEmptyString(record, "createdAt", "capture manifest"),
    keepTemp: readBoolean(record, "keepTemp", "capture manifest"),
    manifestPath: readNonEmptyString(
      record,
      "manifestPath",
      "capture manifest",
    ),
    runDirectory: readNonEmptyString(
      record,
      "runDirectory",
      "capture manifest",
    ),
    runId: readNonEmptyString(record, "runId", "capture manifest"),
    scenes: scenes.map((scene, sceneIndex) => {
      const sceneRecord = assertRecord(
        scene,
        `capture manifest.scenes[${sceneIndex}]`,
      );
      return {
        durationSeconds: readPositiveNumber(
          sceneRecord,
          "durationSeconds",
          `capture manifest.scenes[${sceneIndex}]`,
        ),
        sceneId: readNonEmptyString(
          sceneRecord,
          "sceneId",
          `capture manifest.scenes[${sceneIndex}]`,
        ),
        sectionId: readNonEmptyString(
          sceneRecord,
          "sectionId",
          `capture manifest.scenes[${sceneIndex}]`,
        ),
        videoPath: readNonEmptyString(
          sceneRecord,
          "videoPath",
          `capture manifest.scenes[${sceneIndex}]`,
        ),
      };
    }),
    scriptId: readNonEmptyString(record, "scriptId", "capture manifest"),
    temporary: true,
    title: readNonEmptyString(record, "title", "capture manifest"),
  };
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${parentPath}.${key} must be a boolean`);
  }
  return value;
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
) {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }

  return value;
}

function isApprovedFontFamily(
  fontFamily: string,
): fontFamily is ApprovedFontFamily {
  return fontFamily in fontAssetFiles;
}

function secondsToFrames(seconds: number) {
  return Math.round(seconds * FPS);
}

function createRunId() {
  return `composite-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

async function createDefaultRenderer(): Promise<VideoRenderer> {
  const { RemotionVideoRenderer } = await import(
    "../../shared/integrations/remotion/remotion-video-renderer"
  );
  return new RemotionVideoRenderer({
    bundleRoot: process.cwd(),
    entryPoint: join(
      process.cwd(),
      "src/server/shared/integrations/remotion/remotion-entry.tsx",
    ),
    tempRoot: join(tmpdir(), "makeademo-remotion-bundles"),
  });
}

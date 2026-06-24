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
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import {
  type DemoScript,
  parseDemoScript,
} from "../06-footage-capture/demo-script.schema";
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

export type CompositedVideoManifest = {
  createdAt: string;
  draftCompositeReview?: {
    attempts: number;
    findings: string[];
    status: "accepted" | "exhausted";
    warnings: string[];
  };
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
  retainLocalOutput?: boolean;
  renderer?: VideoRenderer;
  runId?: string;
  scriptDirectory?: string;
  scriptPackage?: unknown;
  scriptPath?: string;
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

  const scriptPackage = await readScriptPackage(input);
  const captureManifest = parseCaptureManifest(
    JSON.parse(await readFile(input.captureManifestPath, "utf8")),
  );

  if (captureManifest.scriptId !== scriptPackage.scriptId) {
    throw new Error(
      `capture manifest scriptId ${captureManifest.scriptId} does not match Demo Script scriptId ${scriptPackage.scriptId}`,
    );
  }

  const scriptDirectory =
    input.scriptDirectory ??
    (input.scriptPath === undefined
      ? projectRoot
      : dirname(resolve(input.scriptPath)));
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
    retainLocalOutput: input.retainLocalOutput ?? false,
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
    ...(finalVideo && !input.retainLocalOutput ? {} : { outputVideoPath }),
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

async function readScriptPackage(input: CompositeVideoFromScriptInput) {
  if (input.scriptPackage !== undefined) {
    return parseCompositingDemoScript(input.scriptPackage);
  }

  if (input.scriptPath === undefined) {
    throw new Error("scriptPath or scriptPackage is required");
  }

  return parseCompositingDemoScript(
    JSON.parse(await readFile(input.scriptPath, "utf8")),
  );
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
  retainLocalOutput: boolean;
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
  if (!input.retainLocalOutput) {
    await unlink(input.outputVideoPath);
  }

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
  scriptPackage: DemoScript;
}) {
  const capturedScenesById = new Map(
    input.captureManifest.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const textOverlaysBySceneId = new Map(
    input.scriptPackage.presentation.textOverlays.map((overlay) => [
      overlay.sceneId,
      {
        color: "#ffffff",
        content: overlay.content,
        fontFamily: overlay.font,
        position: overlay.position,
        size: overlay.size,
      } satisfies CompositingTextStyle,
    ]),
  );
  const transitionsBySceneId = new Map(
    input.scriptPackage.presentation.transitions.map((transition) => [
      transition.toSceneId,
      {
        durationFrames: secondsToFrames(transition.durationSeconds),
        in: transition.style,
        out: transition.style,
      } satisfies CompositingTransition,
    ]),
  );
  const scenes: CompositingScene[] = [];

  for (const scene of input.scriptPackage.scenes) {
    const capturedScene = capturedScenesById.get(scene.id);
    if (!capturedScene) {
      throw new Error(
        `missing captured Scene for Demo Script Scene ${scene.id}`,
      );
    }

    const extension = extname(capturedScene.videoPath) || ".webm";
    const sourcePublicPath = `scenes/${scene.id}${extension}`;
    await copyAsset(
      capturedScene.videoPath,
      join(input.publicDir, sourcePublicPath),
    );
    const text = textOverlaysBySceneId.get(scene.id);
    const transition = transitionsBySceneId.get(scene.id);
    scenes.push({
      durationFrames: secondsToFrames(capturedScene.durationSeconds),
      sceneId: scene.id,
      sourcePublicPath,
      ...(text ? { text } : {}),
      ...(transition ? { transition } : {}),
      type: "playwright-recording",
    });
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
  scriptPackage: DemoScript;
}) {
  if (!input.scriptPackage.presentation.music.enabled) {
    return undefined;
  }

  const musicId = input.scriptPackage.presentation.music.trackId;
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

function parseCompositingDemoScript(value: unknown): DemoScript {
  const scriptPackage = parseDemoScript(value);
  if (scriptPackage.format !== "16:9") {
    throw new Error("format must be 16:9 for Compositing");
  }

  return scriptPackage;
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
    qualityFindings: readStringArray(record.qualityFindings, "qualityFindings"),
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

function readStringArray(value: unknown, path: string) {
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`capture manifest.${path} must be an array of strings`);
  }

  return value;
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

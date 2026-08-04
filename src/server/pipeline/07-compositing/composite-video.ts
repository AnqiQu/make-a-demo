import { createReadStream } from "node:fs";
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
import { createDemoScriptDigest } from "../06-footage-capture/demo-script-identity";
import {
  type DemoScript,
  demoScriptLimits,
  parseDemoScript,
} from "../06-footage-capture/demo-script.schema";
import type { FinalVideoEmailNotifier } from "../final-output/final-video-email-notifier.interface";
import {
  DraftCompositeReviewRejectedError,
  type DraftCompositeReviewer,
} from "./draft-composite-reviewer.interface";
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
    status: "accepted";
    warnings: string[];
  };
  draftCompositeReviewPath?: string;
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
  draftCompositeReviewer?: DraftCompositeReviewer;
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
  staticImageAssets?: Readonly<Record<string, { sourcePath: string }>>;
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
  const draftCompositeReviewPath = join(
    runDirectory,
    "draft-composite-review.json",
  );

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
  const scriptDigest = createDemoScriptDigest(scriptPackage);
  if (
    captureManifest.scriptDigest !== undefined &&
    captureManifest.scriptDigest !== scriptDigest
  ) {
    throw new Error(
      `capture manifest Demo Script digest does not match accepted Demo Script ${scriptPackage.scriptId}`,
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
    staticImageAssets: input.staticImageAssets ?? {},
  });
  assertValidSceneTransitions(scenes);
  const durationInFrames = scenes.reduce(
    (total, scene) =>
      total + scene.durationFrames - (scene.transitionIn?.durationFrames ?? 0),
    0,
  );
  const maxDurationInFrames = demoScriptLimits.maxTotalDurationSeconds * FPS;
  if (durationInFrames > maxDurationInFrames) {
    throw new Error(
      `Demo video must be at most ${demoScriptLimits.maxTotalDurationSeconds} seconds (${maxDurationInFrames} frames)`,
    );
  }
  const [fontAssets, music] = await Promise.all([
    stageFontAssets({
      projectRoot,
      publicDir,
      scenes,
    }),
    stageMusicAsset({
      projectRoot,
      publicDir,
      scriptPackage,
    }),
  ]);
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
  const draftCompositeReview = await reviewDraftComposite({
    draftCompositeReviewPath,
    outputVideoPath,
    publishing: input.demoRequestId !== undefined,
    renderPlanPath,
    reviewer: input.draftCompositeReviewer,
    scriptId: scriptPackage.scriptId,
  });
  const finalVideo = await storeAndLinkFinalVideo({
    demoRequestId: input.demoRequestId,
    demoRequestStore: input.demoRequestStore,
    finalVideoStorage: input.finalVideoStorage,
    outputVideoPath,
    publicAppBaseUrl: input.publicAppBaseUrl,
    retainLocalOutput: input.retainLocalOutput ?? false,
    runId,
    scriptDigest,
    scriptId: scriptPackage.scriptId,
    title: scriptPackage.title,
    emailNotifier: input.finalVideoEmailNotifier,
  });

  const manifest: CompositedVideoManifest = {
    createdAt: new Date().toISOString(),
    ...(draftCompositeReview === undefined
      ? {}
      : {
          draftCompositeReview,
          draftCompositeReviewPath,
        }),
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

async function reviewDraftComposite(input: {
  draftCompositeReviewPath: string;
  outputVideoPath: string;
  publishing: boolean;
  renderPlanPath: string;
  reviewer: DraftCompositeReviewer | undefined;
  scriptId: string;
}): Promise<CompositedVideoManifest["draftCompositeReview"]> {
  if (input.reviewer === undefined) {
    if (input.publishing) {
      throw new Error(
        "Draft Composite review is required before final publication",
      );
    }
    return undefined;
  }

  const result = await input.reviewer.reviewDraftComposite({
    attempt: 1,
    outputVideoPath: input.outputVideoPath,
    renderPlanPath: input.renderPlanPath,
    scriptId: input.scriptId,
  });
  const reviewArtifact = {
    attempts: 1,
    findings: [...result.findings],
    status: result.status,
    warnings: [...result.warnings],
  };
  await writeFile(
    input.draftCompositeReviewPath,
    `${JSON.stringify(reviewArtifact, null, 2)}\n`,
  );
  if (result.status !== "accepted") {
    throw new DraftCompositeReviewRejectedError({
      findings: result.findings,
      reviewArtifactPath: input.draftCompositeReviewPath,
    });
  }

  return {
    attempts: 1,
    findings: [...result.findings],
    status: "accepted",
    warnings: [...result.warnings],
  };
}

function assertValidSceneTransitions(scenes: CompositingScene[]): void {
  for (const [sceneIndex, scene] of scenes.entries()) {
    const transition = scene.transitionIn;
    if (!transition) {
      continue;
    }
    const previousScene = scenes[sceneIndex - 1];
    if (
      !previousScene ||
      transition.fromSceneId !== previousScene.sceneId ||
      transition.toSceneId !== scene.sceneId
    ) {
      throw new Error(
        `fade transition ${transition.fromSceneId} -> ${transition.toSceneId} must connect adjacent Scenes in render order`,
      );
    }
    if (
      transition.durationFrames >= previousScene.durationFrames ||
      transition.durationFrames >= scene.durationFrames
    ) {
      throw new Error(
        `fade transition ${transition.fromSceneId} -> ${transition.toSceneId} must be shorter than both adjacent Scenes`,
      );
    }
    const outgoingTransition = scenes[sceneIndex + 1]?.transitionIn;
    if (
      outgoingTransition?.fromSceneId === scene.sceneId &&
      transition.durationFrames + outgoingTransition.durationFrames >=
        scene.durationFrames
    ) {
      throw new Error(
        `fade transitions into and out of Scene ${scene.sceneId} must total less than its duration`,
      );
    }
  }
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
  scriptDigest: string;
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

  const outputVideoStat = await stat(input.outputVideoPath);
  const finalVideo = await input.finalVideoStorage.storeFinalVideo({
    body: createReadStream(input.outputVideoPath),
    contentLength: outputVideoStat.size,
    contentType: "video/mp4",
    demoRequestId: input.demoRequestId,
    fileName: "final-video.mp4",
    runId: input.runId,
    scriptDigest: input.scriptDigest,
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
  staticImageAssets: Readonly<Record<string, { sourcePath: string }>>;
}) {
  const capturedScenesById = new Map(
    input.captureManifest.scenes.map((scene) => [scene.sceneId, scene]),
  );
  const textOverlaysBySceneId = new Map<string, CompositingTextStyle[]>();
  for (const overlay of input.scriptPackage.presentation.textOverlays) {
    const overlays = textOverlaysBySceneId.get(overlay.sceneId) ?? [];
    overlays.push({
      color: "#ffffff",
      content: overlay.content,
      fontFamily: overlay.font,
      position: overlay.position,
      size: overlay.size,
    });
    textOverlaysBySceneId.set(overlay.sceneId, overlays);
  }
  const transitionsBySceneId = new Map(
    input.scriptPackage.presentation.transitions.flatMap((transition) =>
      transition.style === "fade"
        ? [
            [
              transition.toSceneId,
              {
                durationFrames: secondsToFrames(transition.durationSeconds),
                fromSceneId: transition.fromSceneId,
                style: transition.style,
                toSceneId: transition.toSceneId,
              } satisfies CompositingTransition,
            ] as const,
          ]
        : [],
    ),
  );
  return Promise.all(
    input.scriptPackage.scenes.map(async (scene): Promise<CompositingScene> => {
      const textOverlays = textOverlaysBySceneId.get(scene.id) ?? [];
      const transitionIn = transitionsBySceneId.get(scene.id);
      const shared = {
        sceneId: scene.id,
        textOverlays,
        ...(transitionIn ? { transitionIn } : {}),
      };

      if (scene.type === "full-screen-text") {
        return {
          ...shared,
          backgroundColor: scene.backgroundColor,
          durationFrames: secondsToFrames(scene.durationSeconds),
          text: {
            color: scene.text.color,
            content: scene.text.content,
            fontFamily: scene.text.font,
            position: scene.text.position,
            size: scene.text.size,
          },
          type: scene.type,
        };
      }

      if (scene.type === "static-image") {
        // Own-property only: a valid asset id like "constructor" would
        // otherwise resolve to an inherited Object member and pass the guard.
        const asset = Object.hasOwn(input.staticImageAssets, scene.assetId)
          ? input.staticImageAssets[scene.assetId]
          : undefined;
        if (!asset) {
          throw new Error(
            `static-image Scene ${scene.id} references unknown trusted asset ${scene.assetId}`,
          );
        }
        const extension = extname(asset.sourcePath) || ".png";
        const sourcePublicPath = `scenes/${scene.id}${extension}`;
        await copyAsset(
          asset.sourcePath,
          join(input.publicDir, sourcePublicPath),
        );
        return {
          ...shared,
          alt: scene.alt,
          durationFrames: secondsToFrames(scene.durationSeconds),
          sourcePublicPath,
          type: scene.type,
        };
      }

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
      return {
        ...shared,
        durationFrames: secondsToFrames(capturedScene.durationSeconds),
        sourcePublicPath,
        type: scene.type,
      };
    }),
  );
}

async function stageFontAssets(input: {
  projectRoot: string;
  publicDir: string;
  scenes: CompositingScene[];
}) {
  const fontAssets: Record<string, CompositingFontAsset> = {};
  const fontFamilies = new Set(
    input.scenes.flatMap((scene) => [
      ...(scene.type === "full-screen-text" ? [scene.text.fontFamily] : []),
      ...scene.textOverlays.map((text) => text.fontFamily),
    ]),
  );

  const stagedFonts = await Promise.all(
    Array.from(fontFamilies).map(async (fontFamily) => {
      if (!isApprovedFontFamily(fontFamily)) {
        throw new Error(`unsupported Compositing font ${fontFamily}`);
      }

      const filename = fontAssetFiles[fontFamily];
      const publicPath = `fonts/${filename}`;
      await copyAsset(
        join(input.projectRoot, "assets", "fonts", filename),
        join(input.publicDir, publicPath),
      );
      return [fontFamily, { family: fontFamily, publicPath }] as const;
    }),
  );

  for (const [fontFamily, asset] of stagedFonts) {
    fontAssets[fontFamily] = asset;
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

async function copyAsset(sourcePath: string, destinationPath: string) {
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

function parseCompositingDemoScript(value: unknown): DemoScript {
  return parseDemoScript(value);
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
    ...(record.scriptDigest === undefined
      ? {}
      : {
          scriptDigest: readSha256Digest(
            record,
            "scriptDigest",
            "capture manifest",
          ),
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

function readSha256Digest(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
) {
  const value = readNonEmptyString(record, key, parentPath);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${parentPath}.${key} must be a SHA-256 digest`);
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
  return Object.hasOwn(fontAssetFiles, fontFamily);
}

function secondsToFrames(seconds: number) {
  const frames = Math.round(seconds * FPS);
  if (frames < 1) {
    throw new Error(
      `duration ${seconds} seconds must produce at least one frame at ${FPS} fps`,
    );
  }
  if (!Number.isSafeInteger(frames)) {
    throw new Error(
      `duration ${seconds} seconds must produce a safe integer frame count at ${FPS} fps`,
    );
  }
  return frames;
}

function createRunId() {
  return `composite-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

async function createDefaultRenderer(): Promise<VideoRenderer> {
  const { RemotionVideoRenderer } = await import(
    "../../shared/integrations/remotion/remotion-video-renderer"
  );
  return new RemotionVideoRenderer({
    ...(process.env.MAKEADEMO_REMOTION_BROWSER_EXECUTABLE === undefined
      ? {}
      : {
          browserExecutable: process.env.MAKEADEMO_REMOTION_BROWSER_EXECUTABLE,
        }),
    bundleRoot: process.cwd(),
    entryPoint: join(
      process.cwd(),
      "src/server/shared/integrations/remotion/remotion-entry.tsx",
    ),
    tempRoot: join(tmpdir(), "makeademo-remotion-bundles"),
  });
}

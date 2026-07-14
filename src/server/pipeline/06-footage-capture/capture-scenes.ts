import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHarnessWorkspaceHandle } from "../../agent-harness/daytona/workspace.interface";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { assertDemoScriptCaptureSdkContract } from "./capture-sdk-contract";
import { createDemoScriptDigest } from "./demo-script-identity";
import { type DemoScript, parseDemoScript } from "./demo-script.schema";
import { PreparedWorkspacePlaywrightSceneRecorder } from "./playwright-scene-recorder";
import type { SceneRecorder } from "./scene-recorder.interface";

type CapturedSceneManifestEntry = {
  durationSeconds: number;
  sceneId: string;
  sectionId: string;
  videoPath: string;
};

export type CaptureManifest = {
  baseUrl: string;
  captureRuntimeResetArtifactPath?: string;
  createdAt: string;
  externalResourceManifestSha256?: string;
  keepTemp: boolean;
  qualityFindings: string[];
  manifestPath: string;
  runDirectory: string;
  runId: string;
  scenes: CapturedSceneManifestEntry[];
  scriptDigest?: string;
  scriptId: string;
  markerLogPath?: string;
  rawTakePath?: string;
  stderrLogPath?: string;
  stdoutLogPath?: string;
  temporary: true;
  title: string;
};

export type CaptureScenesFromScriptInput = {
  baseUrl: string;
  captureRuntimeReset?: {
    artifactPath: string;
    stage: "capture-runtime-reset";
    status: "passed";
  };
  externalResourceCache?: {
    directory: string;
    manifest: ExternalResourceManifest;
  };
  keepTemp?: boolean;
  preparationWorkspace?: AgentHarnessWorkspaceHandle;
  recorder?: SceneRecorder;
  runId?: string;
  scriptPackage?: unknown;
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
  const scriptDigest = createDemoScriptDigest(scriptPackage);
  const browserScenes = scriptPackage.scenes.filter(
    (scene) => scene.type === "playwright-recording",
  );
  if (browserScenes.length > 0) {
    assertDemoScriptCaptureSdkContract({
      ...scriptPackage,
      scenes: browserScenes,
    });
  }
  const scenes: CapturedSceneManifestEntry[] = [];

  try {
    if (browserScenes.length > 0) {
      const recorder = input.recorder ?? createPreparedWorkspaceRecorder(input);
      if (
        input.recorder === undefined &&
        (input.captureRuntimeReset?.stage !== "capture-runtime-reset" ||
          input.captureRuntimeReset.status !== "passed" ||
          input.captureRuntimeReset.artifactPath.trim().length === 0)
      ) {
        throw new Error(
          "Footage Capture requires a passed capture-runtime-reset proof",
        );
      }
      if (scriptPackage.demoPlaywrightScript === undefined) {
        throw new Error(
          "Footage Capture requires compiled Playwright source for browser Scenes.",
        );
      }
      const recordedScenes = await recorder.recordScenes({
        baseUrl: input.baseUrl,
        demoPlaywrightScript: scriptPackage.demoPlaywrightScript,
        ...(input.externalResourceCache === undefined
          ? {}
          : {
              externalResourceManifest: input.externalResourceCache.manifest,
            }),
        retainRawTake: keepTemp,
        runDirectory,
        scenes: browserScenes,
        sectionId: "demo-script",
        ...(scriptPackage.setupActions === undefined
          ? {}
          : { setupActions: scriptPackage.setupActions }),
      });

      scenes.push(...recordedScenes);
    }

    const manifestPath = join(runDirectory, "capture-manifest.json");
    const manifest: CaptureManifest = {
      baseUrl: input.baseUrl,
      ...(input.captureRuntimeReset === undefined
        ? {}
        : {
            captureRuntimeResetArtifactPath:
              input.captureRuntimeReset.artifactPath,
          }),
      createdAt: new Date().toISOString(),
      ...(input.externalResourceCache === undefined
        ? {}
        : {
            externalResourceManifestSha256: `sha256:${createHash("sha256")
              .update(JSON.stringify(input.externalResourceCache.manifest))
              .digest("hex")}`,
          }),
      keepTemp,
      manifestPath,
      runDirectory,
      runId,
      scenes,
      scriptDigest,
      scriptId: scriptPackage.scriptId,
      ...(browserScenes.length === 0
        ? {}
        : {
            markerLogPath: join(runDirectory, "scene-markers.jsonl"),
            stderrLogPath: join(runDirectory, "stderr.log"),
            stdoutLogPath: join(runDirectory, "stdout.log"),
          }),
      ...(keepTemp && browserScenes.length > 0
        ? {
            rawTakePath: join(
              runDirectory,
              "raw-scenes",
              "continuous-take.webm",
            ),
          }
        : {}),
      qualityFindings: [],
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

function createPreparedWorkspaceRecorder(input: CaptureScenesFromScriptInput) {
  if (input.preparationWorkspace === undefined) {
    throw new Error(
      "Footage Capture requires a prepared workspace; local capture is not allowed.",
    );
  }

  return new PreparedWorkspacePlaywrightSceneRecorder({
    ...(input.externalResourceCache === undefined
      ? {}
      : { externalResourceCache: input.externalResourceCache }),
    preparationWorkspace: input.preparationWorkspace,
  });
}

async function readScriptPackage(input: CaptureScenesFromScriptInput) {
  if (input.scriptPackage !== undefined) {
    return parseDemoScript(input.scriptPackage);
  }

  if (input.scriptPath === undefined) {
    throw new Error("scriptPath or scriptPackage is required");
  }

  return parseDemoScript(JSON.parse(await readFile(input.scriptPath, "utf8")));
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

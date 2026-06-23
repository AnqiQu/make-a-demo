import { assertDemoScriptCaptureSdkContract } from "../06-footage-capture/capture-sdk-contract";
import {
  type SceneDescription,
  parseDemoScript,
} from "../06-footage-capture/demo-script.schema";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "./capture-path-validator.interface";
import type { ProjectValidationInput } from "./project-runtime-preflight/project-validator";
import type { ProjectValidationResult } from "./project-runtime-preflight/validation-result";

const capturePathDiagnosticsLogPath =
  "/workspace/.makeademo/capture-path-validation-diagnostics.jsonl";

export type CapturePathSceneValidationInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  scene: SceneDescription;
  sectionId: string;
};

export type CapturePathSceneValidationResult =
  | {
      logs: string[];
      runDirectory?: string;
      scriptPath?: string;
      status: "succeeded";
      stderrPath?: string;
      stdoutPath?: string;
    }
  | {
      blockedNetworkAttempts?: CapturePathValidationResult["blockedNetworkAttempts"];
      failedAction?: string;
      failureReason: string;
      logs: string[];
      runDirectory?: string;
      screenshotArtifactId?: string;
      scriptPath?: string;
      status: "failed";
      stderrPath?: string;
      stdoutPath?: string;
    };

type ParsedSceneMarker =
  | {
      event: "failed" | "started" | "succeeded";
      message?: string;
      sceneId: string;
      status: "valid";
    }
  | { line: string; status: "malformed" };

/**
 * Dry-runs one Scene Description without recording final Scene footage.
 * Implementations must execute generated Browser Actions quickly, report failed
 * actions where possible, and must not apply recording-only cursor or typing effects.
 */
export interface CapturePathSceneValidator {
  validateScene(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult>;
}

export type CapturePathValidationDependencies = {
  sceneValidator: CapturePathSceneValidator;
  validateProject(
    input: ProjectValidationInput,
  ): Promise<ProjectValidationResult>;
};

export async function validateCapturePath(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
): Promise<CapturePathValidationResult> {
  await writeCapturePathDiagnostics(input, {
    event: "capture-path-validation.run.started",
  });
  await writeCapturePathSandboxLog(input, {
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.runtime-preflight.started",
  });
  await writeCapturePathDiagnostics(input, {
    event: "capture-path-validation.runtime-preflight.started",
  });
  const projectValidation = await dependencies.validateProject({
    preparationManifest: input.preparationManifest,
    ...(input.preparationWorkspace === undefined
      ? {}
      : { preparationWorkspace: input.preparationWorkspace }),
  });

  if (projectValidation.status === "failed") {
    const failureLogExcerpt = createLogExcerpt(projectValidation.logs);
    await writeCapturePathSandboxLog(input, {
      blockedNetworkAttemptCount:
        projectValidation.blockedNetworkAttempts.length,
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
      event: "capture-path-validation.runtime-preflight.failed",
      failureLogExcerpt,
      failureReason: projectValidation.failureReason,
      warningCount: projectValidation.warnings.length,
    });
    await writeCapturePathDiagnostics(input, {
      blockedNetworkAttemptCount:
        projectValidation.blockedNetworkAttempts.length,
      event: "capture-path-validation.runtime-preflight.failed",
      failureLogExcerpt,
      failureReason: projectValidation.failureReason,
      logs: projectValidation.logs,
      warningCount: projectValidation.warnings.length,
    });
    return {
      ...projectValidation,
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
    };
  }

  await writeCapturePathSandboxLog(input, {
    blockedNetworkAttemptCount: projectValidation.blockedNetworkAttempts.length,
    browserUrl: projectValidation.browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.runtime-preflight.succeeded",
    warningCount: projectValidation.warnings.length,
  });
  await writeCapturePathDiagnostics(input, {
    blockedNetworkAttemptCount: projectValidation.blockedNetworkAttempts.length,
    browserUrl: projectValidation.browserUrl,
    event: "capture-path-validation.runtime-preflight.succeeded",
    logs: projectValidation.logs,
    warningCount: projectValidation.warnings.length,
  });

  const scriptPackage = parseDemoScript(input.videoScriptPackage);
  assertDemoScriptCaptureSdkContract(scriptPackage);
  const logs = [...projectValidation.logs];
  const browserUrl =
    projectValidation.browserUrl ?? input.preparationManifest.url;

  const firstScene = scriptPackage.scenes[0];
  if (firstScene === undefined) {
    throw new Error("Demo Script must declare at least one Scene.");
  }
  await writeCapturePathSandboxLog(input, {
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.demo-script.started",
    sceneCount: scriptPackage.scenes.length,
  });
  await writeCapturePathDiagnostics(input, {
    event: "capture-path-validation.demo-script.started",
    scenes: scriptPackage.scenes.map((scene) => ({
      expectedVisibleOutcome: scene.expectedVisibleOutcome,
      sceneDescription: scene.humanReadableDescription,
      sceneId: scene.id,
    })),
  });
  const sceneResult = await dependencies.sceneValidator.validateScene({
    baseUrl: browserUrl,
    demoPlaywrightScript: scriptPackage.demoPlaywrightScript,
    scene: firstScene,
    sectionId: "demo-script",
  });
  logs.push(...sceneResult.logs);

  if (sceneResult.status === "failed") {
    return await capturePathSceneFailure({
      browserUrl,
      input,
      logs,
      projectValidation,
      sceneId: readFailedSceneId(sceneResult.logs) ?? firstScene.id,
      sceneResult,
    });
  }

  const markerValidation = validateSceneMarkers(
    sceneResult.logs,
    scriptPackage.scenes.map((scene) => scene.id),
  );
  if (markerValidation.status === "failed") {
    return await capturePathSceneFailure({
      browserUrl,
      input,
      logs,
      projectValidation,
      sceneId: markerValidation.sceneId ?? firstScene.id,
      sceneResult: {
        ...sceneResult,
        failureReason: markerValidation.reason,
        status: "failed",
      },
    });
  }

  for (const scene of scriptPackage.scenes) {
    await writeCapturePathSandboxLog(input, {
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
      event: "capture-path-validation.scene.succeeded",
      runDirectory: sceneResult.runDirectory,
      sceneId: scene.id,
      scriptPath: sceneResult.scriptPath,
      sectionId: "demo-script",
      stderrPath: sceneResult.stderrPath,
      stdoutPath: sceneResult.stdoutPath,
    });
    await writeCapturePathDiagnostics(input, {
      event: "capture-path-validation.scene.succeeded",
      logs: sceneResult.logs,
      runDirectory: sceneResult.runDirectory,
      sceneId: scene.id,
      scriptPath: sceneResult.scriptPath,
      sectionId: "demo-script",
      stderrPath: sceneResult.stderrPath,
      stdoutPath: sceneResult.stdoutPath,
    });
  }

  await writeCapturePathDiagnostics(input, {
    event: "capture-path-validation.run.succeeded",
    sceneCount: scriptPackage.scenes.length,
  });
  return {
    blockedNetworkAttempts: [],
    browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    logs,
    ...(projectValidation.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: projectValidation.screenshotArtifactId }),
    status: "succeeded",
    warnings: projectValidation.warnings,
  };
}

async function capturePathSceneFailure(input: {
  browserUrl: string;
  input: CapturePathValidationInput;
  logs: string[];
  projectValidation: ProjectValidationResult & { warnings: string[] };
  sceneId: string;
  sceneResult: Extract<CapturePathSceneValidationResult, { status: "failed" }>;
}): Promise<CapturePathValidationResult> {
  const failureLogExcerpt = createLogExcerpt(input.sceneResult.logs);
  await writeCapturePathSandboxLog(input.input, {
    blockedNetworkAttemptCount:
      input.sceneResult.blockedNetworkAttempts?.length ?? 0,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.scene.failed",
    failedAction: input.sceneResult.failedAction,
    failureLogExcerpt,
    failureReason: input.sceneResult.failureReason,
    runDirectory: input.sceneResult.runDirectory,
    sceneId: input.sceneId,
    scriptPath: input.sceneResult.scriptPath,
    screenshotArtifactId: input.sceneResult.screenshotArtifactId,
    sectionId: "demo-script",
    stderrPath: input.sceneResult.stderrPath,
    stdoutPath: input.sceneResult.stdoutPath,
  });
  await writeCapturePathDiagnostics(input.input, {
    blockedNetworkAttemptCount:
      input.sceneResult.blockedNetworkAttempts?.length ?? 0,
    event: "capture-path-validation.scene.failed",
    failedAction: input.sceneResult.failedAction,
    failureLogExcerpt,
    failureReason: input.sceneResult.failureReason,
    logs: input.sceneResult.logs,
    runDirectory: input.sceneResult.runDirectory,
    sceneId: input.sceneId,
    scriptPath: input.sceneResult.scriptPath,
    screenshotArtifactId: input.sceneResult.screenshotArtifactId,
    sectionId: "demo-script",
    stderrPath: input.sceneResult.stderrPath,
    stdoutPath: input.sceneResult.stdoutPath,
  });

  return {
    blockedNetworkAttempts: input.sceneResult.blockedNetworkAttempts ?? [],
    browserUrl: input.browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    failedSceneId: input.sceneId,
    failureReason: input.sceneResult.failureReason,
    logs: input.logs,
    ...(input.sceneResult.failedAction === undefined
      ? {}
      : { failedAction: input.sceneResult.failedAction }),
    ...(input.sceneResult.runDirectory === undefined
      ? {}
      : { runDirectory: input.sceneResult.runDirectory }),
    ...(input.sceneResult.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: input.sceneResult.screenshotArtifactId }),
    ...(input.sceneResult.scriptPath === undefined
      ? {}
      : { scriptPath: input.sceneResult.scriptPath }),
    ...(input.sceneResult.stderrPath === undefined
      ? {}
      : { stderrPath: input.sceneResult.stderrPath }),
    ...(input.sceneResult.stdoutPath === undefined
      ? {}
      : { stdoutPath: input.sceneResult.stdoutPath }),
    status: "failed",
    warnings: input.projectValidation.warnings,
  };
}

function validateSceneMarkers(logs: string[], sceneIds: string[]) {
  const markers = readSceneMarkers(logs);
  const completed = new Set<string>();
  const open = new Set<string>();

  for (const marker of markers) {
    if (marker.status !== "valid") {
      return {
        reason: `Capture Path emitted malformed Scene marker: ${marker.line}`,
        status: "failed" as const,
      };
    }

    const validMarker = marker;

    if (!sceneIds.includes(validMarker.sceneId)) {
      return {
        reason: `Capture Path emitted undeclared Scene marker ${validMarker.sceneId}.`,
        sceneId: validMarker.sceneId,
        status: "failed" as const,
      };
    }

    if (validMarker.event === "started") {
      if (open.size > 0) {
        return {
          reason: "Capture Path emitted nested Scene markers.",
          sceneId: validMarker.sceneId,
          status: "failed" as const,
        };
      }
      if (completed.has(validMarker.sceneId) || open.has(validMarker.sceneId)) {
        return {
          reason: `Capture Path emitted duplicate Scene marker ${validMarker.sceneId}.`,
          sceneId: validMarker.sceneId,
          status: "failed" as const,
        };
      }
      open.add(validMarker.sceneId);
      continue;
    }

    if (!open.has(validMarker.sceneId)) {
      return {
        reason: `Capture Path emitted ${validMarker.event} marker before start for Scene ${validMarker.sceneId}.`,
        sceneId: validMarker.sceneId,
        status: "failed" as const,
      };
    }
    open.delete(validMarker.sceneId);

    if (validMarker.event === "failed") {
      return {
        reason: `Scene ${validMarker.sceneId} failed during Capture Path Validation.${
          validMarker.message === undefined ? "" : ` ${validMarker.message}`
        }`,
        sceneId: validMarker.sceneId,
        status: "failed" as const,
      };
    }

    completed.add(validMarker.sceneId);
  }

  if (open.size > 0) {
    return {
      reason: "Capture Path emitted Scene start marker without an end marker.",
      sceneId: [...open][0],
      status: "failed" as const,
    };
  }

  for (const sceneId of sceneIds) {
    if (!completed.has(sceneId)) {
      return {
        reason: `Scene ${sceneId} did not emit complete Capture Path markers.`,
        sceneId,
        status: "failed" as const,
      };
    }
  }

  return { status: "succeeded" as const };
}

function readFailedSceneId(logs: string[]) {
  for (const marker of readSceneMarkers(logs)) {
    if (marker.status === "valid" && marker.event === "failed") {
      return marker.sceneId;
    }
  }

  return undefined;
}

function readSceneMarkers(logs: string[]): ParsedSceneMarker[] {
  return logs
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:scene] "))
    .map((line) => readSceneMarker(line));
}

function readSceneMarker(line: string): ParsedSceneMarker {
  try {
    const marker = JSON.parse(line.slice("[makeademo:scene] ".length));
    if (
      typeof marker === "object" &&
      marker !== null &&
      typeof marker.sceneId === "string" &&
      (marker.event === "started" ||
        marker.event === "succeeded" ||
        marker.event === "failed")
    ) {
      return { ...marker, status: "valid" };
    }
  } catch {}

  return { line, status: "malformed" };
}

async function writeCapturePathDiagnostics(
  input: CapturePathValidationInput,
  entry: Record<string, unknown>,
) {
  const line = JSON.stringify(
    removeUndefinedValues({
      ...entry,
      repoUrl: input.preparationManifest.repoUrl,
      scriptId: input.videoScriptPackage.scriptId,
      stage: "capture-path-validation",
      workspaceId: input.preparationManifest.workspaceId,
    }),
  );

  const result = await input.preparationWorkspace?.workspace.execute(
    `mkdir -p ${shellQuote(dirname(capturePathDiagnosticsLogPath))} && printf '%s\\n' ${shellQuote(line)} >> ${shellQuote(capturePathDiagnosticsLogPath)}`,
  );

  if (result !== undefined && result.exitCode !== 0) {
    await writeCapturePathSandboxLog(input, {
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
      event: "capture-path-validation.diagnostics.write_failed",
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
}

async function writeCapturePathSandboxLog(
  input: CapturePathValidationInput,
  entry: Record<string, unknown>,
) {
  await input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...removeUndefinedValues(entry),
    repoUrl: input.preparationManifest.repoUrl,
    scriptId: input.videoScriptPackage.scriptId,
    stage: "capture-path-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
}

function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function createLogExcerpt(logs: string[]) {
  return logs.join("\n").slice(0, 4_000);
}

function dirname(path: string) {
  return path.slice(0, path.lastIndexOf("/"));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

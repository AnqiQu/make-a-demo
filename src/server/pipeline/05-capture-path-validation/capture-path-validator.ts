import {
  type PipelineEventLogger,
  createPipelineEventLogger,
} from "../../shared/logging/pipeline-event-logger";
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

const capturePathDiagnosticsLogPath = "/workspace/.makeademo/sandbox-log.jsonl";
const defaultDiagnosticsWriteTimeoutMs = 5_000;
const defaultDiagnosticsLogger = createPipelineEventLogger({
  base: { component: "capture-path-validation" },
  sinks: [
    {
      write(line) {
        process.stderr.write(line);
      },
    },
  ],
});

export type CapturePathSceneValidationInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  preparationWorkspace?: CapturePathValidationInput["preparationWorkspace"];
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
      errorMessage?: string;
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
  diagnosticsLogger?: Pick<PipelineEventLogger, "warn">;
  diagnosticsWriteTimeoutMs?: number;
  sceneValidator: CapturePathSceneValidator;
  sceneValidationTimeoutMs?: number;
  validateProject(
    input: ProjectValidationInput,
  ): Promise<ProjectValidationResult>;
};

const defaultSceneValidationTimeoutMs = 2 * 60_000;

export async function validateCapturePath(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
): Promise<CapturePathValidationResult> {
  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.run.started",
  });

  let scriptPackage: ReturnType<typeof parseDemoScript>;
  let firstScene: SceneDescription;
  try {
    scriptPackage = parseDemoScript(input.demoScriptPackage);
    assertDemoScriptCaptureSdkContract(scriptPackage);
    const declaredFirstScene = scriptPackage.scenes[0];
    if (declaredFirstScene === undefined) {
      throw new Error("Demo Script must declare at least one Scene.");
    }
    firstScene = declaredFirstScene;
  } catch (error) {
    return await capturePathDemoScriptFailure({
      browserUrl: input.preparationManifest.url,
      dependencies,
      error,
      input,
      logs: [],
    });
  }

  await writeCapturePathSandboxLog(input, {
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.runtime-preflight.started",
  });
  await writeCapturePathDiagnostics(input, dependencies, {
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
    await writeCapturePathDiagnostics(input, dependencies, {
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
  await writeCapturePathDiagnostics(input, dependencies, {
    blockedNetworkAttemptCount: projectValidation.blockedNetworkAttempts.length,
    browserUrl: projectValidation.browserUrl,
    event: "capture-path-validation.runtime-preflight.succeeded",
    logs: projectValidation.logs,
    warningCount: projectValidation.warnings.length,
  });

  const logs = [...projectValidation.logs];
  const browserUrl =
    projectValidation.browserUrl ?? input.preparationManifest.url;
  await writeCapturePathSandboxLog(input, {
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.demo-script.started",
    sceneCount: scriptPackage.scenes.length,
  });
  await writeCapturePathDiagnostics(input, dependencies, {
    event: "capture-path-validation.demo-script.started",
    scenes: scriptPackage.scenes.map((scene) => ({
      expectedVisibleOutcome: scene.expectedVisibleOutcome,
      sceneDescription: scene.humanReadableDescription,
      sceneId: scene.id,
    })),
  });
  let sceneResult: CapturePathSceneValidationResult;
  try {
    sceneResult = await withTimeout(
      dependencies.sceneValidator.validateScene({
        baseUrl: browserUrl,
        demoPlaywrightScript: scriptPackage.demoPlaywrightScript,
        ...(input.preparationWorkspace === undefined
          ? {}
          : { preparationWorkspace: input.preparationWorkspace }),
        scene: firstScene,
        sectionId: "demo-script",
      }),
      dependencies.sceneValidationTimeoutMs ?? defaultSceneValidationTimeoutMs,
      `Demo Script dry-run timed out after ${
        dependencies.sceneValidationTimeoutMs ?? defaultSceneValidationTimeoutMs
      }ms.`,
    );
  } catch (error) {
    if (!(error instanceof CapturePathValidationTimeoutError)) {
      throw error;
    }

    sceneResult = {
      failureReason: error.message,
      logs: [error.message],
      status: "failed",
    };
  }
  logs.push(...sceneResult.logs);

  if (sceneResult.status === "failed") {
    return await capturePathSceneFailure({
      browserUrl,
      dependencies,
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
      dependencies,
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
    await writeCapturePathDiagnostics(input, dependencies, {
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

  await writeCapturePathDiagnostics(input, dependencies, {
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

async function capturePathDemoScriptFailure(input: {
  browserUrl: string;
  dependencies: CapturePathValidationDependencies;
  error: unknown;
  input: CapturePathValidationInput;
  logs: string[];
  projectValidation?: ProjectValidationResult & { warnings: string[] };
}): Promise<CapturePathValidationResult> {
  const failureReason = readErrorMessage(input.error);
  const failedSceneId = readFailedContractSceneId(failureReason);
  const logs = [...input.logs, failureReason];
  const failureLogExcerpt = createLogExcerpt(logs);
  const blockedNetworkAttempts =
    input.projectValidation?.blockedNetworkAttempts ?? [];
  const warnings = input.projectValidation?.warnings ?? [];
  await writeCapturePathSandboxLog(input.input, {
    blockedNetworkAttemptCount: blockedNetworkAttempts.length,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    event: "capture-path-validation.demo-script.failed",
    failedSceneId,
    failureLogExcerpt,
    failureReason,
    warningCount: warnings.length,
  });
  await writeCapturePathDiagnostics(input.input, input.dependencies, {
    blockedNetworkAttemptCount: blockedNetworkAttempts.length,
    event: "capture-path-validation.demo-script.failed",
    failedSceneId,
    failureLogExcerpt,
    failureReason,
    logs,
    warningCount: warnings.length,
  });

  return {
    blockedNetworkAttempts,
    browserUrl: input.browserUrl,
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    ...(failedSceneId === undefined ? {} : { failedSceneId }),
    failureReason,
    logs,
    ...(input.projectValidation?.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: input.projectValidation.screenshotArtifactId }),
    status: "failed",
    warnings,
  };
}

async function capturePathSceneFailure(input: {
  browserUrl: string;
  dependencies: CapturePathValidationDependencies;
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
    errorMessage: input.sceneResult.errorMessage,
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
  await writeCapturePathDiagnostics(input.input, input.dependencies, {
    blockedNetworkAttemptCount:
      input.sceneResult.blockedNetworkAttempts?.length ?? 0,
    event: "capture-path-validation.scene.failed",
    failedAction: input.sceneResult.failedAction,
    errorMessage: input.sceneResult.errorMessage,
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
    ...(input.sceneResult.errorMessage === undefined
      ? {}
      : { errorMessage: input.sceneResult.errorMessage }),
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
  dependencies: CapturePathValidationDependencies,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace?.workspace.writeSandboxLog?.({
    diagnosticsLogPath: capturePathDiagnosticsLogPath,
    diagnosticsSource: "capture-path-validation",
    ...removeUndefinedValues(entry),
    repoUrl: input.preparationManifest.repoUrl,
    scriptId: input.demoScriptPackage.scriptId,
    stage: "capture-path-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
  if (write === undefined) {
    return;
  }

  const failedEvent = typeof entry.event === "string" ? entry.event : undefined;
  try {
    await withTimeout(
      write,
      dependencies.diagnosticsWriteTimeoutMs ??
        defaultDiagnosticsWriteTimeoutMs,
      `Capture Path Validation diagnostics log write timed out after ${
        dependencies.diagnosticsWriteTimeoutMs ??
        defaultDiagnosticsWriteTimeoutMs
      }ms.`,
    );
  } catch (error) {
    await writeFallbackDiagnosticsWarning(
      input,
      dependencies,
      error,
      failedEvent,
    );
  }
}

async function writeFallbackDiagnosticsWarning(
  input: CapturePathValidationInput,
  dependencies: CapturePathValidationDependencies,
  error: unknown,
  failedEvent: string | undefined,
) {
  const timeoutMs =
    dependencies.diagnosticsWriteTimeoutMs ?? defaultDiagnosticsWriteTimeoutMs;

  try {
    await withTimeout(
      Promise.resolve(
        (dependencies.diagnosticsLogger ?? defaultDiagnosticsLogger).warn(
          {
            diagnosticsLogPath: capturePathDiagnosticsLogPath,
            diagnosticsSource: "capture-path-validation",
            error: readErrorMessage(error),
            event: "capture-path-validation.diagnostics-log-write-failed",
            ...(failedEvent === undefined ? {} : { failedEvent }),
            repoUrl: input.preparationManifest.repoUrl,
            scriptId: input.demoScriptPackage.scriptId,
            stage: "capture-path-validation",
            workspaceId: input.preparationManifest.workspaceId,
          },
          "Capture Path Validation diagnostics log write failed.",
        ),
      ),
      timeoutMs,
      `Capture Path Validation fallback diagnostics warning timed out after ${timeoutMs}ms.`,
    );
  } catch {
    // Preserve Capture Path Validation progress if the fallback logger fails or hangs.
  }
}

async function writeCapturePathSandboxLog(
  input: CapturePathValidationInput,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...removeUndefinedValues(entry),
    repoUrl: input.preparationManifest.repoUrl,
    scriptId: input.demoScriptPackage.scriptId,
    stage: "capture-path-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
  if (write === undefined) {
    return;
  }

  void write.catch(() => {});
}

function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function createLogExcerpt(logs: string[]) {
  return logs.join("\n").slice(0, 4_000);
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readFailedContractSceneId(failureReason: string) {
  return /^Scene ([^ ]+) /.exec(failureReason)?.[1];
}

class CapturePathValidationTimeoutError extends Error {}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new CapturePathValidationTimeoutError(message)),
        timeoutMs,
      );
    }),
  ]);
}

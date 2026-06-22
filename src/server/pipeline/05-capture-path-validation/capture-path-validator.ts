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
  const logs = [...projectValidation.logs];
  const browserUrl =
    projectValidation.browserUrl ?? input.preparationManifest.url;

  for (const scene of scriptPackage.scenes) {
    await writeCapturePathSandboxLog(input, {
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
      event: "capture-path-validation.scene.started",
      sceneId: scene.id,
      sectionId: "demo-script",
    });
    await writeCapturePathDiagnostics(input, {
      event: "capture-path-validation.scene.started",
      expectedVisibleOutcome: scene.expectedVisibleOutcome,
      sceneDescription: scene.humanReadableDescription,
      sceneId: scene.id,
      sectionId: "demo-script",
    });
    const sceneResult = await dependencies.sceneValidator.validateScene({
      baseUrl: browserUrl,
      demoPlaywrightScript: scriptPackage.demoPlaywrightScript,
      scene,
      sectionId: "demo-script",
    });
    logs.push(...sceneResult.logs);

    if (sceneResult.status === "failed") {
      const failureLogExcerpt = createLogExcerpt(sceneResult.logs);
      await writeCapturePathSandboxLog(input, {
        blockedNetworkAttemptCount:
          sceneResult.blockedNetworkAttempts?.length ?? 0,
        diagnosticsLogPath: capturePathDiagnosticsLogPath,
        event: "capture-path-validation.scene.failed",
        failedAction: sceneResult.failedAction,
        failureLogExcerpt,
        failureReason: sceneResult.failureReason,
        runDirectory: sceneResult.runDirectory,
        sceneId: scene.id,
        scriptPath: sceneResult.scriptPath,
        stderrPath: sceneResult.stderrPath,
        stdoutPath: sceneResult.stdoutPath,
        screenshotArtifactId: sceneResult.screenshotArtifactId,
        sectionId: "demo-script",
      });
      await writeCapturePathDiagnostics(input, {
        blockedNetworkAttemptCount:
          sceneResult.blockedNetworkAttempts?.length ?? 0,
        event: "capture-path-validation.scene.failed",
        failedAction: sceneResult.failedAction,
        failureLogExcerpt,
        failureReason: sceneResult.failureReason,
        logs: sceneResult.logs,
        runDirectory: sceneResult.runDirectory,
        sceneId: scene.id,
        scriptPath: sceneResult.scriptPath,
        screenshotArtifactId: sceneResult.screenshotArtifactId,
        sectionId: "demo-script",
        stderrPath: sceneResult.stderrPath,
        stdoutPath: sceneResult.stdoutPath,
      });
      return {
        blockedNetworkAttempts: sceneResult.blockedNetworkAttempts ?? [],
        browserUrl,
        diagnosticsLogPath: capturePathDiagnosticsLogPath,
        failedSceneId: scene.id,
        failureReason: sceneResult.failureReason,
        logs,
        ...(sceneResult.failedAction === undefined
          ? {}
          : { failedAction: sceneResult.failedAction }),
        ...(sceneResult.screenshotArtifactId === undefined
          ? {}
          : { screenshotArtifactId: sceneResult.screenshotArtifactId }),
        ...(sceneResult.runDirectory === undefined
          ? {}
          : { runDirectory: sceneResult.runDirectory }),
        ...(sceneResult.scriptPath === undefined
          ? {}
          : { scriptPath: sceneResult.scriptPath }),
        ...(sceneResult.stderrPath === undefined
          ? {}
          : { stderrPath: sceneResult.stderrPath }),
        ...(sceneResult.stdoutPath === undefined
          ? {}
          : { stdoutPath: sceneResult.stdoutPath }),
        status: "failed",
        warnings: projectValidation.warnings,
      };
    }

    await writeCapturePathSandboxLog(input, {
      diagnosticsLogPath: capturePathDiagnosticsLogPath,
      event: "capture-path-validation.scene.succeeded",
      runDirectory: sceneResult.runDirectory,
      sceneId: scene.id,
      scriptPath: sceneResult.scriptPath,
      stderrPath: sceneResult.stderrPath,
      stdoutPath: sceneResult.stdoutPath,
      sectionId: "demo-script",
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

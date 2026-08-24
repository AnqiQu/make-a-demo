import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CAPTURE_COMMAND_SHUTDOWN_GRACE_SECONDS,
  CAPTURE_SCRIPT_TIMEOUT_SECONDS,
  readCaptureValidationTimeoutSeconds,
} from "../../pipeline/06-footage-capture/capture-execution-budget";
import {
  CaptureBrowserActionFailureError,
  type CaptureRuntimeProtocol,
  CaptureRuntimeProtocolError,
  CaptureScriptProtocolViolationError,
  readCaptureAppServerError,
  readCaptureRuntimeProtocol,
  readCaptureValidationFailure,
  readSuccessfulCaptureProtocol,
} from "../../pipeline/06-footage-capture/capture-runtime-protocol";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "../../pipeline/06-footage-capture/capture-sdk-contract";
import { prepareStylizedPlaywrightScript } from "../../pipeline/06-footage-capture/stylized-playwright-script";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { shellQuote } from "../../shared/shell/shell-quote";
import { uploadSubmittedCodeArchive } from "../daytona/submitted-code-artifact-archive";
import type { AgentHarnessWorkspaceHandle } from "../daytona/workspace.interface";

export type PreparedWorkspaceCapturePathResult = {
  blockedNetworkAttempts: Array<{
    direction: "outbound";
    hasCredentials?: boolean;
    host: string;
    method?: string;
    phase: "runtime";
    resourceType?: string;
    url?: string;
  }>;
  browserUrl: string;
  /**
   * The typed identity of the browser action that failed the dry run, when
   * the runtime protocol named one (N125). `actionId` is the script step id
   * — the id space shared with the Demo Script's browser actions — so
   * consumers can look up the failed action's locator candidate and scene
   * prefix instead of regexing the prose failureReason.
   */
  failedAction?: { actionId?: string; sceneId: string };
  failureClassification?:
    | "app server error"
    | "assertion failure"
    | "harness/internal failure"
    | "locator failure"
    | "timing/state failure"
    | "start failure"
    | "script contract failure";
  failureReason?: string;
  logs: string[];
  runDirectory: string;
  screenshotArtifactId?: string;
  scriptPath: string;
  status: "failed" | "succeeded";
  stderrPath: string;
  stdoutPath: string;
  warnings: string[];
};

/**
 * Dry-runs a generated Demo Script in the submitted-code sandbox. The runner
 * uses the production Capture SDK protocol but must not record or transfer
 * footage, and it must retain stdout/stderr as validation evidence.
 */
export async function validatePreparedWorkspaceCapturePath(input: {
  baseUrl: string;
  demoPlaywrightScript: string;
  externalResourceManifest?: ExternalResourceManifest;
  expectedStepIdsByScene?: Readonly<Record<string, readonly string[]>>;
  localRunDirectory: string;
  onEvent?: (entry: Record<string, unknown>) => Promise<void>;
  sceneIds: string[];
  workspace: AgentHarnessWorkspaceHandle;
}): Promise<PreparedWorkspaceCapturePathResult> {
  const workspace = input.workspace.workspace;
  await mkdir(input.localRunDirectory, { recursive: true });
  await writeGeneratedCaptureSdkHarness(input.localRunDirectory);
  await validateDemoScriptCaptureSdkTypes({
    demoPlaywrightScript: input.demoPlaywrightScript,
    directory: input.localRunDirectory,
  });

  const remoteRunDirectory = `/workspace/.makeademo/capture-path-validation-runs/${basename(input.localRunDirectory)}`;
  const localScriptPath = join(input.localRunDirectory, "demo-script.ts");
  const localStdoutPath = join(input.localRunDirectory, "stdout.log");
  const localStderrPath = join(input.localRunDirectory, "stderr.log");
  const remoteScriptPath = `${remoteRunDirectory}/demo-script.ts`;
  await writeFile(
    localScriptPath,
    prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
      baseUrl: input.baseUrl,
      ...(input.externalResourceManifest === undefined
        ? {}
        : { externalResourceManifest: input.externalResourceManifest }),
      headed: false,
      mode: "validation",
    }),
  );

  await runObservedOperation(input, "artifact-upload", () =>
    uploadSubmittedCodeArchive({
      archiveName: "capture-inputs.tgz",
      entries: [
        "makeademo-capture-sdk.js",
        "makeademo-capture-sdk.d.ts",
        "makeademo-capture-sdk.instructions.md",
        "demo-script.contract.ts",
        "demo-script.ts",
      ],
      localDirectory: input.localRunDirectory,
      remoteDirectory: remoteRunDirectory,
      workspace,
    }),
  );

  const scriptTimeoutSeconds =
    input.expectedStepIdsByScene === undefined
      ? CAPTURE_SCRIPT_TIMEOUT_SECONDS
      : readCaptureValidationTimeoutSeconds(
          Object.values(input.expectedStepIdsByScene).reduce(
            (total, stepIds) => total + stepIds.length,
            0,
          ),
        );
  const result = await runObservedCommand(input, "script-execution", () =>
    workspace.executeSubmittedCode(
      `cd ${shellQuote(remoteRunDirectory)} && NODE_PATH="\${MAKEADEMO_TOOLS_NODE_MODULES:-$(npm root -g)}" timeout -k ${CAPTURE_COMMAND_SHUTDOWN_GRACE_SECONDS}s ${scriptTimeoutSeconds}s bun ${shellQuote(remoteScriptPath)}`,
      {
        timeoutMs:
          (scriptTimeoutSeconds + CAPTURE_COMMAND_SHUTDOWN_GRACE_SECONDS) *
          1_000,
      },
    ),
  );
  await Promise.all([
    writeFile(localStdoutPath, result.stdout),
    writeFile(localStderrPath, result.stderr),
  ]);

  let protocol: CaptureRuntimeProtocol;
  try {
    protocol = readCaptureRuntimeProtocol(result);
  } catch (error) {
    return createProtocolFailureResult({
      error,
      input,
      localStderrPath,
      localStdoutPath,
      remoteScriptPath,
      result,
    });
  }
  const blockedNetworkAttempts = protocol.blockedNetworkAttempts;
  const validationFailure = readCaptureValidationFailure(protocol);
  const screenshotArtifactId = await downloadFailureScreenshotBestEffort({
    failure: validationFailure,
    input,
    remoteScreenshotPath: `${remoteRunDirectory}/makeademo-validation-failure.png`,
  });
  const logs = [result.stdout, result.stderr].filter(
    (output) => output.trim().length > 0,
  );
  const common = {
    blockedNetworkAttempts,
    browserUrl: input.baseUrl,
    logs,
    runDirectory: input.localRunDirectory,
    scriptPath: remoteScriptPath,
    ...(screenshotArtifactId === undefined ? {} : { screenshotArtifactId }),
    stderrPath: localStderrPath,
    stdoutPath: localStdoutPath,
    warnings:
      blockedNetworkAttempts.length === 0
        ? []
        : [
            `Runtime Network Lockdown suppressed ${blockedNetworkAttempts.length} uncached external request(s).`,
          ],
  };
  // An app-origin 5xx outranks every other verdict: page.goto resolves on a
  // server error, so an otherwise "successful" protocol can still have filmed a
  // broken route. Deciding it here — before the protocol and exit-code checks —
  // makes the classification sticky through the external-resource broker and
  // non-transient in the orchestrator.
  const appServerError = readCaptureAppServerError(protocol, input.baseUrl);
  if (appServerError !== undefined) {
    return {
      ...common,
      failureClassification: "app server error",
      failureReason: `The app returned HTTP ${appServerError.status} for the main document at ${appServerError.url}. A server error on the app's own route is a hard capture failure that external-resource hydration or a retry cannot fix.`,
      status: "failed",
    };
  }
  const protocolFailure = () => {
    try {
      readSuccessfulCaptureProtocol({
        ...(input.expectedStepIdsByScene === undefined
          ? {}
          : { expectedStepIdsByScene: input.expectedStepIdsByScene }),
        protocol,
        sceneIds: input.sceneIds,
      });
      return undefined;
    } catch (error) {
      const failedAction = readFailedAction(error);
      return {
        ...common,
        ...(failedAction === undefined ? {} : { failedAction }),
        failureClassification: classifyCaptureFailure(error),
        failureReason: formatProtocolFailure(error),
        status: "failed" as const,
      };
    }
  };
  if (
    result.exitCode !== 0 &&
    protocol.runtimeEvents.some((event) => event.event === "failed")
  ) {
    const failure = protocolFailure();
    if (failure !== undefined) {
      return failure;
    }
  }
  if (result.exitCode !== 0) {
    return {
      ...common,
      failureReason:
        validationFailure?.message ??
        (result.exitCode === 124 || result.exitCode === 137
          ? `Capture Path Validation script timed out after ${scriptTimeoutSeconds}s.`
          : formatProcessExitFailure(result)),
      status: "failed",
    };
  }

  return protocolFailure() ?? { ...common, status: "succeeded" };
}

function formatProcessExitFailure(result: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): string {
  const summary = `Capture Path Validation script failed with exit code ${result.exitCode}.`;
  const diagnostic = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n")
    .slice(-2_000);
  return diagnostic.length === 0 ? summary : `${summary} ${diagnostic}`;
}

function createProtocolFailureResult(input: {
  error: unknown;
  input: {
    baseUrl: string;
    localRunDirectory: string;
  };
  localStderrPath: string;
  localStdoutPath: string;
  remoteScriptPath: string;
  result: { stderr: string; stdout: string };
}): PreparedWorkspaceCapturePathResult {
  return {
    blockedNetworkAttempts: [],
    browserUrl: input.input.baseUrl,
    failureClassification: "harness/internal failure",
    failureReason: formatProtocolFailure(input.error),
    logs: [input.result.stdout, input.result.stderr].filter(
      (output) => output.trim().length > 0,
    ),
    runDirectory: input.input.localRunDirectory,
    scriptPath: input.remoteScriptPath,
    status: "failed",
    stderrPath: input.localStderrPath,
    stdoutPath: input.localStdoutPath,
    warnings: [],
  };
}

function formatProtocolFailure(error: unknown) {
  if (error instanceof CaptureScriptProtocolViolationError) {
    return `Capture Script Protocol Violation: ${error.message}`;
  }
  if (error instanceof CaptureRuntimeProtocolError) {
    return `Capture Runtime Protocol Error: ${error.message}`;
  }
  return formatErrorDiagnostic(error);
}

function readFailedAction(
  error: unknown,
): PreparedWorkspaceCapturePathResult["failedAction"] {
  if (!(error instanceof CaptureBrowserActionFailureError)) {
    return undefined;
  }
  return {
    ...(error.actionId === undefined ? {} : { actionId: error.actionId }),
    sceneId: error.sceneId,
  };
}

function classifyCaptureFailure(
  error: unknown,
): NonNullable<PreparedWorkspaceCapturePathResult["failureClassification"]> {
  if (error instanceof CaptureBrowserActionFailureError) {
    const evidence = `${error.label ?? ""} ${error.message}`;
    if (/expect|assert/i.test(evidence)) {
      return "assertion failure";
    }
    if (/page\.goto|\bgoto\b|navigat/i.test(evidence)) {
      if (error.sceneId === "setup" && error.actionId === undefined) {
        return "start failure";
      }
      return "timing/state failure";
    }
    if (/locator|getBy|strict mode/i.test(evidence)) {
      return "locator failure";
    }
    return "timing/state failure";
  }
  return error instanceof CaptureScriptProtocolViolationError
    ? "script contract failure"
    : "harness/internal failure";
}

async function runObservedCommand(
  input: {
    onEvent?: (entry: Record<string, unknown>) => Promise<void>;
    workspace: AgentHarnessWorkspaceHandle;
  },
  operation: string,
  run: () => Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>,
) {
  const startedAt = Date.now();
  await emitValidationEventBestEffort(input, {
    event: `capture-path-validation.${operation}.started`,
    level: "info",
    operation,
  });
  try {
    const result = await run();
    await emitValidationEventBestEffort(input, {
      durationMs: Date.now() - startedAt,
      event: `capture-path-validation.${operation}.${result.exitCode === 0 ? "succeeded" : "failed"}`,
      exitCode: result.exitCode,
      level: result.exitCode === 0 ? "info" : "error",
      operation,
    });
    return result;
  } catch (error) {
    await emitValidationEventBestEffort(input, {
      durationMs: Date.now() - startedAt,
      error: formatErrorDiagnostic(error),
      event: `capture-path-validation.${operation}.failed`,
      level: "error",
      operation,
    });
    throw error;
  }
}

async function runObservedOperation<T>(
  input: {
    onEvent?: (entry: Record<string, unknown>) => Promise<void>;
    workspace: AgentHarnessWorkspaceHandle;
  },
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  await emitValidationEventBestEffort(input, {
    event: `capture-path-validation.${operation}.started`,
    level: "info",
    operation,
  });
  try {
    const result = await run();
    await emitValidationEventBestEffort(input, {
      durationMs: Date.now() - startedAt,
      event: `capture-path-validation.${operation}.succeeded`,
      level: "info",
      operation,
    });
    return result;
  } catch (error) {
    await emitValidationEventBestEffort(input, {
      durationMs: Date.now() - startedAt,
      error: formatErrorDiagnostic(error),
      event: `capture-path-validation.${operation}.failed`,
      level: "error",
      operation,
    });
    throw error;
  }
}

async function emitValidationEventBestEffort(
  input: {
    onEvent?: (entry: Record<string, unknown>) => Promise<void>;
    workspace: AgentHarnessWorkspaceHandle;
  },
  entry: Record<string, unknown>,
): Promise<void> {
  const event =
    typeof entry.event === "string" ? entry.event : "capture-path-validation";
  const logEntry = {
    ...entry,
    message: event,
    stage: "capture-path-validation",
  };
  await Promise.allSettled([
    input.workspace.workspace.writeSandboxLog(logEntry),
    input.onEvent?.(logEntry),
  ]);
}

/**
 * Fetches the failure screenshot from the path the backend gave the generated
 * script. The reported `screenshotPath` only signals that a screenshot exists:
 * trusting its value would let submitted code name any sandbox file here.
 */
async function downloadFailureScreenshotBestEffort(input: {
  failure: { message?: string; screenshotPath?: string } | undefined;
  input: {
    localRunDirectory: string;
    onEvent?: (entry: Record<string, unknown>) => Promise<void>;
    workspace: AgentHarnessWorkspaceHandle;
  };
  remoteScreenshotPath: string;
}): Promise<string | undefined> {
  if (input.failure?.screenshotPath === undefined) {
    return undefined;
  }
  const remotePath = input.remoteScreenshotPath;
  const localPath = join(
    input.input.localRunDirectory,
    "makeademo-validation-failure.png",
  );
  try {
    await runObservedOperation(input.input, "failure-screenshot-download", () =>
      input.input.workspace.workspace.downloadSubmittedCodeFiles([
        { destinationPath: localPath, sourcePath: remotePath },
      ]),
    );
    return localPath;
  } catch {
    return undefined;
  }
}

function formatErrorDiagnostic(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

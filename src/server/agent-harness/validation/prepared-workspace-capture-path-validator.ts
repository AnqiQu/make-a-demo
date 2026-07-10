import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "../../pipeline/06-footage-capture/capture-sdk-contract";
import { prepareStylizedPlaywrightScript } from "../../pipeline/06-footage-capture/stylized-playwright-script";
import { executeSubmittedCode } from "../daytona/submitted-code-execution";
import type { AgentHarnessWorkspaceHandle } from "../daytona/workspace.interface";

const capturePathCommandTimeoutMs = 130_000;
const capturePathScriptTimeoutSeconds = 120;

export type PreparedWorkspaceCapturePathResult = {
  blockedNetworkAttempts: Array<{
    direction: "outbound";
    host: string;
    phase: "runtime";
  }>;
  browserUrl: string;
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
  localRunDirectory: string;
  onEvent?: (entry: Record<string, unknown>) => Promise<void>;
  workspace: AgentHarnessWorkspaceHandle;
}): Promise<PreparedWorkspaceCapturePathResult> {
  const workspace = input.workspace.workspace;
  const uploadSubmittedCodeFiles =
    workspace.uploadSubmittedCodeFiles?.bind(workspace);
  if (uploadSubmittedCodeFiles === undefined) {
    throw new Error(
      "Capture Path Validation requires submitted-code artifact upload support.",
    );
  }

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
      headed: false,
      mode: "validation",
      pauseAfterSceneMs: 0,
    }),
  );

  await executeSubmittedCode(
    workspace,
    `mkdir -p ${shellQuote(remoteRunDirectory)}`,
    { timeoutMs: 30_000 },
  );
  await runObservedOperation(input, "artifact-upload", () =>
    uploadSubmittedCodeFiles([
      {
        destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.js`,
        sourcePath: join(input.localRunDirectory, "makeademo-capture-sdk.js"),
      },
      {
        destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.d.ts`,
        sourcePath: join(input.localRunDirectory, "makeademo-capture-sdk.d.ts"),
      },
      {
        destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.instructions.md`,
        sourcePath: join(
          input.localRunDirectory,
          "makeademo-capture-sdk.instructions.md",
        ),
      },
      {
        destinationPath: `${remoteRunDirectory}/demo-script.contract.ts`,
        sourcePath: join(input.localRunDirectory, "demo-script.contract.ts"),
      },
      { destinationPath: remoteScriptPath, sourcePath: localScriptPath },
    ]),
  );

  const result = await runObservedOperation(input, "script-execution", () =>
    executeSubmittedCode(
      workspace,
      `cd ${shellQuote(remoteRunDirectory)} && NODE_PATH="$(npm root -g)" timeout -k 5s ${capturePathScriptTimeoutSeconds}s bun ${shellQuote(remoteScriptPath)}`,
      { timeoutMs: capturePathCommandTimeoutMs },
    ),
  );
  await Promise.all([
    writeFile(localStdoutPath, result.stdout),
    writeFile(localStderrPath, result.stderr),
  ]);

  const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
  const validationFailure = readValidationFailure(result.stderr);
  const screenshotArtifactId = await downloadFailureScreenshotBestEffort({
    failure: validationFailure,
    input,
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
    warnings: [],
  };

  if (blockedNetworkAttempts.length > 0) {
    return {
      ...common,
      failureReason:
        "Capture Path Validation blocked runtime network access from the generated Demo Script.",
      status: "failed",
    };
  }
  if (result.exitCode !== 0) {
    return {
      ...common,
      failureReason:
        validationFailure?.message ??
        (result.exitCode === 124 || result.exitCode === 137
          ? `Capture Path Validation script timed out after ${capturePathScriptTimeoutSeconds}s.`
          : `Capture Path Validation script failed with exit code ${result.exitCode}.`),
      status: "failed",
    };
  }

  return { ...common, status: "succeeded" };
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
    input.workspace.workspace.writeSandboxLog?.(logEntry),
    input.onEvent?.(logEntry),
  ]);
}

function readValidationFailure(
  stderr: string,
): { message: string; screenshotPath?: string } | undefined {
  const prefix = "[makeademo:validation] script failed ";
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) {
      continue;
    }
    try {
      const value = JSON.parse(trimmed.slice(prefix.length)) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "message") === "string"
      ) {
        const screenshotPath = Reflect.get(value, "screenshotPath");
        return {
          message: Reflect.get(value, "message") as string,
          ...(typeof screenshotPath === "string" ? { screenshotPath } : {}),
        };
      }
    } catch {
      return { message: trimmed.slice(prefix.length) };
    }
  }
  return undefined;
}

async function downloadFailureScreenshotBestEffort(input: {
  failure: { message: string; screenshotPath?: string } | undefined;
  input: {
    localRunDirectory: string;
    onEvent?: (entry: Record<string, unknown>) => Promise<void>;
    workspace: AgentHarnessWorkspaceHandle;
  };
}): Promise<string | undefined> {
  const remotePath = input.failure?.screenshotPath;
  const downloadSubmittedCodeFiles =
    input.input.workspace.workspace.downloadSubmittedCodeFiles?.bind(
      input.input.workspace.workspace,
    );
  if (remotePath === undefined || downloadSubmittedCodeFiles === undefined) {
    return undefined;
  }
  const localPath = join(
    input.input.localRunDirectory,
    "makeademo-validation-failure.png",
  );
  try {
    await runObservedOperation(input.input, "failure-screenshot-download", () =>
      downloadSubmittedCodeFiles([
        { destinationPath: localPath, sourcePath: remotePath },
      ]),
    );
    return localPath;
  } catch {
    return undefined;
  }
}

function readBlockedNetworkAttempts(stderr: string) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:network-blocked] "))
    .map((line) =>
      JSON.parse(line.slice("[makeademo:network-blocked] ".length)),
    )
    .filter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        value.direction === "outbound" &&
        value.phase === "runtime" &&
        typeof value.host === "string",
    )
    .map((value) => ({
      direction: "outbound" as const,
      host: value.host as string,
      phase: "runtime" as const,
    }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatErrorDiagnostic(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

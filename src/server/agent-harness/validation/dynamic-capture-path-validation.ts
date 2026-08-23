import {
  type NetworkAttempt,
  type ValidationReport,
  readValidationReport,
} from "../schemas/artifacts";

type CapturePathValidationResult = {
  blockedNetworkAttempts: Array<{
    direction: "inbound" | "outbound";
    hasCredentials?: boolean;
    host: string;
    method?: string;
    phase: "install" | "runtime";
    resourceType?: string;
    url?: string;
  }>;
  browserUrl?: string;
  failedAction?: { actionId?: string; sceneId: string };
  failureClassification?: string;
  failureReason?: string;
  logs: string[];
  runDirectory?: string;
  screenshotArtifactId?: string;
  scriptPath?: string;
  status: "failed" | "succeeded";
  stderrPath?: string;
  stdoutPath?: string;
  warnings: string[];
};

export type DynamicCapturePathValidationInput = {
  preparationManifest: {
    baseUrl: string;
  };
  scriptCandidate: {
    outputPath: string;
  };
};

export type DynamicCapturePathValidationDependencies = {
  runCapturePath(
    input: DynamicCapturePathValidationInput,
  ): Promise<CapturePathValidationResult>;
};

export async function validateDynamicCapturePath(
  input: DynamicCapturePathValidationInput,
  dependencies: DynamicCapturePathValidationDependencies,
): Promise<ValidationReport> {
  const result = await dependencies.runCapturePath(input);
  const status = result.status === "succeeded" ? "passed" : "failed";
  const logsSummary =
    result.failureReason ??
    (status === "passed"
      ? "Capture path dry-run passed."
      : "Capture path dry-run failed.");
  const failureClassification =
    status === "passed"
      ? "none"
      : (result.failureClassification ?? classifyFailure(logsSummary));

  return readValidationReport({
    artifactReferences: [
      input.scriptCandidate.outputPath,
      ...(result.runDirectory === undefined ? [] : [result.runDirectory]),
      ...(result.scriptPath === undefined ? [] : [result.scriptPath]),
      ...(result.screenshotArtifactId === undefined
        ? []
        : [result.screenshotArtifactId]),
    ],
    blockedNetworkAttempts: normalizeNetworkAttempts(
      result.blockedNetworkAttempts,
    ),
    browserObservations: result.logs.slice(0, 5),
    consoleErrors: [],
    ...(result.failedAction === undefined
      ? {}
      : { failedAction: result.failedAction }),
    failureClassification,
    logsSummary,
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots:
      result.screenshotArtifactId === undefined
        ? []
        : [result.screenshotArtifactId],
    stage: "capture-path-validation",
    status,
    stderrExcerpts: result.stderrPath === undefined ? [] : [result.stderrPath],
    stdoutExcerpts: result.stdoutPath === undefined ? [] : [result.stdoutPath],
    suggestedRepairHints:
      status === "passed"
        ? []
        : failureClassification === "locator failure"
          ? [
              // The hint names the exact failed action when the runtime
              // protocol identified one (N125); the generic re-exploration
              // wording remains only for protocol-less locator failures.
              result.failedAction?.actionId === undefined
                ? "Re-run App Exploration to replace stale locator evidence with a browser-verified candidate."
                : `Browser action ${result.failedAction.actionId} failed on its browser-verified locator in Scene ${result.failedAction.sceneId}; locator regrounding re-verifies that candidate in its replay context.`,
            ]
          : ["Route this failure through RepairRouter."],
    urlChecked: result.browserUrl ?? input.preparationManifest.baseUrl,
  });
}

function normalizeNetworkAttempts(
  attempts: CapturePathValidationResult["blockedNetworkAttempts"],
): NetworkAttempt[] {
  return attempts.map((attempt) => ({
    direction: attempt.direction,
    ...(attempt.hasCredentials === undefined
      ? {}
      : { hasCredentials: attempt.hasCredentials }),
    host: attempt.host,
    ...(attempt.method === undefined ? {} : { method: attempt.method }),
    phase: attempt.phase === "install" ? "dependency-install" : attempt.phase,
    ...(attempt.resourceType === undefined
      ? {}
      : { resourceType: attempt.resourceType }),
    ...(attempt.url === undefined ? {} : { url: attempt.url }),
  }));
}

function classifyFailure(reason: string): string {
  if (/Capture Path Validation script timed out after \d+s/i.test(reason)) {
    return "timing/state failure";
  }
  if (
    /AgentHarnessArtifactTransferError|DaytonaTimeoutError|Operation timed out|artifact (?:upload|download) failed/i.test(
      reason,
    )
  ) {
    return "transient infrastructure failure";
  }
  if (
    /CaptureRuntimeProtocolError|Capture Runtime Protocol Error|can be only used with Locator object|Capture SDK (?:assertion )?instrumentation/i.test(
      reason,
    )
  ) {
    return "harness/internal failure";
  }
  if (/locator/i.test(reason)) {
    return "locator failure";
  }
  if (/assert/i.test(reason)) {
    return "assertion failure";
  }
  if (/contract|Capture SDK/i.test(reason)) {
    return "script contract failure";
  }
  if (/network/i.test(reason)) {
    return "external network required";
  }
  if (/auth/i.test(reason)) {
    return "auth wall";
  }
  return "harness/internal failure";
}

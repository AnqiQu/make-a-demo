import {
  type NetworkAttempt,
  type ValidationReport,
  readValidationReport,
} from "../schemas/artifacts";

type CapturePathValidationResult = {
  blockedNetworkAttempts: Array<{
    direction: "inbound" | "outbound";
    host: string;
    phase: "install" | "runtime";
  }>;
  browserUrl?: string;
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
    failureClassification:
      status === "passed" ? "none" : classifyFailure(logsSummary),
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
      status === "passed" ? [] : ["Route this failure through RepairRouter."],
    urlChecked: result.browserUrl ?? input.preparationManifest.baseUrl,
  });
}

function normalizeNetworkAttempts(
  attempts: CapturePathValidationResult["blockedNetworkAttempts"],
): NetworkAttempt[] {
  return attempts.map((attempt) => ({
    direction: attempt.direction,
    host: attempt.host,
    phase: attempt.phase === "install" ? "dependency-install" : attempt.phase,
  }));
}

function classifyFailure(reason: string): string {
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

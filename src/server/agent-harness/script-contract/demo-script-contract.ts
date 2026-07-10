import { assertDemoScriptCaptureSdkContract } from "../../pipeline/06-footage-capture/capture-sdk-contract";
import { parseDemoScript } from "../../pipeline/06-footage-capture/demo-script.schema";
import {
  DEMO_SCRIPT_OUTPUT_PATH,
  type DemoScriptContract,
  type FlowSpec,
  type PreparationManifest,
  type ScriptCandidate,
  type ValidationReport,
  readFlowSpec,
  readPreparationManifest,
  readScriptCandidate,
  readValidationReport,
} from "../schemas/artifacts";
import { assertCaptureReadyScriptQuality } from "./script-quality";

const contractVersion = "2026-07-08";
const externalUrlPattern =
  /https?:\/\/(?!(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d{1,5})?(?:[/'"`\s)]|$))[^\s'"`)]+/i;
const placeholderPattern =
  /\b(?:TODO|FIXME|replace-me|example\.com|lorem ipsum|placeholder)\b/i;

export function createDemoScriptContract(): DemoScriptContract {
  return {
    allowedCaptureSdkActions: [
      "setup",
      "scene",
      "page.goto",
      "page.getByRole",
      "page.getByLabel",
      "page.getByText",
      "page.getByPlaceholder",
      "page.getByTestId",
      "locator.click",
      "locator.fill",
      "locator.press",
      "locator.selectOption",
      "expect(locator).toBeVisible",
      "expect(locator).toContainText",
      "expect(page).toHaveURL",
    ],
    baseUrlBinding:
      "Capture SDK context baseUrl from PreparationManifest.baseUrl",
    browserContextOwnership:
      "MakeADemo owns browser launch and browser context",
    contractVersion,
    forbiddenApis: [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "navigator.sendBeacon",
      "page.request",
      "page.route",
      "page.waitForRequest",
      "page.waitForResponse",
      "chromium.launch",
      "browser.newContext",
      "recordVideo",
    ],
    forbiddenExternalUrls: true,
    forbiddenFields: ["durationSeconds"],
    networkRestrictions: [
      "runtime network is blocked",
      "browser external requests are blocked during validation and capture",
    ],
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    requiredAssertions: [
      "visible Playwright assertion or observable outcome per scene",
    ],
    requiredJsonShape: [
      "scriptId",
      "title",
      "version",
      "format",
      "demoPlaywrightScript",
      "scenes",
      "presentation",
    ],
    requiredMetadata: [],
    timingConventions: [
      "bounded waits only",
      "no agent-authored scene durations",
    ],
  };
}

export function validateDemoScriptCandidateContract(input: {
  flowSpec: unknown;
  preparationManifest: unknown;
  scriptCandidate: unknown;
}): ValidationReport {
  try {
    const preparationManifest = readPreparationManifest(
      input.preparationManifest,
    );
    const flowSpec = readFlowSpec(input.flowSpec);
    const scriptCandidate = readScriptCandidate(input.scriptCandidate);
    assertCandidateReferencesCurrentArtifacts({
      flowSpec,
      preparationManifest,
      scriptCandidate,
    });
    const demoScript = parseDemoScript(scriptCandidate.scriptJsonContent);
    assertDemoScriptCaptureSdkContract(demoScript);
    assertCaptureReadyScriptQuality(demoScript);
    assertUsesManifestBaseUrl(demoScript.demoPlaywrightScript);
    assertNoExternalUrls(demoScript.demoPlaywrightScript);
    assertNoPlaceholders(scriptCandidate.scriptJsonContent);

    return readValidationReport({
      artifactReferences: [DEMO_SCRIPT_OUTPUT_PATH],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: "none",
      logsSummary: "Demo Script satisfies the static contract.",
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "static-script-contract-validation",
      status: "passed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [],
      urlChecked: preparationManifest.baseUrl,
    });
  } catch (error) {
    return readValidationReport({
      artifactReferences: [DEMO_SCRIPT_OUTPUT_PATH],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: "script contract failure",
      logsSummary: error instanceof Error ? error.message : String(error),
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "static-script-contract-validation",
      status: "failed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [
        "Regenerate /workspace/.makeademo/demo-script.json against the DemoScriptContract.",
      ],
    });
  }
}

function assertCandidateReferencesCurrentArtifacts(input: {
  flowSpec: FlowSpec;
  preparationManifest: PreparationManifest;
  scriptCandidate: ScriptCandidate;
}): void {
  if (input.scriptCandidate.sourceFlowSpecId !== input.flowSpec.id) {
    throw new Error("ScriptCandidate must reference the current FlowSpec id");
  }
  if (
    input.scriptCandidate.sourcePreparationManifestId !==
    input.preparationManifest.id
  ) {
    throw new Error(
      "ScriptCandidate must reference the current PreparationManifest id",
    );
  }
}

function assertUsesManifestBaseUrl(script: string): void {
  if (!/\bbaseUrl\b/.test(script)) {
    throw new Error("demoPlaywrightScript must use the Capture SDK baseUrl");
  }
}

function assertNoExternalUrls(script: string): void {
  const match = externalUrlPattern.exec(script);
  if (match !== null) {
    throw new Error("demoPlaywrightScript must not reference external URLs");
  }
}

function assertNoPlaceholders(scriptJsonContent: unknown): void {
  const serialized = JSON.stringify(scriptJsonContent);
  if (placeholderPattern.test(serialized)) {
    throw new Error("Demo Script must not contain placeholder content");
  }
}

import { assertDemoScriptCaptureSdkContract } from "../06-footage-capture/capture-sdk-contract";
import { validateDemoScriptCaptureSdkTypesInTemporaryHarness } from "../06-footage-capture/capture-sdk-harness";
import {
  type DemoScript,
  parseDemoScript,
} from "../06-footage-capture/demo-script.schema";
import { assertCaptureReadyScriptQuality } from "./script-package-quality";

/**
 * Validates a generated Demo Script candidate at every acceptance seam.
 * Implementations must not return a candidate until schema parsing, the
 * Capture SDK Contract, strict Capture SDK TypeScript validation, and capture
 * readiness quality all succeed.
 */
export async function validateDemoScriptCandidate(
  value: unknown,
): Promise<DemoScript> {
  const demoScript = parseDemoScript(value);
  assertDemoScriptCaptureSdkContract(demoScript);
  await validateDemoScriptCaptureSdkTypesInTemporaryHarness(
    demoScript.demoPlaywrightScript,
  );
  assertCaptureReadyScriptQuality(demoScript);
  return demoScript;
}

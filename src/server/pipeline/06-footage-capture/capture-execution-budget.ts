import { demoScriptLimits } from "./demo-script.schema";

const CAPTURE_SCRIPT_GRACE_SECONDS = 30;
export const CAPTURE_SCRIPT_TIMEOUT_SECONDS =
  demoScriptLimits.maxTotalDurationSeconds + CAPTURE_SCRIPT_GRACE_SECONDS;
export const CAPTURE_SCRIPT_TIMEOUT_MS = CAPTURE_SCRIPT_TIMEOUT_SECONDS * 1_000;
export const CAPTURE_COMMAND_SHUTDOWN_GRACE_SECONDS = 10;
export const CAPTURE_COMMAND_TIMEOUT_MS =
  (CAPTURE_SCRIPT_TIMEOUT_SECONDS + CAPTURE_COMMAND_SHUTDOWN_GRACE_SECONDS) *
  1_000;

const VALIDATION_BASE_SECONDS = 60;
const VALIDATION_SECONDS_PER_ACTION = 15;

/**
 * The validation budget is a cost model over the compiled plan, not a flat
 * ceiling: browser launch and teardown get the base, and every declared
 * action gets time for its 10s Playwright timeout plus humanized pacing.
 * The recording budget stays the upper bound.
 */
export function readCaptureValidationTimeoutSeconds(
  actionCount: number,
): number {
  return Math.min(
    CAPTURE_SCRIPT_TIMEOUT_SECONDS,
    VALIDATION_BASE_SECONDS + actionCount * VALIDATION_SECONDS_PER_ACTION,
  );
}

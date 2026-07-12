import { validateCapturePath } from "../../../pipeline/05-capture-path-validation/capture-path-validator";
import type {
  CapturePathValidationInput,
  CapturePathValidationResult,
} from "../../../pipeline/05-capture-path-validation/capture-path-validator.interface";
import { DefaultCapturePathSceneValidator } from "../../../pipeline/05-capture-path-validation/playwright-capture-path-scene-validator";
import { validateProject } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";

/**
 * Composes the real prepared-runtime Capture Path Validation boundary.
 * Implementations must run the project preflight and generated capture path
 * through the same sandbox/browser seams used by the pipeline gate.
 */
export function createPreparedRuntimeCapturePathValidator(): (
  input: CapturePathValidationInput,
) => Promise<CapturePathValidationResult> {
  const sceneValidator = new DefaultCapturePathSceneValidator();
  const browserValidator = new PlaywrightBrowserValidator();
  const sandboxRunner = new DaytonaSandboxRunner({
    destroyWorkspaceOnCleanup: false,
  });
  return (input) =>
    validateCapturePath(input, {
      sceneValidator,
      validateProject: (projectInput) =>
        validateProject(projectInput, {
          browserValidator,
          sandboxRunner,
        }),
    });
}

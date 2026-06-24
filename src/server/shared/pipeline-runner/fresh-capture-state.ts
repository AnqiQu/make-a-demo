import { restartPreparedDemoForFreshCapture } from "../integrations/sandbox/daytona-sandbox-runner";
import type { FullPipelineRunnerOptions } from "./full-pipeline-runner";

type FreshCaptureStatePreparer = NonNullable<
  FullPipelineRunnerOptions["prepareFreshCaptureState"]
>;

type RestartPreparedDemoForFreshCapture =
  typeof restartPreparedDemoForFreshCapture;

export function createDaytonaFreshCaptureStatePreparer(
  restart: RestartPreparedDemoForFreshCapture = restartPreparedDemoForFreshCapture,
): FreshCaptureStatePreparer {
  return async ({ stage1 }) => {
    if (stage1.preparationWorkspace === undefined) {
      throw new Error(
        "Fresh Footage Capture state requires the prepared workspace.",
      );
    }

    return await restart({
      preparationManifest: stage1.preparationManifest,
      preparationWorkspace: stage1.preparationWorkspace,
    });
  };
}

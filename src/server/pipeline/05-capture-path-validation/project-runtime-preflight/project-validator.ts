import type { PreparationManifest } from "../../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../03-repo-preparation/preparation-workspace-runner";
import type { BrowserValidator } from "./browser-validator.interface";
import { inferInstallPlan } from "./install-plan";
import { findRuntimeBoundaryViolations } from "./network-isolation-policy";
import type { SandboxRunner } from "./sandbox-runner.interface";
import type { ProjectValidationResult } from "./validation-result";

export type ProjectValidationInput = {
  preparationManifest: PreparationManifest;
  preparationWorkspace?: PreparationWorkspaceHandle;
};

export type ProjectValidationDependencies = {
  browserValidator: BrowserValidator;
  sandboxRunner: SandboxRunner;
};

export async function validateProject(
  input: ProjectValidationInput,
  dependencies: ProjectValidationDependencies,
): Promise<ProjectValidationResult> {
  const sandboxResult = await dependencies.sandboxRunner.runValidation({
    demoCommand: input.preparationManifest.demoCommand,
    preparationManifest: input.preparationManifest,
    ...(input.preparationWorkspace === undefined
      ? {}
      : { preparationWorkspace: input.preparationWorkspace }),
    repoUrl: input.preparationManifest.repoUrl,
    url: input.preparationManifest.url,
  });
  const installPlan = inferInstallPlan(sandboxResult.repoFiles);
  const blockedNetworkAttempts = findRuntimeBoundaryViolations(
    sandboxResult.blockedNetworkAttempts,
  );

  try {
    if (blockedNetworkAttempts.length > 0) {
      return {
        blockedNetworkAttempts,
        failureReason:
          "Runtime network communication across the sandbox boundary is not allowed.",
        logs: sandboxResult.logs,
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    if (sandboxResult.runtimeExitCode !== 0) {
      return {
        blockedNetworkAttempts: [],
        failureReason: "Demo command failed inside the sandbox.",
        logs: sandboxResult.logs,
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    const browserUrl =
      sandboxResult.browserUrl ?? input.preparationManifest.url;
    const browserResult = await dependencies.browserValidator.validate({
      ...(input.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: input.preparationWorkspace }),
      url: browserUrl,
    });
    const browserNetworkAttempts = findRuntimeBoundaryViolations(
      browserResult.blockedNetworkAttempts ?? [],
    );

    if (browserNetworkAttempts.length > 0) {
      return {
        blockedNetworkAttempts: browserNetworkAttempts,
        browserUrl,
        failureReason:
          "Runtime network communication across the sandbox boundary is not allowed.",
        logs: [...sandboxResult.logs, ...browserResult.logs],
        screenshotArtifactId: browserResult.screenshotArtifactId,
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    if (!browserResult.interactable) {
      return {
        blockedNetworkAttempts: [],
        browserUrl,
        failureReason: "Configured URL loaded but was not interactable.",
        logs: [...sandboxResult.logs, ...browserResult.logs],
        screenshotArtifactId: browserResult.screenshotArtifactId,
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    return {
      blockedNetworkAttempts: [],
      browserUrl,
      logs: [...sandboxResult.logs, ...browserResult.logs],
      screenshotArtifactId: browserResult.screenshotArtifactId,
      status: "succeeded",
      warnings: installPlan.warnings,
    };
  } finally {
    await cleanupQuietly(sandboxResult.cleanup);
  }
}

async function cleanupQuietly(cleanup: (() => Promise<void>) | undefined) {
  try {
    await cleanup?.();
  } catch {
    // Preserve the validation result or error that triggered cleanup.
  }
}

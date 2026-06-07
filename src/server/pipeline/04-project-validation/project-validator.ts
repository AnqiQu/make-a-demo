import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { BrowserValidator } from "./browser-validator.interface";
import { inferInstallPlan } from "./install-plan";
import { findRuntimeBoundaryViolations } from "./network-isolation-policy";
import type { SandboxRunner } from "./sandbox-runner.interface";
import type { ProjectValidationResult } from "./validation-result";

export type ProjectValidationInput = {
  preparationManifest: PreparationManifest;
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
    repoUrl: input.preparationManifest.repoUrl,
    url: input.preparationManifest.url,
  });
  const installPlan = inferInstallPlan(sandboxResult.repoFiles);
  const blockedNetworkAttempts = findRuntimeBoundaryViolations(
    sandboxResult.blockedNetworkAttempts,
  );

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

  const browserResult = await dependencies.browserValidator
    .validate({
      url: input.preparationManifest.url,
    })
    .finally(async () => {
      await sandboxResult.cleanup?.();
    });

  if (!browserResult.interactable) {
    return {
      blockedNetworkAttempts: [],
      failureReason: "Configured URL loaded but was not interactable.",
      logs: [...sandboxResult.logs, ...browserResult.logs],
      screenshotArtifactId: browserResult.screenshotArtifactId,
      status: "failed",
      warnings: installPlan.warnings,
    };
  }

  return {
    blockedNetworkAttempts: [],
    logs: [...sandboxResult.logs, ...browserResult.logs],
    screenshotArtifactId: browserResult.screenshotArtifactId,
    status: "succeeded",
    warnings: installPlan.warnings,
  };
}

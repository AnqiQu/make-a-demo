import type { BrowserValidator } from "./browser-validator.interface";
import { inferInstallPlan } from "./install-plan";
import type { MakeADemoConfig } from "./makeademo-config.schema";
import { findRuntimeBoundaryViolations } from "./network-isolation-policy";
import type { SandboxRunner } from "./sandbox-runner.interface";
import type { ProjectValidationResult } from "./validation-result";

export type ProjectValidationInput = {
  config: MakeADemoConfig;
  repoUrl: string;
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
    config: input.config,
    demoCommand: input.config.demoCommand,
    repoUrl: input.repoUrl,
    url: input.config.url,
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

  const browserResult = await dependencies.browserValidator.validate({
    url: input.config.url,
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

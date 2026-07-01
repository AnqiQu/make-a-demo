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
  browserValidationTimeoutMs?: number;
  browserValidator: BrowserValidator;
  sandboxRunner: SandboxRunner;
};

const defaultBrowserValidationTimeoutMs = 60_000;

export async function validateProject(
  input: ProjectValidationInput,
  dependencies: ProjectValidationDependencies,
): Promise<ProjectValidationResult> {
  let sandboxResult: Awaited<ReturnType<SandboxRunner["runValidation"]>>;
  try {
    sandboxResult = await dependencies.sandboxRunner.runValidation({
      demoCommand: input.preparationManifest.demoCommand,
      preparationManifest: input.preparationManifest,
      ...(input.preparationWorkspace === undefined
        ? {}
        : { preparationWorkspace: input.preparationWorkspace }),
      repoUrl: input.preparationManifest.repoUrl,
      url: input.preparationManifest.url,
    });
  } catch (error) {
    const failureReason = readErrorMessage(error);
    await writeProjectValidationSandboxLog(input, {
      event: "project-validation.failed",
      failureReason,
    });
    return {
      blockedNetworkAttempts: [],
      failureReason,
      logs: [failureReason],
      status: "failed",
      warnings: [],
    };
  }
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
    await writeProjectValidationSandboxLog(input, {
      browserUrl,
      event: "project-validation.browser-validation.started",
    });
    const browserValidationTimeoutMs =
      dependencies.browserValidationTimeoutMs ??
      defaultBrowserValidationTimeoutMs;
    const browserValidationUrl =
      input.preparationWorkspace === undefined
        ? browserUrl
        : input.preparationManifest.url;
    let browserResult: Awaited<ReturnType<BrowserValidator["validate"]>>;
    try {
      browserResult = await withTimeout(
        dependencies.browserValidator.validate({
          ...(input.preparationWorkspace === undefined
            ? {}
            : { preparationWorkspace: input.preparationWorkspace }),
          url: browserValidationUrl,
        }),
        browserValidationTimeoutMs,
        `Browser validation timed out after ${browserValidationTimeoutMs}ms.`,
      );
    } catch (error) {
      if (error instanceof ProjectValidationTimeoutError) {
        await writeProjectValidationSandboxLog(input, {
          browserUrl,
          event: "project-validation.browser-validation.failed",
          failureReason: error.message,
        });
        return {
          blockedNetworkAttempts: [],
          browserUrl,
          failureReason: error.message,
          logs: [...sandboxResult.logs, error.message],
          status: "failed",
          warnings: installPlan.warnings,
        };
      }

      await writeProjectValidationSandboxLog(input, {
        browserUrl,
        event: "project-validation.browser-validation.failed",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const browserNetworkAttempts = findRuntimeBoundaryViolations(
      browserResult.blockedNetworkAttempts ?? [],
    );

    if (browserNetworkAttempts.length > 0) {
      await writeProjectValidationSandboxLog(input, {
        blockedNetworkAttemptCount: browserNetworkAttempts.length,
        browserUrl,
        event: "project-validation.browser-validation.failed",
        failureReason:
          "Runtime network communication across the sandbox boundary is not allowed.",
        screenshotArtifactId: browserResult.screenshotArtifactId,
      });
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
      const failureReason =
        readMakeADemoValidatorDependencyFailure(browserResult.logs) ??
        "Configured URL loaded but was not interactable.";
      await writeProjectValidationSandboxLog(input, {
        browserUrl,
        event: "project-validation.browser-validation.failed",
        failureReason,
        screenshotArtifactId: browserResult.screenshotArtifactId,
      });
      return {
        blockedNetworkAttempts: [],
        browserUrl,
        failureReason,
        logs: [...sandboxResult.logs, ...browserResult.logs],
        screenshotArtifactId: browserResult.screenshotArtifactId,
        status: "failed",
        warnings: installPlan.warnings,
      };
    }

    await writeProjectValidationSandboxLog(input, {
      browserUrl,
      event: "project-validation.browser-validation.succeeded",
      screenshotArtifactId: browserResult.screenshotArtifactId,
    });
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

async function writeProjectValidationSandboxLog(
  input: ProjectValidationInput,
  entry: Record<string, unknown>,
) {
  const write = input.preparationWorkspace?.workspace.writeSandboxLog?.({
    ...entry,
    repoUrl: input.preparationManifest.repoUrl,
    stage: "project-validation",
    workspaceId: input.preparationManifest.workspaceId,
  });
  if (write === undefined) {
    return;
  }

  void write.catch(() => {});
}

async function cleanupQuietly(cleanup: (() => Promise<void>) | undefined) {
  try {
    await cleanup?.();
  } catch {
    // Preserve the validation result or error that triggered cleanup.
  }
}

class ProjectValidationTimeoutError extends Error {}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readMakeADemoValidatorDependencyFailure(logs: string[]) {
  for (const log of logs) {
    const match = /MakeADemo validator dependency failure:[^\n]*/.exec(log);
    if (match !== null) {
      return match[0];
    }
  }

  return undefined;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new ProjectValidationTimeoutError(message)),
        timeoutMs,
      );
    }),
  ]);
}

import {
  createDaytonaWorkspaceResetCommand,
  daytonaWorkspaceDirectory,
} from "../../shared/integrations/daytona/workspace-command";
import type { PipelineEventLogger } from "../../shared/logging/pipeline-event-logger";
import type { RepoSecurityInput } from "../02-repo-security-screen/repo-security-screen";
import { createGitCloneCommand } from "../03-repo-preparation/git-clone-command";
import { runGitCloneWithTransientRetry } from "../03-repo-preparation/git-clone-retry";
import type { PreparationWorkspaceProvider } from "../03-repo-preparation/preparation-workspace-runner";
import type { PreparationWorkspace } from "../03-repo-preparation/preparation-workspace.interface";

export async function readRepoSecurityInput(
  provider: PreparationWorkspaceProvider,
  repoUrl: string,
  options: { logger?: PipelineEventLogger } = {},
): Promise<RepoSecurityInput> {
  const maxCloneTimeoutRetries = 2;

  for (let attempt = 0; ; attempt += 1) {
    const handle = await provider.create();
    const cloneStartedAt = Date.now();

    try {
      await logCloneEvent(options.logger, "started", repoUrl);
      await handle.workspace.setOutboundNetworkAccess(true);
      const cloneResult = await cloneWithNetworkAccess(
        handle.workspace,
        repoUrl,
      );
      if (cloneResult.exitCode !== 0) {
        const error = new Error(
          `Daytona git clone failed: ${[cloneResult.stderr, cloneResult.stdout].filter((line) => line.length > 0).join("\n")}`,
        );
        throw error;
      }
      await logCloneEvent(options.logger, "succeeded", repoUrl);
    } catch (error) {
      await logCloneEvent(options.logger, "failed", repoUrl, {
        durationMs: Date.now() - cloneStartedAt,
        error,
      });

      await handle.destroy();
      if (attempt < maxCloneTimeoutRetries && isCloneTimeoutError(error)) {
        continue;
      }

      throw error;
    }

    try {
      const statsResult = await handle.workspace.execute(
        `find ${shellQuote(daytonaWorkspaceDirectory)} -path ${shellQuote(`${daytonaWorkspaceDirectory}/.git`)} -prune -o -path ${shellQuote(`${daytonaWorkspaceDirectory}/node_modules`)} -prune -o -type f -printf '%P\\t%s\\n'`,
      );
      if (statsResult.exitCode !== 0) {
        throw new Error(`Daytona repo stats failed: ${statsResult.stderr}`);
      }

      const fileStats = statsResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [path = "", size = "0"] = line.split("\t");
          return { path, sizeBytes: Number(size) };
        });
      const files = await Promise.all(
        fileStats.map(async (file) => {
          if (!shouldReadForSecurity(file.path)) {
            return { path: file.path };
          }

          const textResult = await handle.workspace.execute(
            `cat ${shellQuote(`${daytonaWorkspaceDirectory}/${file.path}`)}`,
          );

          return {
            path: file.path,
            text: textResult.stdout,
          };
        }),
      );

      return {
        files,
        repoStats: {
          fileCount: fileStats.length,
          sizeBytes: fileStats.reduce((sum, file) => sum + file.sizeBytes, 0),
        },
      };
    } finally {
      await handle.destroy();
    }
  }
}

async function cloneWithNetworkAccess(
  workspace: PreparationWorkspace,
  repoUrl: string,
) {
  try {
    return await runGitCloneWithTransientRetry({
      clone: () =>
        workspace.execute(
          createGitCloneCommand({
            destinationPath: daytonaWorkspaceDirectory,
            repoUrl,
            resetCommand: createDaytonaWorkspaceResetCommand(),
          }),
        ),
      retryThrownErrors: false,
    });
  } finally {
    await workspace.setOutboundNetworkAccess(false);
  }
}

async function logCloneEvent(
  logger: PipelineEventLogger | undefined,
  status: "failed" | "started" | "succeeded",
  repoUrl: string,
  metadata: { durationMs?: number; error?: unknown } = {},
) {
  if (logger === undefined) {
    return;
  }

  try {
    await logger[status === "failed" ? "error" : "info"](
      {
        ...(metadata.durationMs === undefined
          ? {}
          : { durationMs: metadata.durationMs }),
        ...(metadata.error === undefined
          ? {}
          : {
              errorMessage: readErrorMessage(metadata.error),
              errorType:
                metadata.error instanceof Error
                  ? metadata.error.name
                  : typeof metadata.error,
            }),
        event: `repo-security-screen.clone.${status}`,
        externalCall: "daytona.git_clone",
        repoUrl,
        stage: "repo-security-screen",
      },
      `Daytona clone ${status}.`,
    );
  } catch {
    // Logging must never interrupt Repo Security Screen execution.
  }
}

function isCloneTimeoutError(error: unknown): boolean {
  return /Daytona command did not finish within \d+ms|etimedout|timed out|timeout/i.test(
    readErrorMessage(error),
  );
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldReadForSecurity(path: string): boolean {
  return (
    path === "package.json" || path.startsWith(".env") || path.endsWith(".sh")
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

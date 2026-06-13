import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { inferInstallPlan } from "../../../pipeline/04-project-validation/install-plan";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/04-project-validation/sandbox-runner.interface";

export class DaytonaSandboxRunner implements SandboxRunner {
  async runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
      preparationWorkspace?: PreparationWorkspaceHandle;
    },
  ): Promise<SandboxValidationOutput> {
    if (input.preparationWorkspace === undefined) {
      throw new Error("Daytona validation requires the prepared workspace.");
    }

    const handle = input.preparationWorkspace;
    try {
      const repoFilesResult = await handle.workspace.execute(
        "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort",
      );
      const repoFiles = repoFilesResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const installPlan = inferInstallPlan(repoFiles);

      await handle.workspace.setOutboundNetworkAccess(true);
      let installResult: Awaited<
        ReturnType<PreparationWorkspaceHandle["workspace"]["execute"]>
      >;
      try {
        installResult = await handle.workspace.execute(installPlan.command);
      } finally {
        await handle.workspace.setOutboundNetworkAccess(false);
      }

      if (installResult.exitCode !== 0) {
        await handle.destroy();
        return {
          blockedNetworkAttempts: [],
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
          ],
          repoFiles,
          runtimeExitCode: installResult.exitCode,
        };
      }

      const runtimeResult = await handle.workspace.execute(
        createStartDemoCommand(input.demoCommand),
      );

      return {
        blockedNetworkAttempts: [],
        cleanup: () => handle.destroy(),
        logs: [
          ...collectLogs(repoFilesResult),
          ...collectLogs(installResult),
          ...collectLogs(runtimeResult),
        ],
        repoFiles,
        runtimeExitCode: runtimeResult.exitCode,
      };
    } catch (error) {
      await destroyQuietly(handle);
      throw error;
    }
  }
}

function collectLogs(result: { stderr: string; stdout: string }): string[] {
  return [result.stdout, result.stderr].filter((line) => line.length > 0);
}

function createStartDemoCommand(demoCommand: string): string {
  return `sh -lc ${shellQuote(`cd /workspace && nohup ${demoCommand} > /tmp/makeademo-demo.log 2>&1 & echo $!`)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function destroyQuietly(
  handle: PreparationWorkspaceHandle,
): Promise<void> {
  try {
    await handle.destroy();
  } catch {
    // Preserve the original validation failure.
  }
}

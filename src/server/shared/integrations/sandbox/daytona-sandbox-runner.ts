import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { inferInstallPlan } from "../../../pipeline/04-project-validation/install-plan";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/04-project-validation/sandbox-runner.interface";

export class DaytonaSandboxRunner implements SandboxRunner {
  private readonly readinessPollIntervalMs: number;
  private readonly readinessTimeoutMs: number;

  constructor(
    options: {
      readinessPollIntervalMs?: number;
      readinessTimeoutMs?: number;
    } = {},
  ) {
    this.readinessPollIntervalMs = options.readinessPollIntervalMs ?? 1_000;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  }

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
      const readinessResult = await waitForDemoReadiness({
        pollIntervalMs: this.readinessPollIntervalMs,
        timeoutMs: this.readinessTimeoutMs,
        url: input.url,
        workspace: handle.workspace,
      });
      if (readinessResult.exitCode !== 0) {
        const demoLogsResult = await handle.workspace.execute(
          "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
        );

        return {
          blockedNetworkAttempts: [],
          cleanup: () => handle.destroy(),
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
            ...collectLogs(runtimeResult),
            ...collectLogs(readinessResult),
            ...collectLogs(demoLogsResult),
          ],
          repoFiles,
          runtimeExitCode: 1,
        };
      }
      const browserUrl = await createBrowserPreviewUrl({
        localUrl: input.url,
        workspace: handle.workspace,
      });

      return {
        blockedNetworkAttempts: [],
        browserUrl,
        cleanup: () => handle.destroy(),
        logs: [
          ...collectLogs(repoFilesResult),
          ...collectLogs(installResult),
          ...collectLogs(runtimeResult),
          ...collectLogs(readinessResult),
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

async function waitForDemoReadiness(input: {
  pollIntervalMs: number;
  timeoutMs: number;
  url: string;
  workspace: PreparationWorkspaceHandle["workspace"];
}) {
  const attempts = Math.max(
    1,
    Math.ceil(input.timeoutMs / Math.max(1, input.pollIntervalMs)),
  );
  let lastResult = {
    exitCode: 1,
    stderr: "",
    stdout: `Demo URL did not become ready: ${input.url}`,
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = await input.workspace.execute(
      createDemoReadinessCommand(input.url),
    );
    if (lastResult.exitCode === 0) {
      return lastResult;
    }

    if (input.pollIntervalMs > 0 && attempt < attempts - 1) {
      await delay(input.pollIntervalMs);
    }
  }

  return {
    exitCode: 1,
    stderr: lastResult.stderr,
    stdout:
      lastResult.stdout.length > 0
        ? lastResult.stdout
        : `Demo URL did not become ready: ${input.url}`,
  };
}

function createDemoReadinessCommand(url: string): string {
  return `node -e ${shellQuote("fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));")} ${shellQuote(url)}`;
}

function readPortFromLocalUrl(url: string): number {
  const parsedUrl = new URL(url);
  if (parsedUrl.port.length > 0) {
    return Number(parsedUrl.port);
  }

  return parsedUrl.protocol === "https:" ? 443 : 80;
}

async function createBrowserPreviewUrl(input: {
  localUrl: string;
  workspace: PreparationWorkspaceHandle["workspace"];
}): Promise<string> {
  const localUrl = new URL(input.localUrl);
  const previewUrl = new URL(
    await input.workspace.getPreviewUrl(readPortFromLocalUrl(input.localUrl)),
  );
  previewUrl.pathname = localUrl.pathname;
  previewUrl.search = localUrl.search;
  previewUrl.hash = localUrl.hash;

  return previewUrl.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

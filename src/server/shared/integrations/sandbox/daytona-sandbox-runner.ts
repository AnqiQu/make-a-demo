import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../../pipeline/03-repo-preparation/preparation-workspace-runner";
import { inferInstallPlan } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/install-plan";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";

export class DaytonaSandboxRunner implements SandboxRunner {
  private readonly destroyWorkspaceOnCleanup: boolean;
  private readonly readinessPollIntervalMs: number;
  private readonly readinessTimeoutMs: number;

  constructor(
    options: {
      destroyWorkspaceOnCleanup?: boolean;
      readinessPollIntervalMs?: number;
      readinessTimeoutMs?: number;
    } = {},
  ) {
    this.destroyWorkspaceOnCleanup = options.destroyWorkspaceOnCleanup ?? false;
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
    const writeSandboxLog = (entry: Record<string, unknown>) =>
      handle.workspace.writeSandboxLog?.({
        ...entry,
        repoUrl: input.repoUrl,
        stage: "project-validation",
        workspaceId: input.preparationManifest.workspaceId,
      });
    try {
      await writeSandboxLog({ event: "project-validation.started" });
      const repoFilesResult = await handle.workspace.execute(
        "find /workspace -maxdepth 1 -mindepth 1 -printf '%f\\n' | sort",
      );
      const repoFiles = repoFilesResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const installPlan = inferInstallPlan(repoFiles);
      await writeSandboxLog({
        command: installPlan.command,
        event: "project-validation.dependency-install.started",
      });

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
        await writeSandboxLog({
          command: installPlan.command,
          event: "project-validation.dependency-install.failed",
          exitCode: installResult.exitCode,
          stderr: installResult.stderr,
          stdout: installResult.stdout,
        });
        await this.cleanup(handle);
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
      await writeSandboxLog({
        command: installPlan.command,
        event: "project-validation.dependency-install.succeeded",
        exitCode: installResult.exitCode,
      });

      await writeSandboxLog({
        command: input.demoCommand,
        event: "project-validation.demo-command.started",
        url: input.url,
      });
      await handle.workspace.execute(createStopDemoCommand());
      const runtimeResult = await handle.workspace.execute(
        createStartDemoCommand(input.demoCommand),
      );
      await writeSandboxLog({
        event: "project-validation.demo-command.launched",
        exitCode: runtimeResult.exitCode,
        stdout: runtimeResult.stdout,
      });
      const readinessResult = await waitForDemoReadiness({
        pollIntervalMs: this.readinessPollIntervalMs,
        timeoutMs: this.readinessTimeoutMs,
        url: input.url,
        workspace: handle.workspace,
      });
      if (readinessResult.exitCode !== 0) {
        await writeSandboxLog({
          event: "project-validation.demo-readiness.failed",
          stderr: readinessResult.stderr,
          stdout: readinessResult.stdout,
          url: input.url,
        });
        const demoLogsResult = await handle.workspace.execute(
          "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
        );
        await writeDemoServerLog(writeSandboxLog, demoLogsResult.stdout);

        return {
          blockedNetworkAttempts: [],
          cleanup: () => this.cleanup(handle),
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
      await writeSandboxLog({
        event: "project-validation.demo-readiness.succeeded",
        url: input.url,
      });
      const baselineResult = await handle.workspace.execute(
        createFreshCaptureBaselineCommand(),
      );
      if (baselineResult.exitCode !== 0) {
        await writeSandboxLog({
          event: "project-validation.fresh-capture-baseline.failed",
          stderr: baselineResult.stderr,
          stdout: baselineResult.stdout,
        });
        return {
          blockedNetworkAttempts: [],
          cleanup: () => this.cleanup(handle),
          logs: [
            ...collectLogs(repoFilesResult),
            ...collectLogs(installResult),
            ...collectLogs(runtimeResult),
            ...collectLogs(readinessResult),
            ...collectLogs(baselineResult),
          ],
          repoFiles,
          runtimeExitCode: 1,
        };
      }
      await writeSandboxLog({
        event: "project-validation.fresh-capture-baseline.created",
      });
      const demoLogsResult = await handle.workspace.execute(
        "if test -f /tmp/makeademo-demo.log; then cat /tmp/makeademo-demo.log; fi",
      );
      await writeDemoServerLog(writeSandboxLog, demoLogsResult.stdout);
      const browserUrl = await createBrowserPreviewUrl({
        localUrl: input.url,
        workspace: handle.workspace,
      });
      await writeSandboxLog({
        browserUrl,
        event: "project-validation.browser-preview.created",
      });

      return {
        blockedNetworkAttempts: [],
        browserUrl,
        cleanup: () => this.cleanup(handle),
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
      await this.cleanup(handle);
      throw error;
    }
  }

  private async cleanup(handle: PreparationWorkspaceHandle): Promise<void> {
    if (this.destroyWorkspaceOnCleanup) {
      await handle.destroy();
    }
  }
}

export async function restartPreparedDemoForFreshCapture(input: {
  preparationManifest: PreparationManifest;
  preparationWorkspace: PreparationWorkspaceHandle;
  readinessPollIntervalMs?: number;
  readinessTimeoutMs?: number;
}): Promise<{ browserUrl: string }> {
  const writeSandboxLog = (entry: Record<string, unknown>) =>
    input.preparationWorkspace.workspace.writeSandboxLog?.({
      ...entry,
      repoUrl: input.preparationManifest.repoUrl,
      stage: "footage-capture",
      workspaceId: input.preparationManifest.workspaceId,
    });

  await writeSandboxLog({
    command: input.preparationManifest.demoCommand,
    event: "footage-capture.fresh-state.restart.started",
    url: input.preparationManifest.url,
  });
  await input.preparationWorkspace.workspace.execute(createStopDemoCommand());
  const restoreResult = await input.preparationWorkspace.workspace.execute(
    createFreshCaptureRestoreCommand(),
  );
  if (restoreResult.exitCode !== 0) {
    await writeSandboxLog({
      event: "footage-capture.fresh-state.restore.failed",
      stderr: restoreResult.stderr,
      stdout: restoreResult.stdout,
    });
    throw new Error("Fresh Footage Capture baseline could not be restored.");
  }
  await writeSandboxLog({
    event: "footage-capture.fresh-state.restore.succeeded",
  });
  const runtimeResult = await input.preparationWorkspace.workspace.execute(
    createStartDemoCommand(input.preparationManifest.demoCommand),
  );
  await writeSandboxLog({
    event: "footage-capture.fresh-state.restart.launched",
    exitCode: runtimeResult.exitCode,
    stdout: runtimeResult.stdout,
  });
  const readinessResult = await waitForDemoReadiness({
    pollIntervalMs: input.readinessPollIntervalMs ?? 1_000,
    timeoutMs: input.readinessTimeoutMs ?? 30_000,
    url: input.preparationManifest.url,
    workspace: input.preparationWorkspace.workspace,
  });
  if (runtimeResult.exitCode !== 0 || readinessResult.exitCode !== 0) {
    await writeSandboxLog({
      event: "footage-capture.fresh-state.restart.failed",
      runtimeExitCode: runtimeResult.exitCode,
      stderr: readinessResult.stderr,
      stdout: readinessResult.stdout,
      url: input.preparationManifest.url,
    });
    throw new Error("Fresh Footage Capture state did not become ready.");
  }

  const browserUrl = await createBrowserPreviewUrl({
    localUrl: input.preparationManifest.url,
    workspace: input.preparationWorkspace.workspace,
  });
  await writeSandboxLog({
    browserUrl,
    event: "footage-capture.fresh-state.restart.succeeded",
  });

  return { browserUrl };
}

async function writeDemoServerLog(
  writeSandboxLog: (
    entry: Record<string, unknown>,
  ) => Promise<void> | undefined,
  output: string,
): Promise<void> {
  if (output.length === 0) {
    return;
  }

  await writeSandboxLog({
    event: "project-validation.demo-server-log",
    log: output,
  });
}

function collectLogs(result: { stderr: string; stdout: string }): string[] {
  return [result.stdout, result.stderr].filter((line) => line.length > 0);
}

function createStartDemoCommand(demoCommand: string): string {
  return `sh -lc ${shellQuote(`cd /workspace && nohup setsid sh -c ${shellQuote(`exec ${demoCommand}`)} > /tmp/makeademo-demo.log 2>&1 & echo $! > /tmp/makeademo-demo.pid && echo $!`)}`;
}

function createStopDemoCommand(): string {
  return `sh -lc ${shellQuote("if test -f /tmp/makeademo-demo.pid; then kill -- -$(cat /tmp/makeademo-demo.pid) >/dev/null 2>&1 || true; rm -f /tmp/makeademo-demo.pid; fi")}`;
}

function createFreshCaptureBaselineCommand(): string {
  return `sh -lc ${shellQuote("mkdir -p /workspace/.makeademo && tar --exclude='./.makeademo' --exclude='./node_modules' -czf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace .")}`;
}

function createFreshCaptureRestoreCommand(): string {
  return `sh -lc ${shellQuote("test -f /workspace/.makeademo/fresh-capture-baseline.tgz && find /workspace -mindepth 1 ! -path '/workspace/.makeademo' ! -path '/workspace/.makeademo/*' ! -path '/workspace/node_modules' ! -path '/workspace/node_modules/*' -exec rm -rf {} + && tar -xzf /workspace/.makeademo/fresh-capture-baseline.tgz -C /workspace")}`;
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

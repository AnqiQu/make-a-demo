import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import { inferInstallPlan } from "../../../pipeline/04-project-validation/install-plan";
import type { NetworkAttempt } from "../../../pipeline/04-project-validation/network-isolation-policy";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/04-project-validation/sandbox-runner.interface";

type SandboxCommandInput = {
  command: string;
  cwd: string;
  mode: "exit" | "start";
  readyUrl?: string;
};

type SandboxCommandOutput = {
  blockedNetworkAttempts?: NetworkAttempt[];
  cleanup?: () => Promise<void>;
  exitCode: number;
  logs: string[];
};

export type SandboxCommandRunner = (
  input: SandboxCommandInput,
) => Promise<SandboxCommandOutput>;

export type DockerSandboxRunnerOptions = {
  commandRunner?: SandboxCommandRunner;
  workspaceRoot?: string;
};

export class DockerSandboxRunner implements SandboxRunner {
  private readonly commandRunner: SandboxCommandRunner;
  private readonly workspaceRoot: string;

  constructor(options: DockerSandboxRunnerOptions = {}) {
    this.commandRunner = options.commandRunner ?? runShellCommand;
    this.workspaceRoot = options.workspaceRoot ?? "/tmp/makeademo-workspaces";
  }

  async runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
    },
  ): Promise<SandboxValidationOutput> {
    // TODO: Replace this local-process runner with a hardened Docker sandbox that
    // enforces filesystem isolation, resource limits, and runtime network lockdown.
    const workspaceDirectory = join(
      this.workspaceRoot,
      input.preparationManifest.workspaceId,
    );
    const repoFiles = await listTopLevelFiles(workspaceDirectory);
    const installPlan = inferInstallPlan(repoFiles);
    const installResult = await this.commandRunner({
      command: installPlan.command,
      cwd: workspaceDirectory,
      mode: "exit",
    });

    if (installResult.exitCode !== 0) {
      return {
        blockedNetworkAttempts: installResult.blockedNetworkAttempts ?? [],
        logs: installResult.logs,
        repoFiles,
        runtimeExitCode: installResult.exitCode,
      };
    }

    const runtimeResult = await this.commandRunner({
      command: input.demoCommand,
      cwd: workspaceDirectory,
      mode: "start",
      readyUrl: input.url,
    });

    return {
      blockedNetworkAttempts: [
        ...(installResult.blockedNetworkAttempts ?? []),
        ...(runtimeResult.blockedNetworkAttempts ?? []),
      ],
      ...(runtimeResult.cleanup === undefined
        ? {}
        : { cleanup: runtimeResult.cleanup }),
      logs: [...installResult.logs, ...runtimeResult.logs],
      repoFiles,
      runtimeExitCode: runtimeResult.exitCode,
    };
  }
}

async function listTopLevelFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.map((entry) => entry.name).sort();
}

async function runShellCommand(
  input: SandboxCommandInput,
): Promise<SandboxCommandOutput> {
  const child = spawn(input.command, {
    cwd: input.cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  if (input.mode === "exit") {
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });

    return { exitCode: exitCode ?? 1, logs };
  }

  if (input.readyUrl !== undefined) {
    await waitForReadyUrl(input.readyUrl, child, logs);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  if (child.exitCode === null) {
    return {
      cleanup: async () => {
        child.kill("SIGTERM");
      },
      exitCode: 0,
      logs,
    };
  }

  return { exitCode: child.exitCode, logs };
}

async function waitForReadyUrl(
  url: string,
  child: ReturnType<typeof spawn>,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return;
    }

    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (response.ok) {
        logs.push(`Runtime ready at ${url}`);
        return;
      }
    } catch {
      // Keep polling until the runtime is reachable or exits.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  logs.push(`Runtime did not become ready at ${url} before timeout`);
}

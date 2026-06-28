import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeSubmittedCode } from "../03-repo-preparation/submitted-code-execution";
import {
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "../06-footage-capture/capture-sdk-contract";
import { prepareStylizedPlaywrightScript } from "../06-footage-capture/stylized-playwright-script";
import type {
  CapturePathSceneValidationInput,
  CapturePathSceneValidationResult,
  CapturePathSceneValidator,
} from "./capture-path-validator";

export class DefaultCapturePathSceneValidator
  implements CapturePathSceneValidator
{
  async validateScene(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult> {
    if (input.preparationWorkspace !== undefined) {
      return await this.validateSceneInPreparationWorkspace(input);
    }

    const runDirectory = join(
      ".makeademo-capture-path-validation-runs",
      createRunId(),
      input.scene.id,
    );
    const scenePath = join(runDirectory, `${input.scene.id}.ts`);
    const stderrPath = join(runDirectory, `${input.scene.id}.stderr.log`);
    const stdoutPath = join(runDirectory, `${input.scene.id}.stdout.log`);

    await mkdir(runDirectory, { recursive: true });
    await writeGeneratedCaptureSdkHarness(runDirectory);
    try {
      await validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: input.demoPlaywrightScript,
        directory: runDirectory,
      });
    } catch (error) {
      return {
        failureReason: "Demo Script failed Capture SDK TypeScript validation.",
        logs: [error instanceof Error ? error.message : String(error)],
        runDirectory,
        status: "failed",
      };
    }
    await writeFile(
      scenePath,
      prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
        baseUrl: input.baseUrl,
        headed: false,
        mode: "validation",
        pauseAfterSceneMs: 0,
      }),
    );

    const result = await runSceneScript(scenePath);
    await Promise.all([
      writeFile(stdoutPath, result.stdout),
      writeFile(stderrPath, result.stderr),
    ]);
    const logs = [result.stdout, result.stderr].filter(
      (output) => output.length > 0,
    );
    const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
    if (blockedNetworkAttempts.length > 0) {
      return {
        blockedNetworkAttempts,
        failureReason:
          "Capture Path Validation blocked runtime network access from the generated Demo Script.",
        logs,
        runDirectory,
        scriptPath: scenePath,
        stderrPath,
        status: "failed",
        stdoutPath,
      };
    }

    if (result.exitCode !== 0) {
      return {
        failureReason: `Scene ${input.scene.id} failed during Capture Path Validation.`,
        logs,
        runDirectory,
        scriptPath: scenePath,
        stderrPath,
        status: "failed",
        stdoutPath,
      };
    }

    return {
      logs,
      runDirectory,
      scriptPath: scenePath,
      status: "succeeded",
      stderrPath,
      stdoutPath,
    };
  }

  private async validateSceneInPreparationWorkspace(
    input: CapturePathSceneValidationInput,
  ): Promise<CapturePathSceneValidationResult> {
    const preparationWorkspace = input.preparationWorkspace;
    if (preparationWorkspace === undefined) {
      throw new Error(
        "Capture Path Validation requires a preparation workspace.",
      );
    }
    const localRunDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-capture-path-validation-"),
    );
    const remoteRunDirectory = `/workspace/.makeademo/capture-path-validation-runs/${createRunId()}/${input.scene.id}`;
    const remoteScenePath = `${remoteRunDirectory}/${input.scene.id}.ts`;
    const remoteStdoutPath = `${remoteRunDirectory}/${input.scene.id}.stdout.log`;
    const remoteStderrPath = `${remoteRunDirectory}/${input.scene.id}.stderr.log`;
    const localScenePath = join(localRunDirectory, `${input.scene.id}.ts`);
    const localSdkRuntimePath = join(
      localRunDirectory,
      "makeademo-capture-sdk.js",
    );
    const localSdkDeclarationPath = join(
      localRunDirectory,
      "makeademo-capture-sdk.d.ts",
    );
    const localSdkInstructionsPath = join(
      localRunDirectory,
      "makeademo-capture-sdk.instructions.md",
    );
    const localContractPath = join(
      localRunDirectory,
      "demo-script.contract.ts",
    );

    try {
      await writeGeneratedCaptureSdkHarness(localRunDirectory);
      try {
        await validateDemoScriptCaptureSdkTypes({
          demoPlaywrightScript: input.demoPlaywrightScript,
          directory: localRunDirectory,
        });
      } catch (error) {
        return {
          failureReason:
            "Demo Script failed Capture SDK TypeScript validation.",
          logs: [error instanceof Error ? error.message : String(error)],
          runDirectory: remoteRunDirectory,
          status: "failed",
        };
      }
      await writeFile(
        localScenePath,
        prepareStylizedPlaywrightScript(input.demoPlaywrightScript, {
          baseUrl: input.baseUrl,
          headed: false,
          mode: "validation",
          pauseAfterSceneMs: 0,
        }),
      );
      await executeSubmittedCode(
        preparationWorkspace.workspace,
        `mkdir -p ${shellQuote(remoteRunDirectory)}`,
      );
      await preparationWorkspace.workspace.uploadFiles([
        {
          destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.js`,
          sourcePath: localSdkRuntimePath,
        },
        {
          destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.d.ts`,
          sourcePath: localSdkDeclarationPath,
        },
        {
          destinationPath: `${remoteRunDirectory}/makeademo-capture-sdk.instructions.md`,
          sourcePath: localSdkInstructionsPath,
        },
        {
          destinationPath: `${remoteRunDirectory}/demo-script.contract.ts`,
          sourcePath: localContractPath,
        },
        { destinationPath: remoteScenePath, sourcePath: localScenePath },
      ]);

      const result = await executeSubmittedCode(
        preparationWorkspace.workspace,
        [
          `cd ${shellQuote(remoteRunDirectory)}`,
          `timeout -s TERM 120 bun ${shellQuote(remoteScenePath)} > ${shellQuote(remoteStdoutPath)} 2> ${shellQuote(remoteStderrPath)}`,
          "code=$?",
          `cat ${shellQuote(remoteStdoutPath)}`,
          `cat ${shellQuote(remoteStderrPath)} >&2`,
          "exit $code",
        ].join("; "),
      );
      const logs = [result.stdout, result.stderr].filter(
        (output) => output.length > 0,
      );
      const blockedNetworkAttempts = readBlockedNetworkAttempts(result.stderr);
      if (blockedNetworkAttempts.length > 0) {
        return {
          blockedNetworkAttempts,
          failureReason:
            "Capture Path Validation blocked runtime network access from the generated Demo Script.",
          logs,
          runDirectory: remoteRunDirectory,
          scriptPath: remoteScenePath,
          stderrPath: remoteStderrPath,
          status: "failed",
          stdoutPath: remoteStdoutPath,
        };
      }

      if (result.exitCode !== 0) {
        return {
          failureReason: `Scene ${input.scene.id} failed during Capture Path Validation.`,
          logs,
          runDirectory: remoteRunDirectory,
          scriptPath: remoteScenePath,
          stderrPath: remoteStderrPath,
          status: "failed",
          stdoutPath: remoteStdoutPath,
        };
      }

      return {
        logs,
        runDirectory: remoteRunDirectory,
        scriptPath: remoteScenePath,
        status: "succeeded",
        stderrPath: remoteStderrPath,
        stdoutPath: remoteStdoutPath,
      };
    } finally {
      await rm(localRunDirectory, { force: true, recursive: true });
    }
  }
}

async function runSceneScript(scenePath: string) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [scenePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function readBlockedNetworkAttempts(stderr: string) {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[makeademo:network-blocked] "))
    .map((line) =>
      JSON.parse(line.slice("[makeademo:network-blocked] ".length)),
    )
    .filter(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        value.direction === "outbound" &&
        value.phase === "runtime" &&
        typeof value.host === "string",
    )
    .map((value) => ({
      direction: "outbound" as const,
      host: value.host as string,
      phase: "runtime" as const,
    }));
}

function createRunId() {
  return `capture-path-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

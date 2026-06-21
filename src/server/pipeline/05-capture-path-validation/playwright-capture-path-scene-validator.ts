import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
    const runDirectory = join(
      ".makeademo-capture-path-validation-runs",
      createRunId(),
      input.scene.id,
    );
    const scenePath = join(runDirectory, `${input.scene.id}.ts`);
    const stderrPath = join(runDirectory, `${input.scene.id}.stderr.log`);
    const stdoutPath = join(runDirectory, `${input.scene.id}.stdout.log`);

    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      scenePath,
      prepareStylizedPlaywrightScript(input.scene.playwrightScript, {
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

function createRunId() {
  return `capture-path-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

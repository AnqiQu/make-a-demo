import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareStylizedPlaywrightScript } from "../06-capture/stylized-playwright-script";
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
    const logs = [result.stdout, result.stderr].filter(
      (output) => output.length > 0,
    );

    if (result.exitCode !== 0) {
      return {
        failureReason: `Scene ${input.scene.id} failed during Capture Path Validation.`,
        logs,
        status: "failed",
      };
    }

    return { logs, status: "succeeded" };
  }
}

async function runSceneScript(scenePath: string) {
  const child = Bun.spawn([process.execPath, scenePath], {
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stderr, stdout };
}

function createRunId() {
  return `capture-path-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

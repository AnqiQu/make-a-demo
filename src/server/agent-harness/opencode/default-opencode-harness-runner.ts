import { randomUUID } from "node:crypto";
import type {
  OpenCodeHarnessRunInput,
  OpenCodeHarnessRunResult,
  OpenCodeHarnessRunner,
} from "./opencode-harness";

export class DefaultOpenCodeHarnessRunner implements OpenCodeHarnessRunner {
  async run(input: OpenCodeHarnessRunInput): Promise<OpenCodeHarnessRunResult> {
    const sessionId = input.sessionId ?? `makeademo-${randomUUID()}`;
    const result = await input.workspace.execute(
      createOpenCodeRunCommand({
        model: input.model,
        prompt: input.prompt,
        sessionId,
        workingDirectory: input.workingDirectory,
      }),
      {
        env: {
          OPENCODE_CONFIG_DIR: input.configDir,
          OPENCODE_ENABLE_EXA: "1",
        },
      },
    );

    return { ...result, sessionId };
  }
}

function createOpenCodeRunCommand(input: {
  model: string;
  prompt: string;
  sessionId: string;
  workingDirectory: string;
}): string {
  return [
    "opencode run",
    "--dangerously-skip-permissions",
    "--format json",
    `--dir ${shellQuote(input.workingDirectory)}`,
    `--session ${shellQuote(input.sessionId)}`,
    `--model ${shellQuote(input.model)}`,
    shellQuote(input.prompt),
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

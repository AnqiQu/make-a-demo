import type {
  OpenCodeHarnessRunInput,
  OpenCodeHarnessRunResult,
  OpenCodeHarnessRunner,
} from "./opencode-harness";

export class DefaultOpenCodeHarnessRunner implements OpenCodeHarnessRunner {
  async run(input: OpenCodeHarnessRunInput): Promise<OpenCodeHarnessRunResult> {
    const result = await input.workspace.execute(
      createOpenCodeRunCommand({
        configDir: input.configDir,
        model: input.model,
        prompt: input.prompt,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        workingDirectory: input.workingDirectory,
      }),
      {
        env: {
          OPENCODE_CONFIG_DIR: input.configDir,
          OPENCODE_ENABLE_EXA: "1",
        },
      },
    );

    const sessionId = input.sessionId ?? readSessionId(result);
    return {
      ...result,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
}

function createOpenCodeRunCommand(input: {
  configDir: string;
  model: string;
  prompt: string;
  sessionId?: string;
  workingDirectory: string;
}): string {
  return [
    `mkdir -p ${shellQuote(input.configDir)} &&`,
    "opencode run",
    "--dangerously-skip-permissions",
    "--format json",
    `--dir ${shellQuote(input.workingDirectory)}`,
    ...(input.sessionId === undefined
      ? []
      : [`--session ${shellQuote(input.sessionId)}`]),
    `--model ${shellQuote(input.model)}`,
    shellQuote(input.prompt),
  ].join(" ");
}

function readSessionId(result: {
  stderr: string;
  stdout: string;
}): string | undefined {
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const value = JSON.parse(trimmed) as { sessionID?: unknown };
      if (typeof value.sessionID === "string" && value.sessionID.length > 0) {
        return value.sessionID;
      }
    } catch {}
  }

  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

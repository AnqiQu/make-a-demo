import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

const makeADemoArtifactDirectory = "/workspace/.makeademo";

const daytonaOpenCodeActivityLogPath = `${makeADemoArtifactDirectory}/opencode-activity.jsonl`;

export type DaytonaOpenCodeActivityStage =
  | "repo-preparation"
  | "script-generation";

export async function appendDaytonaOpenCodeActivityLog(
  workspace: PreparationWorkspace,
  entry: Record<string, unknown> & { stage: DaytonaOpenCodeActivityStage },
): Promise<void> {
  const payload = {
    ...entry,
    source: entry.source ?? "opencode",
    timestamp: new Date().toISOString(),
  };

  const result = await workspace.execute(
    `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} && printf '%s\n' ${shellQuote(JSON.stringify(payload))} >> ${shellQuote(daytonaOpenCodeActivityLogPath)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to write Daytona OpenCode activity log.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";

export type DaytonaOpenCodeActivityStage =
  | "repo-preparation"
  | "script-generation";

export async function writeDaytonaOpenCodeActivityLog(
  workspace: PreparationWorkspace,
  entry: Record<string, unknown> & { stage: DaytonaOpenCodeActivityStage },
): Promise<void> {
  const payload = createOpenCodeActivityLogEntry(entry);
  if (payload === undefined) {
    return;
  }

  await workspace.writeSandboxLog?.(payload);
}

function createOpenCodeActivityLogEntry(
  entry: Record<string, unknown> & { stage: DaytonaOpenCodeActivityStage },
) {
  const raw = typeof entry.raw === "string" ? entry.raw : undefined;
  if (raw !== undefined && isTerminalControlOnly(raw)) {
    return undefined;
  }

  const parsed = raw === undefined ? undefined : parseOpenCodeEvent(raw);
  const parsedType = readStringField(parsed, "type");
  const tool = readStringField(parsed, "tool");
  const state = readStringField(parsed, "state");
  const title = readStringField(parsed, "title");

  return {
    ...entry,
    ...(parsed === undefined ? {} : { parsed }),
    ...(parsedType === undefined ? {} : { eventType: parsedType }),
    ...(tool === undefined ? {} : { tool }),
    ...(state === undefined ? {} : { toolState: state }),
    ...(title === undefined ? {} : { toolTitle: title }),
    event:
      parsedType === undefined ? "opencode.output" : `opencode.${parsedType}`,
    source: entry.source ?? "opencode",
  };
}

function isTerminalControlOnly(raw: string): boolean {
  const visible = removeAnsiSequences(raw)
    .split("")
    .filter((character) => !isAsciiControl(character))
    .join("")
    .trim();
  return visible.length === 0 || visible === ">";
}

function removeAnsiSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }

    index += 1;
    if (value[index] !== "[") {
      continue;
    }

    while (index + 1 < value.length) {
      index += 1;
      const code = value.charCodeAt(index);
      if (code >= 64 && code <= 126) {
        break;
      }
    }
  }
  return result;
}

function isAsciiControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function parseOpenCodeEvent(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.length > 0
    ? fieldValue
    : undefined;
}

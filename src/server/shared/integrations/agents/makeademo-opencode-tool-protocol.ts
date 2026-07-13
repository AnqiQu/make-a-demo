/** A validated backend handoff emitted by a MakeADemo OpenCode tool. */
export type MakeADemoOpenCodeToolPayload =
  | {
      input: { command: string };
      toolName:
        | "makeademo_dependency_request_install"
        | "makeademo_install_dependencies";
    }
  | {
      input: { manifestPath: string };
      toolName: "makeademo_validate_preparation";
    };

export type MakeADemoOpenCodeToolName =
  | "makeademo_dependency_request_install"
  | "makeademo_install_dependencies"
  | "makeademo_validate_preparation";

/**
 * Tracks OpenCode's streamed JSON protocol across arbitrary chunk boundaries.
 * Completed tool calls are kept separately so callers can interrupt a still-running
 * OpenCode command only after the tool state machine has committed the handoff.
 */
export function createMakeADemoOpenCodeProtocolTracker(): {
  readCompletedPayload: () => MakeADemoOpenCodeToolPayload | undefined;
  readPayload: () => MakeADemoOpenCodeToolPayload | undefined;
  readPayloadError: () => string | undefined;
  readSessionID: () => string | undefined;
  readTool: () => MakeADemoOpenCodeToolName | undefined;
  write: (chunk: string) => void;
} {
  const maximumJsonCarryLength = 65_536;
  const maximumToolCarryLength = 64;
  let jsonCarry = "";
  let toolCarry = "";
  let latestCompletedPayload: MakeADemoOpenCodeToolPayload | undefined;
  let latestError: string | undefined;
  let latestPayload: MakeADemoOpenCodeToolPayload | undefined;
  let latestTool: MakeADemoOpenCodeToolName | undefined;
  let sessionID: string | undefined;

  return {
    readCompletedPayload() {
      return latestCompletedPayload ?? readLatestCompletedPayload(jsonCarry);
    },
    readPayload() {
      return latestPayload ?? readLatestPayload(jsonCarry);
    },
    readPayloadError() {
      if (readLatestPayload(jsonCarry) !== undefined) return undefined;
      return readLatestPayloadError(jsonCarry) ?? latestError;
    },
    readSessionID() {
      sessionID ??= readOpenCodeSessionID(jsonCarry);
      return sessionID;
    },
    readTool: () => latestTool,
    write(chunk) {
      const toolOutput = `${toolCarry}${chunk}`;
      latestTool = readLatestMakeADemoTool(toolOutput) ?? latestTool;
      toolCarry = toolOutput.slice(-maximumToolCarryLength);

      const output = `${jsonCarry}${chunk}`;
      const lines = output.split("\n");
      jsonCarry = lines.pop() ?? "";
      for (const line of lines) {
        sessionID ??= readOpenCodeSessionID(line);
        const payload = readLatestPayload(line);
        const completedPayload = readLatestCompletedPayload(line);
        if (completedPayload !== undefined)
          latestCompletedPayload = completedPayload;
        if (payload !== undefined) {
          latestPayload = payload;
          latestError = undefined;
        } else {
          const error = readLatestPayloadError(line);
          if (error !== undefined) {
            latestPayload = undefined;
            latestError = error;
          }
        }
      }
      if (jsonCarry.length > maximumJsonCarryLength) {
        jsonCarry = jsonCarry.slice(-maximumJsonCarryLength);
      }
      latestCompletedPayload ??= readLatestCompletedPayload(jsonCarry);
    },
  };
}

export function readOpenCodeProtocolResult(output: string): {
  payload?: MakeADemoOpenCodeToolPayload;
  payloadError?: string;
  sessionID?: string;
  tool?: MakeADemoOpenCodeToolName;
} {
  const payload = readLatestPayload(output);
  const payloadError = readLatestPayloadError(output);
  const sessionID = readOpenCodeSessionID(output);
  const tool = readLatestMakeADemoTool(output);
  return {
    ...(payload === undefined ? {} : { payload }),
    ...(payloadError === undefined ? {} : { payloadError }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(tool === undefined ? {} : { tool }),
  };
}

export function parseOpenCodeJsonPayload(stdout: string): unknown | undefined {
  const direct = tryParseJson(stdout);
  if (direct !== undefined) return direct;
  const text = stdout
    .split("\n")
    .map(tryParseJson)
    .filter((event): event is Record<string, unknown> => event !== undefined)
    .filter((event) => event.type === "text")
    .map((event) => {
      const part = event.part;
      return typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "";
    })
    .join("\n");
  return tryParseJson(text);
}

export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readOpenCodeSessionID(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const event = tryParseJson(line);
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (typeof record.sessionID === "string" && record.sessionID.length > 0)
      return record.sessionID;
    const session = record.session;
    if (typeof session === "object" && session !== null) {
      const id = (session as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
    if (
      typeof record.type === "string" &&
      record.type.includes("session") &&
      typeof record.id === "string" &&
      record.id.length > 0
    )
      return record.id;
  }
  return undefined;
}

function readLatestMakeADemoTool(
  output: string,
): MakeADemoOpenCodeToolName | undefined {
  let latest: MakeADemoOpenCodeToolName | undefined;
  const pattern =
    /\b(makeademo_(?:dependency_request_install|install_dependencies|validate_preparation))\b/g;
  for (const match of output.matchAll(pattern))
    latest = match[1] as MakeADemoOpenCodeToolName;
  return latest;
}

function readLatestPayload(
  output: string,
): MakeADemoOpenCodeToolPayload | undefined {
  let latest: MakeADemoOpenCodeToolPayload | undefined;
  for (const line of output.split("\n")) {
    const event = tryParseJson(line);
    if (event === undefined) continue;
    for (const payload of readPayloads(event)) latest = payload;
  }
  return latest;
}

function readLatestCompletedPayload(
  output: string,
): MakeADemoOpenCodeToolPayload | undefined {
  let latest: MakeADemoOpenCodeToolPayload | undefined;
  for (const line of output.split("\n")) {
    const event = tryParseJson(line);
    if (event === undefined) continue;
    for (const payload of readCompletedPayloads(event)) latest = payload;
  }
  return latest;
}

function readCompletedPayloads(value: unknown): MakeADemoOpenCodeToolPayload[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const payload = createPayload(readToolName(record), readToolInput(record));
  const payloads =
    payload !== undefined && isCompleted(record) ? [payload] : [];
  for (const child of Object.values(record)) {
    if (typeof child === "object" && child !== null)
      payloads.push(...readCompletedPayloads(child));
  }
  return payloads;
}

function isCompleted(record: Record<string, unknown>): boolean {
  if (record.status === "completed") return true;
  return (
    typeof record.state === "object" &&
    record.state !== null &&
    (record.state as Record<string, unknown>).status === "completed"
  );
}

function readLatestPayloadError(output: string): string | undefined {
  let latest: string | undefined;
  for (const line of output.split("\n")) {
    const event = tryParseJson(line);
    if (event === undefined) {
      const tool = readLatestMakeADemoTool(line);
      if (tool !== undefined && line.trimStart().startsWith("{"))
        latest = `${tool} payload is not parseable JSON`;
    } else if (readPayloads(event).length > 0) {
      latest = undefined;
    } else {
      latest = readPayloadError(event) ?? latest;
    }
  }
  return latest;
}

function readPayloadError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const tool = readToolName(record);
  const input = readToolInput(record);
  if (tool !== undefined) return describePayloadError(tool, input);
  let latest: string | undefined;
  for (const child of Object.values(record)) {
    if (typeof child === "object" && child !== null)
      latest = readPayloadError(child) ?? latest;
  }
  return latest;
}

function describePayloadError(
  tool: MakeADemoOpenCodeToolName,
  input: unknown,
): string | undefined {
  if (tool === "makeademo_validate_preparation") {
    return typeof input === "object" &&
      input !== null &&
      typeof (input as { manifestPath?: unknown }).manifestPath === "string"
      ? undefined
      : `${tool} payload is missing required field input.manifestPath`;
  }
  return typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
    ? undefined
    : `${tool} payload is missing required field input.command`;
}

function readPayloads(value: unknown): MakeADemoOpenCodeToolPayload[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const payload = createPayload(readToolName(record), readToolInput(record));
  const payloads = payload === undefined ? [] : [payload];
  for (const child of Object.values(record)) {
    if (typeof child === "object" && child !== null)
      payloads.push(...readPayloads(child));
  }
  return payloads;
}

function readToolName(
  record: Record<string, unknown>,
): MakeADemoOpenCodeToolName | undefined {
  for (const key of ["toolName", "tool", "name"]) {
    const value = record[key];
    if (
      value === "makeademo_dependency_request_install" ||
      value === "makeademo_install_dependencies" ||
      value === "makeademo_validate_preparation"
    )
      return value;
  }
  return undefined;
}

function readToolInput(record: Record<string, unknown>): unknown {
  const direct = record.input ?? record.args ?? record.arguments;
  if (typeof direct === "string") return tryParseJson(direct);
  if (direct !== undefined) return direct;
  return typeof record.state === "object" && record.state !== null
    ? (record.state as Record<string, unknown>).input
    : undefined;
}

function createPayload(
  tool: MakeADemoOpenCodeToolName | undefined,
  input: unknown,
): MakeADemoOpenCodeToolPayload | undefined {
  if (typeof input !== "object" || input === null || tool === undefined)
    return undefined;
  if (
    tool === "makeademo_validate_preparation" &&
    typeof (input as { manifestPath?: unknown }).manifestPath === "string"
  ) {
    return {
      input: { manifestPath: (input as { manifestPath: string }).manifestPath },
      toolName: tool,
    };
  }
  if (
    (tool === "makeademo_dependency_request_install" ||
      tool === "makeademo_install_dependencies") &&
    typeof (input as { command?: unknown }).command === "string"
  ) {
    return {
      input: { command: (input as { command: string }).command },
      toolName: tool,
    };
  }
  return undefined;
}

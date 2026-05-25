interface SseMessage {
  readonly data: string;
}

export async function* parseSseDataMessages(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd).trim();
      buffer = buffer.slice(frameEnd + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data.length > 0 && data !== "[DONE]") {
        yield { data };
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function mapCodexResponsesEvent(raw: unknown) {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return null;
  }
  const codexEvent = raw as Record<string, unknown>;

  if (
    codexEvent.type === "response.output_text.delta" &&
    typeof codexEvent.delta === "string"
  ) {
    return { type: "text.delta" as const, delta: codexEvent.delta, raw };
  }
  if (
    (codexEvent.type === "response.reasoning_summary_text.delta" ||
      codexEvent.type === "response.reasoning_summary.delta") &&
    typeof codexEvent.delta === "string"
  ) {
    return {
      type: "reasoning_summary.delta" as const,
      delta: codexEvent.delta,
      raw,
    };
  }
  if (codexEvent.type === "response.output_item.done") {
    const outputItem = codexEvent.item as Record<string, unknown> | undefined;
    if (
      outputItem?.type === "function_call" &&
      typeof outputItem.name === "string"
    ) {
      return {
        type: "tool_call" as const,
        callId:
          typeof outputItem.call_id === "string" ? outputItem.call_id : "",
        name: outputItem.name,
        input: parseToolArguments(outputItem.arguments),
        raw,
      };
    }
  }
  if (codexEvent.type === "response.completed") {
    return { type: "completed" as const, raw };
  }
  if (codexEvent.type === "response.failed") {
    return {
      type: "failed" as const,
      error:
        typeof codexEvent.error === "string"
          ? codexEvent.error
          : "Response failed.",
      raw,
    };
  }
  return null;
}

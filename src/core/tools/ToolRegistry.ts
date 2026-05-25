import { AgentError } from "../errors/AgentError";
import type {
  Tool,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
} from "./Tool.interface";
import type { ToolRuntime } from "./ToolRuntime.interface";

/** Lists available tools and dispatches tool calls by name. */
export class ToolRegistry implements ToolRuntime {
  readonly #tools: ReadonlyMap<string, Tool>;

  constructor(tools: readonly Tool[]) {
    this.#tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  async list(): Promise<readonly ToolDefinition[]> {
    return [...this.#tools.values()]
      .map((tool) => ({
        ...tool.definition,
        inputSchema: canonicalizeRecord(tool.definition.inputSchema),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.#tools.get(request.name);
    if (!tool) {
      return {
        callId: request.callId,
        name: request.name,
        output: new AgentError({
          code: "tool_unavailable",
          message: `Tool '${request.name}' is not available in this agent.`,
        }).message,
        isError: true,
      };
    }
    return tool.execute(request);
  }
}

function canonicalizeRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeValue(child)]),
  );
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    return canonicalizeRecord(value as Readonly<Record<string, unknown>>);
  }
  return value;
}

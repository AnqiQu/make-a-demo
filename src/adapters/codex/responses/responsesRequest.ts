import type { ModelRequest } from "../../../core/model/ModelClient.interface";

export function buildCodexResponsesBody(
  request: ModelRequest,
): Record<string, unknown> {
  return {
    ...request.settings.responseOverrides,
    model: request.settings.model,
    instructions: request.prefix.systemPrompt,
    store: false,
    reasoning: request.settings.reasoning,
    input: request.messages.map((message) => {
      if (message.role === "tool_call") {
        return {
          type: "function_call",
          call_id: message.callId,
          name: message.name,
          arguments: JSON.stringify(message.input),
        };
      }
      if (message.role === "tool_result") {
        return {
          type: "function_call_output",
          call_id: message.callId,
          output: message.content,
        };
      }
      return {
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
      };
    }),
    tools: request.prefix.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
    stream: true,
  };
}

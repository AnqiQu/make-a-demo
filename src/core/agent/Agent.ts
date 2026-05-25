import type {
  AgentMemory,
  AssistantContentBlock,
} from "../memory/AgentMemory.interface";
import type { ModelClient } from "../model/ModelClient.interface";
import type { ToolCallRequest } from "../tools/Tool.interface";
import type { ToolRuntime } from "../tools/ToolRuntime.interface";
import type { AgentTurnEvent } from "./events";

/**
 * Runtime dependencies required by the Agent orchestrator.
 * Callers must provide dependencies for the same Agent runtime: Memory for the
 * target Conversations, a model client that accepts core model requests, and a
 * tool registry containing the tools exposed to that model client.
 */
export interface AgentDependencies {
  readonly memory: AgentMemory;
  readonly model: ModelClient;
  readonly tools: ToolRuntime;
}

/**
 * User input for one Agent turn.
 * `conversationId` must reference a Conversation visible to Memory, and
 * `userMessage` is recorded before any model request is started.
 */
export interface RunTurnInput {
  readonly conversationId: string;
  readonly userMessage: string;
}

interface AssistantPassCollector {
  // TODO: rename this
  readonly toolCalls: ToolCallRequest[];
}

/** Core agent orchestrator. It depends on Memory, model client, and tools. */
export class Agent {
  readonly #memory: AgentMemory;
  readonly #model: ModelClient;
  readonly #tools: ToolRuntime;

  constructor(dependencies: AgentDependencies) {
    this.#memory = dependencies.memory;
    this.#model = dependencies.model;
    this.#tools = dependencies.tools;
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentTurnEvent> {
    await this.#memory.record({
      type: "user_message",
      conversationId: input.conversationId,
      content: input.userMessage,
    });

    const firstPass: AssistantPassCollector = { toolCalls: [] };
    yield* this.#streamAndRecordAssistantPass(input.conversationId, firstPass);

    if (firstPass.toolCalls.length === 0) {
      yield { type: "completed" };
      return;
    }

    for (const toolCall of firstPass.toolCalls) {
      const toolResult = await this.#tools.execute(toolCall);
      await this.#memory.record({
        type: "tool_result",
        conversationId: input.conversationId,
        result: toolResult,
      });
      yield { type: "tool_result", ...toolResult };
    }

    yield* this.#streamAndRecordAssistantPass(input.conversationId, {
      toolCalls: [],
    });
    yield { type: "completed" };
  }

  async *#streamAndRecordAssistantPass(
    conversationId: string,
    passCollector: AssistantPassCollector,
  ): AsyncGenerator<AgentTurnEvent> {
    const context = await this.#memory.prepareTurn({ conversationId });
    const tools = await this.#tools.list();
    const assistantContentBlocks: AssistantContentBlock[] = [];

    for await (const event of this.#model.stream({
      prefix: {
        systemPrompt: context.systemPrompt,
        tools,
      },
      settings: context.settings,
      messages: context.messages,
    })) {
      switch (event.type) {
        case "reasoning_summary.delta":
          assistantContentBlocks.push({
            type: "reasoning_summary",
            text: event.delta,
          });
          yield { type: event.type, delta: event.delta };
          break;
        case "text.delta":
          assistantContentBlocks.push({ type: "text", text: event.delta });
          yield { type: event.type, delta: event.delta };
          break;
        case "tool_call": {
          const toolCall = {
            callId: event.callId,
            name: event.name,
            input: event.input,
          };
          passCollector.toolCalls.push(toolCall);
          assistantContentBlocks.push({ type: "tool_call", toolCall });
          yield { type: "tool_call", ...toolCall };
          break;
        }
        case "failed":
          assistantContentBlocks.push({
            type: "error",
            text: event.error,
            raw: event.raw,
          });
          break;
        case "completed":
          break;
      }
    }

    await this.#memory.record({
      type: "assistant_message",
      conversationId,
      content: assistantContentBlocks,
    });
  }
}

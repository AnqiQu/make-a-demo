import type {
  ConversationMessage,
  MessageContentBlock,
} from "../../../core/conversations/ConversationRecord.interface";
import type {
  ConversationContextReader,
  ConversationRecorder,
} from "../../../core/conversations/ConversationRuntime.interface";
import type {
  AgentMemory,
  AssistantContentBlock,
  MemoryRecord,
} from "../../../core/memory/AgentMemory.interface";
import type { ModelMessageInput } from "../../../core/model/ModelClient.interface";

/** Simple placeholder AgentMemory backed by one linear conversation timeline. */
export class SimpleLinearMemory implements AgentMemory {
  readonly #conversations: ConversationContextReader & ConversationRecorder;

  constructor(conversations: ConversationContextReader & ConversationRecorder) {
    this.#conversations = conversations;
  }

  async prepareTurn(input: { readonly conversationId: string }) {
    const context = await this.#conversations.buildContext(
      input.conversationId,
    );
    return {
      systemPrompt: context.systemPrompt,
      settings: context.settings,
      messages: context.messages.flatMap(toModelMessages),
    };
  }

  async record(record: MemoryRecord): Promise<void> {
    switch (record.type) {
      case "user_message":
        await this.#conversations.recordMessage(record.conversationId, {
          role: "user",
          content: [{ type: "text", text: record.content }],
        });
        return;
      case "assistant_message":
        await this.#conversations.recordMessage(record.conversationId, {
          role: "assistant",
          content: record.content.map(toConversationContentBlock),
          raw: record.raw,
        });
        return;
      case "tool_result":
        await this.#conversations.recordMessage(record.conversationId, {
          role: "tool_result",
          content: [{ type: "text", text: record.result.output }],
          raw: record.result,
        });
        return;
      case "settings_changed":
        await this.#conversations.updateSettings(
          record.conversationId,
          record.settings,
        );
        return;
    }
  }
}

function toModelMessages(
  message: ConversationMessage,
): readonly ModelMessageInput[] {
  if (message.role === "assistant") {
    return toAssistantModelMessages(message);
  }

  const callId =
    message.role === "tool_result" &&
    typeof message.raw === "object" &&
    message.raw &&
    "callId" in message.raw
      ? String(message.raw.callId)
      : undefined;

  if (message.role === "tool_result" && callId) {
    return [{ role: message.role, content: textContent(message), callId }];
  }
  if (message.role === "tool_result") {
    return [{ role: message.role, content: textContent(message), callId: "" }];
  }

  return [
    {
      role: message.role,
      content: textContent(message),
    },
  ];
}

function toAssistantModelMessages(
  message: ConversationMessage,
): readonly ModelMessageInput[] {
  const messages: ModelMessageInput[] = [];
  const text = textContent(message);
  if (text.length > 0) {
    messages.push({ role: "assistant", content: text });
  }

  for (const block of message.content) {
    if (block.type !== "tool_call") {
      continue;
    }
    const toolCall = parseToolCall(block.raw);
    if (toolCall) {
      messages.push(toolCall);
    }
  }

  return messages;
}

function textContent(message: ConversationMessage): string {
  return message.content
    .filter((block) => block.type !== "reasoning_summary")
    .filter((block) => block.type !== "tool_call")
    .map((block) => block.text ?? JSON.stringify(block.raw))
    .join("");
}

function parseToolCall(raw: unknown): ModelMessageInput | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const toolCall = raw as Record<string, unknown>;
  if (
    typeof toolCall.callId !== "string" ||
    typeof toolCall.name !== "string"
  ) {
    return null;
  }
  return {
    role: "tool_call",
    callId: toolCall.callId,
    name: toolCall.name,
    input: toolCall.input,
  };
}

function toConversationContentBlock(
  block: AssistantContentBlock,
): MessageContentBlock {
  if (block.type === "tool_call") {
    return { type: "tool_call", raw: block.toolCall };
  }
  if (block.type === "error") {
    return { type: "error", text: block.text, raw: block.raw };
  }
  return block;
}

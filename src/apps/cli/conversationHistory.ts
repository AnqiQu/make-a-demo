import type {
  CliConversationMessage,
  CliConversations,
} from "./CliRuntime.interface";

/** Renders previous messages for a resumed conversation. */
export async function renderConversationHistory(
  conversations: Pick<CliConversations, "buildContext">,
  conversationId: string,
): Promise<string> {
  const conversationContext = await conversations.buildContext(conversationId);
  if (conversationContext.messages.length === 0) {
    return "";
  }

  return `\nPrevious conversation:\n${conversationContext.messages.map(renderMessage).join("\n\n")}\n\n`;
}

function renderMessage(message: CliConversationMessage): string {
  const label =
    message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? "Assistant"
        : "Tool";
  const body = renderContentBlocks(message.content);
  return `${label}:\n${body}`;
}

function renderContentBlocks(
  content: CliConversationMessage["content"],
): string {
  const lines: string[] = [];
  let textBuffer = "";

  for (const block of content) {
    if (block.type === "text") {
      textBuffer += block.text ?? formatRaw(block.raw);
      continue;
    }

    if (textBuffer.length > 0) {
      lines.push(textBuffer);
      textBuffer = "";
    }

    const renderedContentBlock = renderContentBlock(block);
    if (renderedContentBlock.length > 0) {
      lines.push(renderedContentBlock);
    }
  }

  if (textBuffer.length > 0) {
    lines.push(textBuffer);
  }

  return lines.join("\n");
}

function renderContentBlock(
  block: CliConversationMessage["content"][number],
): string {
  if (block.type === "reasoning_summary") {
    return `[reasoning] ${block.text ?? ""}`;
  }
  if (block.type === "tool_call") {
    return `[tool call] ${formatRaw(block.raw)}`;
  }
  if (block.type === "error") {
    return `[error] ${block.text ?? formatRaw(block.raw)}`;
  }
  return block.text ?? formatRaw(block.raw);
}

function formatRaw(raw: unknown): string {
  if (raw === undefined) {
    return "";
  }
  if (typeof raw === "string") {
    return raw;
  }
  return JSON.stringify(raw);
}

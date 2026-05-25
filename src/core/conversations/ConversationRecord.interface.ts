import type { ResponseSettings } from "../settings/ResponseSettings.interface";

interface ConversationHeader {
  readonly type: "conversation";
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd: string;
  readonly title?: string | undefined;
  readonly systemPrompt: string;
  readonly settings: ResponseSettings;
}

/**
 * Atomic content stored inside a Conversation message.
 * Producers must use `text` for replayable text and `raw` for provider/tool
 * details that need to survive persistence without becoming ordinary text.
 */
export interface MessageContentBlock {
  readonly type: "text" | "reasoning_summary" | "tool_call" | "error";
  readonly text?: string;
  readonly raw?: unknown;
}

type MessageRole = "user" | "assistant" | "tool_result";

/**
 * One persisted message in a Conversation timeline.
 * Messages must keep their role-specific meaning: user and assistant content is
 * replayed to the model, while tool results must be correlated through raw tool
 * result data when possible.
 */
export interface ConversationMessage {
  readonly role: MessageRole;
  readonly content: readonly MessageContentBlock[];
  readonly raw?: unknown;
}

/**
 * A user-initiated Conversation turn and the Agent messages produced for it.
 * Stores must preserve message order, and open turns must not be followed by a
 * new user turn until the Agent produces a final assistant message.
 */
export interface ConversationTurn {
  readonly id: string;
  readonly timestamp: string;
  readonly status: "open" | "completed" | "failed" | "cancelled";
  readonly messages: readonly ConversationMessage[];
}

/**
 * Complete persisted Conversation state.
 * Implementations must persist the header and turns atomically enough that a
 * later read can rebuild the same replay context and lifecycle status.
 */
export interface ConversationRecord {
  readonly header: ConversationHeader;
  readonly turns: readonly ConversationTurn[];
}

/**
 * Lightweight Conversation metadata for selection and resume flows.
 * Stores must return enough information to identify and activate the
 * Conversation without reading every message into the caller.
 */
export interface ConversationSummary {
  readonly id: string;
  readonly filePath: string;
  readonly timestamp: string;
  readonly updatedAt: string;
  readonly title?: string | undefined;
}

/**
 * Replay context prepared from a Conversation record.
 * Builders must include the active system prompt, active Settings, and messages
 * in persisted turn order without inventing or dropping user-visible history.
 */
export interface ConversationContext {
  readonly conversationId: string;
  readonly systemPrompt: string;
  readonly settings: ResponseSettings;
  readonly messages: readonly ConversationMessage[];
}

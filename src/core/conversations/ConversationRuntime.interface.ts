import type { ResponseSettings } from "../settings/ResponseSettings.interface";
import type {
  ConversationContext,
  ConversationMessage,
  ConversationSummary,
} from "./ConversationRecord.interface";

/** Agent defaults needed to create or activate a Conversation. */
export interface CreateConversationInput extends ResponseSettings {
  readonly systemPrompt: string;
}

/**
 * Conversation identity returned after creation or activation.
 * Implementations must return an `id` that can be used with Conversation seams
 * and a `filePath` that points to the concrete persisted record when present.
 */
export interface CreatedConversation {
  readonly id: string;
  readonly filePath: string;
}

/** Reads replay context for Agent Memory without exposing lifecycle logic. */
export interface ConversationContextReader {
  /** Builds the active replay context for a Conversation. */
  readonly buildContext: (
    conversationId: string,
  ) => Promise<ConversationContext>;
}

/** Records Conversation events without exposing activation or listing logic. */
export interface ConversationRecorder {
  /** Appends a message while preserving turn lifecycle invariants. */
  readonly recordMessage: (
    conversationId: string,
    message: ConversationMessage,
  ) => Promise<ConversationMessage>;

  /** Replaces active Settings for future turns in a Conversation. */
  readonly updateSettings: (
    conversationId: string,
    settings: ResponseSettings,
  ) => Promise<void>;
}

/** User-facing Conversation lifecycle operations for app runtimes. */
export interface ConversationLifecycle {
  /** Creates a new Conversation using current Agent defaults. */
  readonly createConversation: (
    input: CreateConversationInput,
  ) => Promise<CreatedConversation>;

  /** Activates the most recently updated Conversation or creates one. */
  readonly resumeMostRecentOrCreate: (
    input: CreateConversationInput,
  ) => Promise<CreatedConversation>;

  /** Makes an existing Conversation active using current Agent defaults. */
  readonly activateConversation: (
    conversationId: string,
    input: CreateConversationInput,
  ) => Promise<CreatedConversation>;

  /** Lists known Conversations for selection and resume flows. */
  readonly listConversations: () => Promise<readonly ConversationSummary[]>;
}

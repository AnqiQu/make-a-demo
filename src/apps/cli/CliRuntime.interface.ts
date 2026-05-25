import type { AgentTurnEvent } from "../../core/agent/events";
import type { AgentConfig } from "../../core/config/AgentConfig.schema";
import type {
  ConversationMessage,
  ConversationSummary,
} from "../../core/conversations/ConversationRecord.interface";
import type {
  ConversationContextReader,
  ConversationLifecycle,
  CreatedConversation,
} from "../../core/conversations/ConversationRuntime.interface";
import type { ResponseSettings } from "../../core/settings/ResponseSettings.interface";

export type CliAgentConfig = AgentConfig;
export type CliConversationMessage = ConversationMessage;
export type CliConversationSummary = ConversationSummary;
export type CliCreatedConversation = CreatedConversation;
export type CliResponseSettings = ResponseSettings;
export type CliTurnEvent = AgentTurnEvent;

/** Conversation operations exposed to the CLI app. */
export interface CliConversations
  extends ConversationLifecycle,
    ConversationContextReader {}

/** Agent turn runner exposed to the CLI app. */
interface CliAgent {
  /** Runs one user turn and streams normalized events for rendering. */
  readonly runTurn: (input: {
    readonly conversationId: string;
    readonly userMessage: string;
  }) => AsyncGenerator<CliTurnEvent>;
}

/** Runtime assembled for the CLI app by the composition module. */
export interface CliRuntime {
  readonly config: CliAgentConfig;
  readonly conversations: CliConversations;
  readonly agent: CliAgent;
  readonly updateConversationSettings: (input: {
    readonly conversationId: string;
    readonly update: (settings: CliResponseSettings) => CliResponseSettings;
  }) => Promise<void>;
}

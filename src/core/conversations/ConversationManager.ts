import { randomUUID } from "node:crypto";

import { AgentError } from "../errors/AgentError";
import type { ResponseSettings } from "../settings/ResponseSettings.interface";
import type {
  ConversationContext,
  ConversationMessage,
  ConversationRecord,
  ConversationTurn,
} from "./ConversationRecord.interface";
import { CONVERSATION_SCHEMA_VERSION } from "./ConversationRecord.schema";
import type {
  ConversationContextReader,
  ConversationLifecycle,
  ConversationRecorder,
  CreateConversationInput,
  CreatedConversation,
} from "./ConversationRuntime.interface";
import type { ConversationStore } from "./ConversationStore.interface";
import { createTurnId, nowIso } from "./ids";

interface ConversationManagerDependencies {
  readonly cwd: string;
  readonly store: ConversationStore;
}

/** Manages linear conversations and builds replay context. */
export class ConversationManager
  implements
    ConversationLifecycle,
    ConversationContextReader,
    ConversationRecorder
{
  readonly #cwd: string;
  readonly #store: ConversationStore;

  constructor(dependencies: ConversationManagerDependencies) {
    this.#cwd = dependencies.cwd;
    this.#store = dependencies.store;
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<CreatedConversation> {
    const conversationId = randomUUID();
    const timestamp = nowIso();
    const conversationRecord: ConversationRecord = {
      header: {
        type: "conversation",
        version: CONVERSATION_SCHEMA_VERSION,
        id: conversationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        cwd: this.#cwd,
        systemPrompt: input.systemPrompt,
        settings: {
          model: input.model,
          reasoning: input.reasoning,
          responseOverrides: input.responseOverrides,
        },
      },
      turns: [],
    };
    const filePath = await this.#store.create(conversationRecord);
    return { id: conversationId, filePath };
  }

  async resumeMostRecentOrCreate(
    input: CreateConversationInput,
  ): Promise<CreatedConversation> {
    const [recent] = await this.#store.list();
    if (recent) {
      return this.activateConversation(recent.id, input);
    }
    return this.createConversation(input);
  }

  async activateConversation(
    conversationId: string,
    input: CreateConversationInput,
  ): Promise<CreatedConversation> {
    const conversationRecord = await this.#store.read(conversationId);
    await this.#store.write({
      ...conversationRecord,
      header: {
        ...conversationRecord.header,
        updatedAt: nowIso(),
        systemPrompt: input.systemPrompt,
        settings: {
          model: input.model,
          reasoning: input.reasoning,
          responseOverrides: input.responseOverrides,
        },
      },
    });

    const activated = (await this.#store.list()).find(
      (conversation) => conversation.id === conversationId,
    );
    if (!activated) {
      throw new AgentError({
        code: "conversation_invalid",
        message: `Conversation '${conversationId}' is not available.`,
      });
    }
    return { id: activated.id, filePath: activated.filePath };
  }

  async recordMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<ConversationMessage> {
    const conversationRecord = await this.#store.read(conversationId);
    const turns = [...conversationRecord.turns];
    const latestTurn = turns.at(-1);

    if (message.role === "user") {
      this.#recordUserMessage(turns, latestTurn, message);
    } else {
      this.#recordAgentMessage(turns, latestTurn, message);
    }

    await this.#store.write({
      header: { ...conversationRecord.header, updatedAt: nowIso() },
      turns,
    });
    return message;
  }

  #recordUserMessage(
    turns: ConversationTurn[],
    latestTurn: ConversationTurn | undefined,
    message: ConversationMessage,
  ) {
    if (latestTurn?.status === "open") {
      throw new AgentError({
        code: "conversation_invalid",
        message: "Cannot start a new turn while another turn is open.",
      });
    }

    turns.push({
      id: createTurnId(),
      timestamp: nowIso(),
      status: "open",
      messages: [message],
    });
  }

  #recordAgentMessage(
    turns: ConversationTurn[],
    latestTurn: ConversationTurn | undefined,
    message: ConversationMessage,
  ) {
    if (latestTurn?.status !== "open") {
      throw new AgentError({
        code: "conversation_invalid",
        message: "Cannot append an agent message without an open turn.",
      });
    }

    turns[turns.length - 1] = {
      ...latestTurn,
      status: messageCompletesTurn(message) ? "completed" : latestTurn.status,
      messages: [...latestTurn.messages, message],
    };
  }

  async updateSettings(
    conversationId: string,
    settings: ResponseSettings,
  ): Promise<void> {
    const conversationRecord = await this.#store.read(conversationId);
    await this.#store.write({
      ...conversationRecord,
      header: { ...conversationRecord.header, updatedAt: nowIso(), settings },
    });
  }

  async undoLatestTurn(conversationId: string): Promise<void> {
    const conversationRecord = await this.#store.read(conversationId);
    await this.#store.write({
      header: { ...conversationRecord.header, updatedAt: nowIso() },
      turns: conversationRecord.turns.slice(0, -1),
    });
  }

  async buildContext(conversationId: string): Promise<ConversationContext> {
    const conversationRecord = await this.#store.read(conversationId);
    return {
      conversationId,
      systemPrompt: conversationRecord.header.systemPrompt,
      settings: conversationRecord.header.settings,
      messages: conversationRecord.turns.flatMap((turn) => turn.messages),
    };
  }

  async listConversations() {
    return this.#store.list();
  }
}

function messageCompletesTurn(message: ConversationMessage) {
  return (
    message.role === "assistant" &&
    !message.content.some((block) => block.type === "tool_call")
  );
}

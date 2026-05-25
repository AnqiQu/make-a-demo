import type { AgentMemory } from "../../core/memory/AgentMemory.interface";
import type { CliRuntime } from "./CliRuntime.interface";

export function createSettingsUpdater(
  memory: AgentMemory,
): CliRuntime["updateConversationSettings"] {
  return async (input) => {
    const preparedTurn = await memory.prepareTurn({
      conversationId: input.conversationId,
    });
    await memory.record({
      type: "settings_changed",
      conversationId: input.conversationId,
      settings: input.update(preparedTurn.settings),
    });
  };
}

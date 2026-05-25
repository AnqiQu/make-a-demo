import type { ReasoningSettings } from "../config/AgentConfig.schema";

/**
 * Model-facing Settings active for a Conversation.
 * Callers must treat these values as the controls for future model requests;
 * provider-specific `responseOverrides` must be preserved without core
 * interpreting unknown keys.
 */
export interface ResponseSettings {
  readonly model: string;
  readonly reasoning?: ReasoningSettings | undefined;
  readonly responseOverrides: Readonly<Record<string, unknown>>;
}

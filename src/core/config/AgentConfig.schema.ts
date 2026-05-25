import { z } from "zod";

const reasoningSettingsSchema = z
  .object({
    effort: z.string().optional(),
    summary: z.string().optional(),
  })
  .catchall(z.unknown());

/** Runtime validator and defaulting contract for Agent config files. */
export const agentConfigSchema = z.object({
  systemPrompt: z.string().min(1),
  model: z.string().min(1),
  reasoning: reasoningSettingsSchema.optional(),
  responseOverrides: z.record(z.string(), z.unknown()).default({}),
});

export type ReasoningSettings = z.infer<typeof reasoningSettingsSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

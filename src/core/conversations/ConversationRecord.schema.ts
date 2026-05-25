import { z } from "zod";

export const CONVERSATION_SCHEMA_VERSION = 1;

const responseSettingsSchema = z.object({
  model: z.string().min(1),
  reasoning: z
    .object({
      effort: z.enum(["minimal", "low", "medium", "high"]),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
    })
    .optional(),
  responseOverrides: z.record(z.string(), z.unknown()),
});

/**
 * Runtime validator for persisted Conversation headers.
 * Callers must use this when reading external Conversation records before
 * treating them as core Conversation data contracts.
 */
export const conversationHeaderSchema = z.object({
  type: z.literal("conversation"),
  version: z.literal(CONVERSATION_SCHEMA_VERSION),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  cwd: z.string(),
  title: z.string().optional(),
  systemPrompt: z.string(),
  settings: responseSettingsSchema,
});

/**
 * Runtime validator for persisted Conversation turns.
 * Callers must validate external turn records before appending or replaying
 * them through Conversation core interfaces.
 */
export const conversationTurnSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  status: z.enum(["open", "completed", "failed", "cancelled"]),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "tool_result"]),
      content: z.array(
        z.object({
          type: z.enum(["text", "reasoning_summary", "tool_call", "error"]),
          text: z.string().optional(),
          raw: z.unknown().optional(),
        }),
      ),
      raw: z.unknown().optional(),
    }),
  ),
});

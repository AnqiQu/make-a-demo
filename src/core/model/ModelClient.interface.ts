import type { ResponseSettings } from "../settings/ResponseSettings.interface";
import type { ToolDefinition } from "../tools/Tool.interface";

export type ModelMessageInput =
  | {
      readonly role: "user" | "assistant";
      readonly content: string;
    }
  | {
      readonly role: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly role: "tool_result";
      readonly callId: string;
      readonly content: string;
    };

interface ModelRequestPrefix {
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
}

/**
 * Complete model request assembled by core for one model pass.
 * Implementations must preserve the semantic split between stable `prefix`
 * content and replay `messages` so adapters can optimize provider requests
 * without changing Agent behavior.
 */
export interface ModelRequest {
  readonly prefix: ModelRequestPrefix;
  readonly settings: ResponseSettings;
  readonly messages: readonly ModelMessageInput[];
}

export type ModelStreamEvent =
  | {
      readonly type: "text.delta";
      readonly delta: string;
      readonly raw: unknown;
    }
  | {
      readonly type: "reasoning_summary.delta";
      readonly delta: string;
      readonly raw: unknown;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
      readonly raw: unknown;
    }
  | { readonly type: "completed"; readonly raw: unknown }
  | { readonly type: "failed"; readonly error: string; readonly raw: unknown };

/**
 * Streams normalized model response events for a provider.
 * Implementations must translate `ModelRequest` into the provider protocol,
 * yield events in provider/model order, preserve tool call identifiers, and
 * either yield a terminal event or throw a transport/protocol error.
 */
export interface ModelClient {
  /**
   * Starts a response for the supplied context and tools.
   * Events must be yielded in model order with one terminal event.
   */
  readonly stream: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;
}

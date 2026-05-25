import type {
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
} from "./Tool.interface";

/**
 * Runtime tool catalog and dispatcher used by the Agent.
 * Implementations must return stable tool definitions for model requests and
 * preserve tool call identifiers when dispatching model-requested tools.
 */
export interface ToolRuntime {
  /** Returns model-visible tool definitions in stable order. */
  readonly list: () => Promise<readonly ToolDefinition[]>;

  /** Executes a model-requested tool call and preserves request correlation. */
  readonly execute: (request: ToolCallRequest) => Promise<ToolCallResult>;
}

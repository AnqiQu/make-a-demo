/**
 * Model-visible description of a tool.
 * Implementations must provide a stable name, human-readable description, and a
 * JSON-schema-like input schema that can be serialized through provider tool
 * protocols without requiring adapter-specific knowledge in core.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Request to execute one model-generated tool call.
 * The `callId` must be preserved in the result so the model can correlate tool
 * output with the original provider tool call.
 */
export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Result returned from a tool execution.
 * Implementations must return the original `callId` and tool `name`; failures
 * that are safe to show the model should set `isError` instead of throwing.
 */
export interface ToolCallResult {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly isError: boolean;
}

/**
 * One executable capability exposed to the model.
 * Implementations must keep `definition.name` stable for dispatch and validate
 * their own input before performing side effects.
 */
export interface Tool {
  /**
   * Describes the tool and its expected input.
   */
  readonly definition: ToolDefinition;

  /**
   * Executes one tool call.
   * The returned `callId` must match the request.
   */
  readonly execute: (request: ToolCallRequest) => Promise<ToolCallResult>;
}

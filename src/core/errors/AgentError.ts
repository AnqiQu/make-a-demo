export type AgentErrorCode =
  | "config_invalid"
  | "config_missing"
  | "conversation_invalid"
  | "conversation_missing"
  | "auth_missing"
  | "auth_failed"
  | "transport_failed"
  | "tool_unavailable";

/** Error type used across public APIs so callers can branch on stable codes. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(args: {
    code: AgentErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "AgentError";
    this.code = args.code;
    this.retryable = args.retryable ?? false;
    this.cause = args.cause;
  }
}

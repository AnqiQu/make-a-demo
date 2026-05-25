export type AgentTurnEvent =
  | { readonly type: "reasoning_summary.delta"; readonly delta: string }
  | { readonly type: "text.delta"; readonly delta: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: "completed" };

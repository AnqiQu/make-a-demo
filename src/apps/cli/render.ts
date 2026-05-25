import type { CliTurnEvent } from "./CliRuntime.interface";

export class CliTurnRenderer {
  #inlineBlock: "reasoning" | "text" | null = null;

  /** Renders streaming text inline while keeping metadata events readable. */
  render(event: CliTurnEvent): string {
    switch (event.type) {
      case "reasoning_summary.delta":
        return this.#renderInlineDelta("reasoning", event.delta);
      case "text.delta":
        return this.#renderInlineDelta("text", event.delta);
      case "tool_call":
        return `${this.#breakInlineBlock()}[tool call] ${event.name} ${event.callId}\n`;
      case "tool_result":
        return `${this.#breakInlineBlock()}[tool result] ${event.isError ? "error" : "ok"}: ${event.output}\n`;
      case "completed":
        return this.#breakInlineBlock();
    }
  }

  #renderInlineDelta(block: "reasoning" | "text", delta: string): string {
    if (this.#inlineBlock === block) {
      return delta;
    }

    const prefix = block === "reasoning" ? "[reasoning] " : "";
    const leadingBreak = this.#breakInlineBlock();
    this.#inlineBlock = block;
    return `${leadingBreak}${prefix}${delta}`;
  }

  #breakInlineBlock(): string {
    if (!this.#inlineBlock) {
      return "";
    }
    this.#inlineBlock = null;
    return "\n";
  }
}

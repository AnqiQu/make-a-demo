import { readRepairAdvice } from "./repair-advice.schema";

describe("readRepairAdvice", () => {
  it("accepts the five bounded repair advice kinds", () => {
    expect(
      [
        { kind: "continue" },
        {
          hint: "Build the workspace dependency graph.",
          kind: "escalate-hint",
        },
        { directive: "Use the root graph build.", kind: "directive" },
        { kind: "stop", reason: "The sandbox has no remaining disk." },
        { kind: "spend-bonus-round" },
      ].map(readRepairAdvice),
    ).toEqual([
      { kind: "continue" },
      { hint: "Build the workspace dependency graph.", kind: "escalate-hint" },
      { directive: "Use the root graph build.", kind: "directive" },
      { kind: "stop", reason: "The sandbox has no remaining disk." },
      { kind: "spend-bonus-round" },
    ]);
  });

  it("rejects missing prose, unknown kinds, and fields outside the discriminant", () => {
    expect(() => readRepairAdvice({ kind: "directive" })).toThrow(
      "RepairAdvice.directive must be a non-empty string",
    );
    expect(() => readRepairAdvice({ kind: "rewrite-workspace" })).toThrow(
      "RepairAdvice.kind must be one of",
    );
    expect(() =>
      readRepairAdvice({ hint: "Extra authority", kind: "continue" }),
    ).toThrow("RepairAdvice.hint is not allowed for this kind");
  });
});

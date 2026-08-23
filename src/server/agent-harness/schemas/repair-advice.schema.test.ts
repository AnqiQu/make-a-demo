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
        {
          kind: "spend-bonus-round",
          reason: "Round 5 moved the failure; one more converges.",
        },
      ].map(readRepairAdvice),
    ).toEqual([
      { kind: "continue" },
      { hint: "Build the workspace dependency graph.", kind: "escalate-hint" },
      { directive: "Use the root graph build.", kind: "directive" },
      { kind: "stop", reason: "The sandbox has no remaining disk." },
      {
        kind: "spend-bonus-round",
        reason: "Round 5 moved the failure; one more converges.",
      },
    ]);
  });

  it("requires a reason on bonus grants so the ledger can answer why", () => {
    // Wave-16/17 audits: {"kind":"spend-bonus-round"} artifacts left the
    // ledger unable to say why a run earned an extra round.
    expect(() => readRepairAdvice({ kind: "spend-bonus-round" })).toThrow(
      "RepairAdvice.reason must be a non-empty string",
    );
  });

  it("carries an optional bounded memo on every kind for cross-run memory", () => {
    expect(
      readRepairAdvice({
        kind: "continue",
        memo: "This repo's seed path needs redis disabled first.",
      }),
    ).toEqual({
      kind: "continue",
      memo: "This repo's seed path needs redis disabled first.",
    });
    expect(
      readRepairAdvice({
        directive: "Seed through the demo gate.",
        kind: "directive",
        memo: "  Auth seeding must cover server and client checks.  ",
      }),
    ).toEqual({
      directive: "Seed through the demo gate.",
      kind: "directive",
      memo: "Auth seeding must cover server and client checks.",
    });
    const oversized = readRepairAdvice({
      kind: "continue",
      memo: "x".repeat(5000),
    });
    expect(oversized.memo?.length).toBe(1200);
    expect(() => readRepairAdvice({ kind: "continue", memo: 42 })).toThrow(
      "RepairAdvice.memo must be a non-empty string",
    );
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

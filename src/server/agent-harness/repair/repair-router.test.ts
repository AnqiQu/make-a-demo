import { describe, expect, it } from "vitest";
import { classifyRepairRoute, readRepairBudgetDecision } from "./repair-router";

describe("RepairRouter", () => {
  it("routes script-only failures to ScriptRepair", () => {
    for (const classification of [
      "script contract failure",
      "locator failure",
      "assertion failure",
      "timing/state failure",
      "Capture SDK violation",
      "script modified app source",
    ]) {
      expect(
        classifyRepairRoute({ failureClassification: classification }),
      ).toBe("script-repair");
    }
  });

  it("routes preparation failures to RepoPreparationRepair", () => {
    for (const classification of [
      "install failure",
      "build failure",
      "start failure",
      "missing env",
      "external network required",
      "auth wall",
      "feature auth barrier",
      "app route crashes",
      "empty/unmeaningful app state",
      "prepared feature not observable",
      "requested feature not observable",
    ]) {
      expect(
        classifyRepairRoute({ failureClassification: classification }),
      ).toBe("repo-preparation-repair");
    }
  });

  it("stops repair attempts when a typed budget is exhausted", () => {
    expect(
      readRepairBudgetDecision({
        attempted: 1,
        limit: 2,
        route: "script-repair",
      }),
    ).toEqual({ nextAttempt: 2, status: "allowed" });

    expect(
      readRepairBudgetDecision({
        attempted: 2,
        limit: 2,
        route: "script-repair",
      }),
    ).toEqual({
      reason: "script-repair retry budget exhausted after 2 attempts",
      status: "exhausted",
    });
  });
});

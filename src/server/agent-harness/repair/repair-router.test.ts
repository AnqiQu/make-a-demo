import { describe, expect, it } from "vitest";
import {
  classifyRepairRoute,
  isDependencyRepairFailure,
  readRepairBudgetDecision,
} from "./repair-router";

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
      "listen failure",
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

  it("does not restrict a listen failure to dependency-metadata repairs", () => {
    expect(isDependencyRepairFailure("listen failure")).toBe(false);
    expect(isDependencyRepairFailure("install failure")).toBe(true);
    expect(isDependencyRepairFailure("missing dependency")).toBe(true);
  });

  it("fails a sandbox capacity failure instead of routing it to any repair agent", () => {
    expect(
      classifyRepairRoute({
        failureClassification: "sandbox capacity exceeded",
        logsSummary:
          "The sandbox killed the prepared app: the cgroup reports 2 OOM kill(s).",
      }),
    ).toBe("fail");
  });

  it("fails an unrecognized classification instead of keyword-routing its logs", () => {
    expect(
      classifyRepairRoute({
        failureClassification: "flow lock",
        logsSummary: "assertion failed while locating the dashboard",
      }),
    ).toBe("fail");
    expect(
      classifyRepairRoute({
        failureClassification: "transient infrastructure failure",
      }),
    ).toBe("fail");
  });

  it("keyword-routes only the first summary line when no classification exists", () => {
    expect(
      classifyRepairRoute({
        logsSummary:
          "Start command exited with code 1\nAssertionError: expected the server to respond",
      }),
    ).toBe("repo-preparation-repair");
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

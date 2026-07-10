export type RepairRoute = "fail" | "repo-preparation-repair" | "script-repair";

const scriptFailureClassifications = new Set([
  "assertion failure",
  "Capture SDK violation",
  "locator failure",
  "script contract failure",
  "script modified app source",
  "timing/state failure",
]);

const preparationFailureClassifications = new Set([
  "app route crashes",
  "app route not discoverable",
  "auth wall",
  "browser console/page error",
  "build failure",
  "empty/unmeaningful app state",
  "external network attempted",
  "external network required",
  "install failure",
  "missing env",
  "start failure",
]);

export function classifyRepairRoute(input: {
  failureClassification?: string;
  logsSummary?: string;
}): RepairRoute {
  const classification = input.failureClassification?.trim();
  if (classification !== undefined) {
    if (scriptFailureClassifications.has(classification)) {
      return "script-repair";
    }
    if (preparationFailureClassifications.has(classification)) {
      return "repo-preparation-repair";
    }
    if (
      classification === "unsafe repo" ||
      classification === "unsupported repo" ||
      classification === "harness/internal failure" ||
      classification === "transient infrastructure failure"
    ) {
      return "fail";
    }
  }

  const summary = input.logsSummary ?? "";
  if (/locator|assertion|contract|capture sdk/i.test(summary)) {
    return "script-repair";
  }
  if (
    /auth|network|required env|start|build|install|route crashed/i.test(summary)
  ) {
    return "repo-preparation-repair";
  }

  return "fail";
}

export function readRepairBudgetDecision(input: {
  attempted: number;
  limit: number;
  route: Exclude<RepairRoute, "fail">;
}):
  | { nextAttempt: number; status: "allowed" }
  | { reason: string; status: "exhausted" } {
  if (input.attempted >= input.limit) {
    return {
      reason: `${input.route} retry budget exhausted after ${input.limit} attempts`,
      status: "exhausted",
    };
  }

  return {
    nextAttempt: input.attempted + 1,
    status: "allowed",
  };
}

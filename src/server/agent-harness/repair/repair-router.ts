export type RepairRoute = "fail" | "repo-preparation-repair" | "script-repair";

const dependencyFailureClassifications = new Set([
  "install failure",
  "missing dependency",
]);

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
  "feature auth barrier",
  "install failure",
  "listen failure",
  "missing dependency",
  "missing env",
  "prepared feature not observable",
  "product fidelity violation",
  "requested feature not observable",
  "render timeout",
  "runtime crash",
  "start failure",
]);

export function classifyRepairRoute(input: {
  failureClassification?: string;
  logsSummary?: string;
}): RepairRoute {
  const classification = input.failureClassification?.trim();
  if (classification !== undefined && classification.length > 0) {
    if (scriptFailureClassifications.has(classification)) {
      return "script-repair";
    }
    if (preparationFailureClassifications.has(classification)) {
      return "repo-preparation-repair";
    }
    // Unrecognized classifications fail with their own reason; keyword
    // matching against arbitrary logs must never override a classifier.
    return "fail";
  }

  const summary = input.logsSummary?.split("\n", 1)[0] ?? "";
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

/** Returns whether a preparation failure should permit dependency metadata edits only. */
export function isDependencyRepairFailure(
  failureClassification: string | undefined,
): boolean {
  return dependencyFailureClassifications.has(
    failureClassification?.trim() ?? "",
  );
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

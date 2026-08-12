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
  "app server error",
  "auth wall",
  "browser console/page error",
  "build failure",
  "empty/unmeaningful app state",
  "external network attempted",
  "external network required",
  "feature auth barrier",
  "install failure",
  "lifecycle timeout",
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

/**
 * Formats the one exhaustion message every repair budget reports. The
 * optional label names which of a route's budgets ran out (for example
 * `global` or `repeated failure`); without it the message describes the
 * route's plain retry budget.
 */
export function repairBudgetExhaustedMessage(input: {
  attempts: number;
  budgetLabel?: string;
  route: Exclude<RepairRoute, "fail">;
}): string {
  const label = input.budgetLabel === undefined ? "" : `${input.budgetLabel} `;
  return `${input.route} ${label}retry budget exhausted after ${input.attempts} attempts`;
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
      reason: repairBudgetExhaustedMessage({
        attempts: input.limit,
        route: input.route,
      }),
      status: "exhausted",
    };
  }

  return {
    nextAttempt: input.attempted + 1,
    status: "allowed",
  };
}

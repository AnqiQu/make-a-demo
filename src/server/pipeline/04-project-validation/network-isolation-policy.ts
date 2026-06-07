export type NetworkAttempt = {
  direction: "inbound" | "outbound";
  host: string;
  phase: "install" | "runtime";
};

export function findRuntimeBoundaryViolations(
  attempts: readonly NetworkAttempt[],
): NetworkAttempt[] {
  return attempts.filter((attempt) => attempt.phase === "runtime");
}

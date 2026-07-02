import type { NetworkAttempt } from "./network-isolation-policy";

/**
 * Stable machine-readable validation failure categories. Producers must only set
 * this when the failure comes from MakeADemo infrastructure rather than app
 * behavior so callers can choose retry/fail-fast policy without parsing text.
 */
type ProjectValidationFailureKind = "submitted-code-workspace-sync-failed";

export type ProjectValidationResult = {
  blockedNetworkAttempts: NetworkAttempt[];
  browserUrl?: string;
  failureKind?: ProjectValidationFailureKind;
  failureReason?: string;
  logs: string[];
  screenshotArtifactId?: string;
  status: "succeeded" | "failed";
  warnings: string[];
};

import type { NetworkAttempt } from "./network-isolation-policy";

export type ProjectValidationResult = {
  blockedNetworkAttempts: NetworkAttempt[];
  failureReason?: string;
  logs: string[];
  screenshotArtifactId?: string;
  status: "succeeded" | "failed";
  warnings: string[];
};

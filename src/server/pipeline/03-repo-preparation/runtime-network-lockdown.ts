export type RuntimeNetworkAttempt = {
  direction: "inbound" | "outbound";
  host: string;
  method?: string;
  source?: "browser" | "server" | "unknown";
  url?: string;
};

export type RuntimeNetworkLockdownResult =
  | {
      blockedAttempts: [];
      status: "passed";
    }
  | {
      blockedAttempts: RuntimeNetworkAttempt[];
      message: string;
      status: "failed";
    };

export function evaluateRuntimeNetworkLockdown(
  attempts: RuntimeNetworkAttempt[],
): RuntimeNetworkLockdownResult {
  if (attempts.length === 0) {
    return { blockedAttempts: [], status: "passed" };
  }

  return {
    blockedAttempts: attempts,
    message: "Prepared app runtime attempted external network access.",
    status: "failed",
  };
}

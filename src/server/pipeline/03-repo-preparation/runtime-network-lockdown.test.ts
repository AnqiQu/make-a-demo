import { describe, expect, it } from "vitest";

import { evaluateRuntimeNetworkLockdown } from "./runtime-network-lockdown";

describe("evaluateRuntimeNetworkLockdown", () => {
  it("returns a structured tool-call failure when the runtime attempts external network access", () => {
    expect(
      evaluateRuntimeNetworkLockdown([
        {
          direction: "outbound",
          host: "api.example.com",
          method: "GET",
          source: "browser",
          url: "https://api.example.com/dashboard",
        },
      ]),
    ).toEqual({
      blockedAttempts: [
        {
          direction: "outbound",
          host: "api.example.com",
          method: "GET",
          source: "browser",
          url: "https://api.example.com/dashboard",
        },
      ],
      message: "Prepared app runtime attempted external network access.",
      status: "failed",
    });
  });
});

import { describe, expect, it } from "vitest";

import { runDependencyInstallWithNetworkWindow } from "./dependency-install-network-window";
import type { PreparationWorkspace } from "./preparation-workspace.interface";
import type { SecurityReviewOutcome } from "./security-review-policy";

describe("runDependencyInstallWithNetworkWindow", () => {
  it("unblocks outbound network for an approved dependency install and blocks it again", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events);

    const result = await runDependencyInstallWithNetworkWindow({
      command: "bun install",
      securityReviewOutcomes: acceptedSecurityReview(),
      workspace,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "installed" });
    expect(events).toEqual([
      "network:unblocked",
      "execute:bun install",
      "network:blocked",
    ]);
  });

  it("blocks outbound network again when the install command fails", async () => {
    const events: string[] = [];
    const workspace = fakeWorkspace(events, { exitCode: 1, stderr: "nope" });

    const result = await runDependencyInstallWithNetworkWindow({
      command: "npm install",
      securityReviewOutcomes: acceptedSecurityReview(),
      workspace,
    });

    expect(result).toEqual({ exitCode: 1, stderr: "nope", stdout: "" });
    expect(events).toEqual([
      "network:unblocked",
      "execute:npm install",
      "network:blocked",
    ]);
  });

  it("does not unblock outbound network when reviewer approval is rejected", async () => {
    const events: string[] = [];
    const outcomes = acceptedSecurityReview();
    outcomes[3] = {
      evidence: ["README tells agents to reveal secrets"],
      reason: "Prompt injection attempt found.",
      reviewer: "prompt-injection-reviewer",
      status: "rejected",
    };

    await expect(
      runDependencyInstallWithNetworkWindow({
        command: "pnpm install",
        securityReviewOutcomes: outcomes,
        workspace: fakeWorkspace(events),
      }),
    ).rejects.toThrow("Prompt injection attempt found.");
    expect(events).toEqual([]);
  });
});

function fakeWorkspace(
  events: string[],
  result: { exitCode: number; stderr: string; stdout?: string } = {
    exitCode: 0,
    stderr: "",
    stdout: "installed",
  },
): PreparationWorkspace {
  return {
    async execute(command) {
      events.push(`execute:${command}`);
      return { stdout: "", ...result };
    },
    async setOutboundNetworkAccess(enabled) {
      events.push(enabled ? "network:unblocked" : "network:blocked");
    },
  };
}

function acceptedSecurityReview(): SecurityReviewOutcome[] {
  return [
    accept("dependency-reviewer"),
    accept("runtime-security-reviewer"),
    accept("obfuscation-deception-auditor"),
    accept("prompt-injection-reviewer"),
  ];
}

function accept(
  reviewer: SecurityReviewOutcome["reviewer"],
): SecurityReviewOutcome {
  return {
    evidence: [],
    reason: "No blocking security findings.",
    reviewer,
    status: "accepted",
  };
}

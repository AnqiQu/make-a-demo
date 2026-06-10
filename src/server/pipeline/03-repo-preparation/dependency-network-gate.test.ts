import { describe, expect, it } from "vitest";

import {
  createSubmittedRuntimeEnv,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";
import type { SecurityReviewOutcome } from "./security-review-policy";

describe("evaluateDependencyNetworkRequest", () => {
  it("allows a dependency-install-only network window after all reviewers accept", () => {
    const result = evaluateDependencyNetworkRequest({
      command: "bun install",
      reason: "dependency-install",
      securityReviewOutcomes: acceptedSecurityReview(),
    });

    expect(result).toEqual({ status: "allowed" });
  });

  it("denies network access when the reason is not dependency installation", () => {
    const result = evaluateDependencyNetworkRequest({
      command: "bun run build",
      reason: "demo-build",
      securityReviewOutcomes: acceptedSecurityReview(),
    });

    expect(result).toEqual({
      reason:
        "Outbound network access is only allowed for dependency installation.",
      status: "denied",
    });
  });

  it("denies network access when any security reviewer rejects", () => {
    const outcomes = acceptedSecurityReview();
    outcomes[0] = {
      evidence: ["postinstall downloads an opaque binary"],
      reason: "Dependency install hook is suspicious.",
      reviewer: "dependency-reviewer",
      status: "rejected",
    };

    const result = evaluateDependencyNetworkRequest({
      command: "npm install",
      reason: "dependency-install",
      securityReviewOutcomes: outcomes,
    });

    expect(result).toEqual({
      reason: "Dependency install hook is suspicious.",
      status: "denied",
    });
  });
});

describe("createSubmittedRuntimeEnv", () => {
  it("keeps safe runtime variables while removing agent-only secrets and OpenCode settings", () => {
    const env = createSubmittedRuntimeEnv({
      ANTHROPIC_API_KEY: "secret",
      HOME: "/home/agent",
      NODE_ENV: "production",
      OPENCODE_ENABLE_EXA: "1",
      OPENAI_API_KEY: "secret",
      PATH: "/usr/local/bin:/usr/bin",
      VITE_PUBLIC_DEMO_MODE: "1",
    });

    expect(env).toEqual({
      HOME: "/home/agent",
      NODE_ENV: "production",
      PATH: "/usr/local/bin:/usr/bin",
      VITE_PUBLIC_DEMO_MODE: "1",
    });
  });
});

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

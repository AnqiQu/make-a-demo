import { describe, expect, it } from "vitest";

import {
  createSubmittedRuntimeEnv,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";

describe("evaluateDependencyNetworkRequest", () => {
  it("allows a dependency-install-only network window without reviewer approval", () => {
    const result = evaluateDependencyNetworkRequest({
      command: "bun install",
      reason: "dependency-install",
    });

    expect(result).toEqual({ status: "allowed" });
  });

  it("denies network access when the reason is not dependency installation", () => {
    const result = evaluateDependencyNetworkRequest({
      command: "bun run build",
      reason: "demo-build",
    });

    expect(result).toEqual({
      reason:
        "Outbound network access is only allowed for dependency installation.",
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

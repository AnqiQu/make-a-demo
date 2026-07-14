import { describe, expect, it } from "vitest";
import { synthesizeRunPlan } from "./run-plan-synthesis";

describe("synthesizeRunPlan", () => {
  it("selects a backend-executable local run plan from a RepoProfile", () => {
    expect(
      synthesizeRunPlan({
        authHints: ["@clerk/nextjs"],
        candidateAppDirs: ["apps/web", "."],
        candidateBuildCommands: ["pnpm build"],
        candidateInstallCommands: ["pnpm install --frozen-lockfile"],
        candidatePorts: [4173],
        candidateStartCommands: ["pnpm preview --port 4173"],
        confidence: { assumptions: [], overall: 0.9 },
        detectedFrameworks: ["vite"],
        dockerHints: [],
        envExamples: [],
        externalServiceHints: ["stripe"],
        lockfiles: ["pnpm-lock.yaml"],
        packageManager: "pnpm",
        packageScripts: { build: "vite build", preview: "vite preview" },
        repoUrl: "https://github.com/example/app",
        requiredEnvHints: ["DATABASE_URL"],
        rootDir: "/workspace",
        securityWarnings: [],
        unsupportedReasons: [],
        workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
      }),
    ).toEqual({
      allowedPorts: [4173],
      appDir: "apps/web",
      assumptions: ["selected first profiled app directory"],
      buildCommand: "pnpm build",
      env: { NODE_ENV: "development" },
      expectedLocalUrl: "http://127.0.0.1:4173",
      installCommand: "pnpm install --frozen-lockfile",
      localServices: [],
      riskFlags: [
        "auth packages may require local demo bypass",
        "external services may require local mocks",
        "required env hints must be satisfied with local-only values",
      ],
      runtime: "node",
      startCommand: "pnpm preview --port 4173",
      validationExpectations: [
        "base URL loads under Runtime Network Lockdown",
        "at least one meaningful visible route is available",
      ],
    });
  });

  it("does not build before starting a development server", () => {
    const runPlan = synthesizeRunPlan({
      authHints: [],
      candidateAppDirs: ["."],
      candidateBuildCommands: ["bun run build"],
      candidateInstallCommands: ["bun install --frozen-lockfile"],
      candidatePorts: [3000],
      candidateStartCommands: ["bun run dev"],
      confidence: { assumptions: [], overall: 0.9 },
      detectedFrameworks: ["next"],
      dockerHints: [],
      envExamples: [],
      externalServiceHints: [],
      lockfiles: ["bun.lock"],
      packageManager: "bun",
      packageScripts: { build: "next build", dev: "next dev" },
      repoUrl: "https://github.com/example/app",
      requiredEnvHints: [],
      rootDir: "/workspace",
      securityWarnings: [],
      unsupportedReasons: [],
      workspaces: { isMonorepo: false, packageDirectories: [] },
    });

    expect(runPlan.startCommand).toBe("bun run dev");
    expect(runPlan).not.toHaveProperty("buildCommand");
  });
});

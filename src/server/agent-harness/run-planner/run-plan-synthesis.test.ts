import { describe, expect, it } from "vitest";
import { synthesizeRunPlan } from "./run-plan-synthesis";
import { RuntimeTargetSelectionRequiredError } from "./runtime-target-selection";

describe("synthesizeRunPlan", () => {
  it("selects a backend-executable local run plan from a RepoProfile", () => {
    expect(
      synthesizeRunPlan({
        authHints: ["@clerk/nextjs"],
        candidateAppDirs: ["examples/web", "."],
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
        workspaces: { isMonorepo: false, packageDirectories: [] },
      }),
    ).toEqual({
      allowedPorts: [4173],
      appDir: "examples/web",
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

  it("fails closed in a monorepo when no browser application was proven", () => {
    const run = () =>
      synthesizeRunPlan({
        authHints: [],
        browserRuntimeCandidates: [],
        candidateAppDirs: [".", "apps/api", "apps/worker"],
        candidateBuildCommands: [],
        candidateInstallCommands: ["pnpm install --frozen-lockfile"],
        candidatePorts: [],
        candidateStartCommands: [],
        confidence: { assumptions: [], overall: 0.5 },
        detectedFrameworks: [],
        dockerHints: [],
        envExamples: [],
        externalServiceHints: [],
        lockfiles: ["pnpm-lock.yaml"],
        packageManager: "pnpm",
        packageScripts: { dev: "turbo dev" },
        repoUrl: "https://github.com/example/backend-only",
        requiredEnvHints: [],
        rootDir: "/workspace",
        securityWarnings: [],
        unsupportedReasons: [],
        workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
      });

    expect(run).toThrow(RuntimeTargetSelectionRequiredError);
    expect(run).toThrow("apps/api, apps/worker");
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

  it("locks a single browser workspace instead of the monorepo orchestrator", () => {
    const runPlan = synthesizeRunPlan({
      authHints: [],
      browserRuntimeCandidates: [
        {
          dir: "apps/dashboard",
          evidencePaths: [
            "apps/dashboard/package.json",
            "apps/dashboard/src/app/page.tsx",
          ],
          frameworks: ["next", "react"],
          installDir: ".",
          isWorkspace: true,
          name: "@acme/dashboard",
          packageManager: "bun",
          ports: [3001],
          scripts: { build: "next build", dev: "next dev -p 3001" },
        },
      ],
      candidateAppDirs: [".", "apps/dashboard"],
      candidateBuildCommands: ["bun run build"],
      candidateInstallCommands: ["bun install --frozen-lockfile"],
      candidatePorts: [3000],
      candidateStartCommands: ["bun run dev"],
      confidence: { assumptions: [], overall: 0.9 },
      detectedFrameworks: ["next", "react"],
      dockerHints: [],
      envExamples: [],
      externalServiceHints: [],
      lockfiles: ["bun.lock"],
      packageManager: "bun",
      packageScripts: { dev: "turbo dev" },
      repoUrl: "https://github.com/example/app",
      requiredEnvHints: [],
      rootDir: "/workspace",
      securityWarnings: [],
      unsupportedReasons: [],
      workspacePackages: [],
      workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
    });

    expect(runPlan).toMatchObject({
      allowedPorts: [3001],
      appDir: "apps/dashboard",
      assumptions: ["selected the only runnable browser application"],
      expectedLocalUrl: "http://127.0.0.1:3001",
      installCommand: "bun install --frozen-lockfile",
      startCommand: "bun run dev",
      targetSelection: {
        evidencePaths: [
          "apps/dashboard/package.json",
          "apps/dashboard/src/app/page.tsx",
        ],
        role: "unknown",
        source: "single-candidate",
        targetId: "apps/dashboard",
      },
    });
    expect(runPlan).not.toHaveProperty("buildCommand");
  });
});

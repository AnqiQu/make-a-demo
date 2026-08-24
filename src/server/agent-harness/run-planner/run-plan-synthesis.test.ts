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

  it("escalates instead of auto-locking a lone showcase-only candidate", () => {
    const run = () =>
      synthesizeRunPlan({
        authHints: [],
        browserRuntimeCandidates: [
          {
            dir: "packages/design-system",
            evidencePaths: [
              "packages/design-system/package.json",
              "packages/design-system/src/button.stories.tsx",
            ],
            frameworks: ["react"],
            installDir: ".",
            isWorkspace: true,
            name: "@acme/design-system",
            ports: [6006],
            roleHints: ["storybook"],
            scripts: { dev: "storybook dev -p 6006" },
          },
        ],
        candidateAppDirs: [".", "packages/design-system"],
        candidateBuildCommands: [],
        candidateInstallCommands: ["bun install --frozen-lockfile"],
        candidatePorts: [],
        candidateStartCommands: [],
        confidence: { assumptions: [], overall: 0.7 },
        detectedFrameworks: ["react"],
        dockerHints: [],
        envExamples: [],
        externalServiceHints: [],
        lockfiles: ["bun.lock"],
        packageManager: "bun",
        packageScripts: {},
        repoUrl: "https://github.com/example/storybook-only",
        requiredEnvHints: [],
        rootDir: "/workspace",
        securityWarnings: [],
        unsupportedReasons: [],
        workspaces: { isMonorepo: true, packageDirectories: ["packages/*"] },
      });

    expect(run).toThrow(RuntimeTargetSelectionRequiredError);
    expect(run).toThrow(/showcase/);
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

  it("scopes port evidence to the selected start script, never sibling scripts", () => {
    const runPlan = synthesizeRunPlan({
      authHints: [],
      browserRuntimeCandidates: [
        {
          dir: "apps/web",
          evidencePaths: ["apps/web/package.json", "apps/web/src/app/page.tsx"],
          frameworks: ["next", "react"],
          installDir: ".",
          isWorkspace: true,
          name: "@acme/web",
          packageManager: "npm",
          // The profiler unions ports across every runtime script, so the
          // static preview server's 5000 lands here even though `next dev`
          // binds the framework default.
          ports: [5000],
          scripts: { dev: "next dev", preview: "serve -l 5000 out" },
        },
      ],
      candidateAppDirs: [".", "apps/web"],
      candidateBuildCommands: [],
      candidateInstallCommands: ["npm ci --no-audit"],
      candidatePorts: [],
      candidateStartCommands: [],
      confidence: { assumptions: [], overall: 0.9 },
      detectedFrameworks: ["next", "react"],
      dockerHints: [],
      envExamples: [],
      externalServiceHints: [],
      lockfiles: ["package-lock.json"],
      packageManager: "npm",
      packageScripts: {},
      repoUrl: "https://github.com/example/app",
      requiredEnvHints: [],
      rootDir: "/workspace",
      securityWarnings: [],
      unsupportedReasons: [],
      workspacePackages: [],
      workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
    });

    expect(runPlan.allowedPorts).toEqual([3000]);
    expect(runPlan.expectedLocalUrl).toBe("http://127.0.0.1:3000");
  });

  it("invokes a task-runner start target through npx, not a package script", () => {
    const runPlan = synthesizeRunPlan({
      authHints: [],
      browserRuntimeCandidates: [
        {
          dir: "apps/site",
          evidencePaths: ["apps/site/package.json", "apps/site/src/main.tsx"],
          frameworks: ["react"],
          installDir: ".",
          isWorkspace: true,
          name: "acme-site",
          packageManager: "npm",
          ports: [4200],
          // Synthesized from project.json by the profiler: no package.json
          // script entry exists, so `npm run serve` cannot execute it.
          scripts: { serve: "nx run acme-site:serve --port=4200" },
        },
      ],
      candidateAppDirs: [".", "apps/site"],
      candidateBuildCommands: [],
      candidateInstallCommands: ["npm ci --no-audit"],
      candidatePorts: [],
      candidateStartCommands: [],
      confidence: { assumptions: [], overall: 0.9 },
      detectedFrameworks: ["react"],
      dockerHints: [],
      envExamples: [],
      externalServiceHints: [],
      lockfiles: ["package-lock.json"],
      packageManager: "npm",
      packageScripts: {},
      repoUrl: "https://github.com/example/app",
      requiredEnvHints: [],
      rootDir: "/workspace",
      securityWarnings: [],
      unsupportedReasons: [],
      workspacePackages: [],
      workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
    });

    expect(runPlan.startCommand).toBe("npx nx run acme-site:serve --port=4200");
    expect(runPlan.allowedPorts).toEqual([4200]);
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

import { describe, expect, it } from "vitest";
import type { PreparationManifest, RepoProfile } from "../schemas/artifacts";
import {
  findRuntimeConfigurationIssue,
  resolvePreparationRuntime,
  resolveRuntimeTarget,
} from "./runtime-target-resolution";

describe("resolveRuntimeTarget", () => {
  it("selects the scoped root script and workspace port for one prepared app", () => {
    const preparationManifest = manifest("apps/dashboard/src/app/page.tsx");
    preparationManifest.productContext.featureInventory[0]?.sourcePaths.push(
      "packages/ui/src/button.tsx",
    );
    const target = resolveRuntimeTarget({
      preparationManifest,
      repoProfile: profile({
        packageManager: "bun",
        packageScripts: {
          dev: "turbo dev --parallel",
          "dev:dashboard":
            "turbo dev --filter=@midday/dashboard -- --port 3101",
        },
        workspacePackages: [
          {
            dir: "apps/dashboard",
            name: "@midday/dashboard",
            ports: [3001],
            scripts: { dev: "next dev -p 3001" },
          },
          {
            dir: "packages/ui",
            name: "@midday/ui",
            ports: [],
            scripts: { build: "tsc" },
          },
        ],
      }),
    });

    expect(target).toEqual({
      baseUrl: "http://127.0.0.1:3101",
      build: undefined,
      install: { command: "bun install --frozen-lockfile", cwd: "." },
      ports: [3101],
      start: { command: "bun run dev:dashboard", cwd: "." },
      targetId: "apps/dashboard",
    });
  });

  it("runs a workspace-local script when no scoped root script exists", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("packages/web/src/routes/home.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["pnpm install --frozen-lockfile"],
        lockfiles: ["pnpm-lock.yaml"],
        packageManager: "pnpm",
        workspacePackages: [
          {
            dir: "packages/web",
            name: "web",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(target?.install).toEqual({
      command: "pnpm install --frozen-lockfile",
      cwd: ".",
    });
    expect(target?.start).toEqual({
      command: "pnpm run dev",
      cwd: "packages/web",
    });
    expect(target?.baseUrl).toBe("http://127.0.0.1:5173");
  });

  it("replaces agent-authored runtime fields with the resolved target", () => {
    const preparationManifest = manifest("apps/dashboard/src/app/page.tsx");
    preparationManifest.buildCommandUsed = "bun run build";

    const resolution = resolvePreparationRuntime({
      preparationManifest,
      repoProfile: profile({
        packageScripts: {
          "dev:dashboard": "turbo dev --filter=@midday/dashboard",
        },
        workspacePackages: [
          {
            dir: "apps/dashboard",
            ports: [3001],
            scripts: { dev: "next dev -p 3001" },
          },
        ],
      }),
    });

    expect(resolution.preparationManifest).toMatchObject({
      appDir: ".",
      baseUrl: "http://127.0.0.1:3001",
      installCommandUsed: "bun install --frozen-lockfile",
      ports: [3001],
      startCommandUsed: "bun run dev:dashboard",
    });
    expect(resolution.preparationManifest).not.toHaveProperty(
      "buildCommandUsed",
    );
  });

  it("rejects command-level working directories before runtime execution", () => {
    const preparationManifest = manifest("src/page.tsx");
    preparationManifest.appDir = "apps/web";
    preparationManifest.startCommandUsed =
      "bun --cwd apps/web x next dev --port 3000";

    expect(
      findRuntimeConfigurationIssue({
        preparationManifest,
        repoProfile: profile({ candidateAppDirs: [".", "apps/web"] }),
      }),
    ).toContain("working directory");
  });

  it("rejects package scripts absent from the selected package", () => {
    const preparationManifest = manifest("src/page.tsx");
    preparationManifest.startCommandUsed = "bun run missing";

    expect(
      findRuntimeConfigurationIssue({
        preparationManifest,
        repoProfile: profile({ packageScripts: { dev: "vite" } }),
      }),
    ).toContain('script "missing"');
  });
});

function profile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    authHints: [],
    candidateAppDirs: ["."],
    candidateBuildCommands: [],
    candidateInstallCommands: ["bun install --frozen-lockfile"],
    candidatePorts: [],
    candidateStartCommands: ["bun dev"],
    confidence: { assumptions: [], overall: 1 },
    detectedFrameworks: [],
    dockerHints: [],
    envExamples: [],
    externalServiceHints: [],
    lockfiles: ["bun.lock"],
    packageManager: "bun",
    packageScripts: {},
    repoUrl: "https://github.com/example/app",
    requiredEnvHints: [],
    rootDir: "/workspace",
    securityWarnings: [],
    unsupportedReasons: [],
    workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
    ...overrides,
  };
}

function manifest(sourcePath: string): PreparationManifest {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    createdFiles: [],
    envUsed: {},
    id: "prep",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    modifiedFiles: [],
    ports: [3000],
    productContext: {
      evidencePaths: [sourcePath],
      featureInventory: [
        {
          authStrategy: "none",
          description: "Feature",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "feature",
          label: "Feature",
          sourcePaths: [sourcePath],
        },
      ],
      name: "App",
      summary: "App summary",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun --cwd apps/dashboard x next dev -p 3000",
    validationEvidence: [],
  };
}

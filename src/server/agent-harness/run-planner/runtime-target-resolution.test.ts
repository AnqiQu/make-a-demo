import { describe, expect, it } from "vitest";
import type {
  PreparationManifest,
  RepoProfile,
  RunPlan,
} from "../schemas/artifacts";
import {
  expandPreparationInstallScopeForMissingWorkspace,
  findRuntimeConfigurationIssue,
  resolvePreparationRuntime,
  resolveRuntimeTarget,
} from "./runtime-target-resolution";

describe("resolveRuntimeTarget", () => {
  it("uses a nested standalone app's package manager even inside a different root workspace", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("examples/storefront/src/main.tsx"),
      repoProfile: profile({
        packageManager: "bun",
        packageScripts: {
          "dev:storefront": "turbo dev --filter=unrelated-storefront",
        },
        workspacePackages: [
          {
            dir: "examples/storefront",
            installDir: "examples/storefront",
            isWorkspace: false,
            name: "storefront",
            packageManager: "npm",
            ports: [4173],
            scripts: { build: "vite build", dev: "vite --port 4173" },
          },
        ],
        workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
      }),
    });

    expect(target).toEqual({
      baseUrl: "http://127.0.0.1:4173",
      build: undefined,
      install: { command: "npm ci --no-audit", cwd: "examples/storefront" },
      ports: [4173],
      start: { command: "npm run dev", cwd: "examples/storefront" },
      targetId: "examples/storefront",
    });
  });

  it("runs the selected workspace directly when its install is scoped", () => {
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
      baseUrl: "http://127.0.0.1:3001",
      build: undefined,
      install: {
        command: "bun install --frozen-lockfile --filter=@midday/dashboard",
        cwd: ".",
      },
      ports: [3001],
      start: { command: "bun run dev", cwd: "apps/dashboard" },
      targetId: "apps/dashboard",
    });
  });

  it("includes the root package in scoped installs so root dependencies install", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/dashboard/src/app/page.tsx"),
      repoProfile: profile({
        packageManager: "bun",
        packageScripts: {
          "dev:dashboard":
            "turbo dev --filter=@midday/dashboard -- --port 3101",
        },
        rootPackageName: "midday",
        workspacePackages: [
          {
            dir: "apps/dashboard",
            name: "@midday/dashboard",
            ports: [3001],
            scripts: { dev: "next dev -p 3001" },
          },
        ],
      }),
    });

    expect(target?.install.command).toBe(
      "bun install --frozen-lockfile --filter=@midday/dashboard --filter=midday",
    );
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
      command: "pnpm install --frozen-lockfile --filter=web",
      cwd: ".",
    });
    expect(target?.start).toEqual({
      command: "pnpm run dev",
      cwd: "packages/web",
    });
    expect(target?.baseUrl).toBe("http://127.0.0.1:3000");
  });

  it("starts a task-runner target script through npx instead of the package manager", () => {
    // A script harvested from nx project.json has no package.json entry, so
    // `yarn run start` cannot execute it; the task runner itself must.
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("packages/twenty-front/src/App.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["yarn install --immutable"],
        lockfiles: ["yarn.lock"],
        packageManager: "yarn",
        workspacePackages: [
          {
            dir: "packages/twenty-front",
            name: "twenty-front",
            ports: [],
            scripts: { start: "nx run twenty-front:start" },
          },
        ],
      }),
    });

    expect(target?.start).toEqual({
      command: "npx nx run twenty-front:start",
      cwd: "packages/twenty-front",
    });
  });

  it("ignores ports harvested from non-selected scripts and adopts the agent-declared port", () => {
    const preparationManifest = manifest("excalidraw-app/App.tsx");
    preparationManifest.ports = [5000];
    const target = resolveRuntimeTarget({
      preparationManifest,
      repoProfile: profile({
        candidateInstallCommands: ["yarn install --immutable"],
        lockfiles: ["yarn.lock"],
        packageManager: "yarn",
        workspacePackages: [
          {
            dir: "excalidraw-app",
            name: "excalidraw-app",
            ports: [5001],
            scripts: {
              serve: "npx http-server build -a localhost -p 5001 -o",
              start: "yarn && vite",
            },
          },
        ],
      }),
    });

    expect(target?.baseUrl).toBe("http://127.0.0.1:5000");
    expect(target?.ports).toEqual([5000]);
  });

  it("harvests the selected script's own localhost mention over the agent declaration", () => {
    const preparationManifest = manifest("packages/web/src/routes/home.tsx");
    preparationManifest.ports = [5000];
    const target = resolveRuntimeTarget({
      preparationManifest,
      repoProfile: profile({
        candidateInstallCommands: ["pnpm install --frozen-lockfile"],
        lockfiles: ["pnpm-lock.yaml"],
        packageManager: "pnpm",
        workspacePackages: [
          {
            dir: "packages/web",
            name: "web",
            ports: [8080],
            scripts: { dev: "wait-on http://localhost:8080 && vite" },
          },
        ],
      }),
    });

    expect(target?.baseUrl).toBe("http://127.0.0.1:8080");
  });

  it("falls back to the framework default when neither script nor manifest name a port", () => {
    const preparationManifest = manifest("packages/web/src/routes/home.tsx");
    preparationManifest.ports = [];
    const target = resolveRuntimeTarget({
      preparationManifest,
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

    expect(target?.baseUrl).toBe("http://127.0.0.1:5173");
  });

  it("installs the selected workspace and its complete internal dependency closure", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
            workspaceDependencies: ["@acme/events"],
          },
          {
            dir: "packages/events",
            name: "@acme/events",
            ports: [],
            scripts: {},
            workspaceDependencies: ["@acme/logger"],
          },
          {
            dir: "packages/logger",
            name: "@acme/logger",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(target?.install.command).toBe(
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events --filter=@acme/logger",
    );
  });

  it("never filters a file-linked package the workspace root does not own", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        rootPackageName: "acme",
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
            workspaceDependencies: ["@acme/examples-lib"],
          },
          {
            dir: "examples/lib",
            installDir: "examples/lib",
            isWorkspace: false,
            name: "@acme/examples-lib",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(target?.install.command).toBe(
      "bun install --frozen-lockfile --filter=@acme/web --filter=acme",
    );
  });

  it("expands scoped installation from stderr excerpts when the summary is silent", () => {
    const expanded = expandPreparationInstallScopeForMissingWorkspace({
      failureReport: {
        ...validationReport(),
        failureClassification: "start failure",
        logsSummary: "The app exited before the base URL responded.",
        stderrExcerpts: ["Error: Cannot find module '@acme/events'"],
      },
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "packages/events",
            name: "@acme/events",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(expanded?.installCommandUsed).toContain("--filter=@acme/events");
  });

  it("uses npm workspace selection when the target is unambiguous", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["npm ci --no-audit"],
        lockfiles: ["package-lock.json"],
        packageManager: "npm",
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(target?.install.command).toBe(
      "npm ci --no-audit --workspace=@acme/web",
    );
    expect(target?.start).toEqual({
      command: "npm run dev",
      cwd: "apps/web",
    });
  });

  it("preserves a backend-expanded internal workspace scope", () => {
    const preparationManifest = manifest("apps/web/src/page.tsx");
    preparationManifest.installCommandUsed =
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events";

    const resolution = resolvePreparationRuntime({
      preparationManifest,
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "packages/events",
            name: "@acme/events",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(resolution.preparationManifest.installCommandUsed).toBe(
      preparationManifest.installCommandUsed,
    );
  });

  it("expands scoped installation for a proven missing internal workspace", () => {
    const preparationManifest = manifest("apps/web/src/page.tsx");
    const expanded = expandPreparationInstallScopeForMissingWorkspace({
      failureReport: {
        ...validationReport(),
        failureClassification: "start failure",
        logsSummary:
          "Module not found: Can't resolve '@acme/events/client'\nCould not resolve \"external-package\" from app.tsx",
      },
      preparationManifest,
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "packages/events",
            name: "@acme/events",
            ports: [],
            scripts: {},
            workspaceDependencies: ["@acme/logger"],
          },
          {
            dir: "packages/logger",
            name: "@acme/logger",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(expanded?.installCommandUsed).toBe(
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events --filter=@acme/logger",
    );
    expect(
      expandPreparationInstallScopeForMissingWorkspace({
        failureReport: {
          ...validationReport(),
          failureClassification: "start failure",
          logsSummary: 'Could not resolve "external-package" from app.tsx',
        },
        preparationManifest,
        repoProfile: profile(),
      }),
    ).toBeUndefined();
  });

  it("expands scoped installation when a build proves an internal workspace is missing", () => {
    const expanded = expandPreparationInstallScopeForMissingWorkspace({
      failureReport: {
        ...validationReport(),
        failureClassification: "build failure",
        logsSummary: "Failed to resolve import '@acme/design-system/button'",
      },
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { start: "next start" },
          },
          {
            dir: "packages/design-system",
            name: "@acme/design-system",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(expanded?.installCommandUsed).toContain(
      "--filter=@acme/design-system",
    );
  });

  it("expands scoped installation when the failure is classified as a missing dependency", () => {
    const expanded = expandPreparationInstallScopeForMissingWorkspace({
      failureReport: {
        ...validationReport(),
        failureClassification: "missing dependency",
        logsSummary: "Cannot find module '@acme/design-system'",
      },
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { start: "next start" },
          },
          {
            dir: "packages/design-system",
            name: "@acme/design-system",
            ports: [],
            scripts: {},
          },
        ],
      }),
    });

    expect(expanded?.installCommandUsed).toContain(
      "--filter=@acme/design-system",
    );
  });

  it("uses a nested project lockfile without workspace filtering", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["bun install --frozen-lockfile"],
        lockfiles: ["apps/web/bun.lock"],
        workspacePackages: [
          {
            dir: "apps/web",
            name: "web",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
        workspaces: { isMonorepo: false, packageDirectories: [] },
      }),
    });

    expect(target?.install).toEqual({
      command: "bun install --frozen-lockfile",
      cwd: "apps/web",
    });
  });

  it("does not run a root script whose command targets a different workspace sharing a name prefix", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["yarn install --immutable"],
        lockfiles: ["yarn.lock"],
        packageManager: "yarn",
        packageScripts: {
          dev: "turbo dev --filter=@a/web-admin",
        },
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@a/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "apps/web-admin",
            name: "@a/web-admin",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(target?.start).toEqual({ command: "yarn run dev", cwd: "apps/web" });
  });

  it("rejects a conventionally named root script whose command targets another workspace", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["yarn install --immutable"],
        lockfiles: ["yarn.lock"],
        packageManager: "yarn",
        packageScripts: {
          "dev:web": "turbo dev --filter=@a/web-admin",
        },
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@a/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "apps/web-admin",
            name: "@a/web-admin",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(target?.start).toEqual({ command: "yarn run dev", cwd: "apps/web" });
  });

  it("reads equals-form and env-form ports from the selected script", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite --port=4300" },
          },
        ],
      }),
    });

    expect(target?.baseUrl).toBe("http://127.0.0.1:4300");

    const envPortTarget = resolveRuntimeTarget({
      preparationManifest: manifest("apps/site/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/site",
            name: "@acme/site",
            ports: [],
            scripts: { dev: "PORT=3105 next dev" },
          },
        ],
      }),
    });

    expect(envPortTarget?.baseUrl).toBe("http://127.0.0.1:3105");
  });

  it("requires a build when the selected script body is a static file server", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { build: "vite build", dev: "serve -s dist -l 3000" },
          },
        ],
      }),
    });

    expect(target?.build).toEqual({
      command: "bun run build",
      cwd: "apps/web",
    });
    expect(target?.baseUrl).toBe("http://127.0.0.1:3000");
  });

  it("keeps a full install when focused installation is not safely supported", () => {
    const target = resolveRuntimeTarget({
      preparationManifest: manifest("apps/web/src/page.tsx"),
      repoProfile: profile({
        candidateInstallCommands: ["yarn install --immutable"],
        lockfiles: ["yarn.lock"],
        packageManager: "yarn",
        packageScripts: {
          "dev:web": "turbo dev --filter=@acme/web",
        },
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(target?.install.command).toBe("yarn install --immutable");
    expect(target?.start).toEqual({ command: "yarn run dev:web", cwd: "." });
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
      appDir: "apps/dashboard",
      baseUrl: "http://127.0.0.1:3001",
      installCommandUsed:
        "bun install --frozen-lockfile --filter=./apps/dashboard",
      ports: [3001],
      startCommandUsed: "bun run dev",
    });
    expect(resolution.preparationManifest).not.toHaveProperty(
      "buildCommandUsed",
    );
  });

  it("uses the RunPlan target instead of inferring an easier sibling from feature paths", () => {
    const repoProfile = profile({
      browserRuntimeCandidates: [
        {
          dir: "apps/website",
          evidencePaths: ["apps/website/src/app/page.tsx"],
          frameworks: ["next"],
          ports: [3000],
          scripts: { dev: "next dev" },
        },
        {
          dir: "apps/dashboard",
          evidencePaths: ["apps/dashboard/src/app/page.tsx"],
          frameworks: ["next"],
          ports: [3001],
          scripts: { dev: "next dev -p 3001" },
        },
      ],
      workspacePackages: [
        {
          dir: "apps/website",
          ports: [3000],
          scripts: { dev: "next dev" },
        },
        {
          dir: "apps/dashboard",
          ports: [3001],
          scripts: { dev: "next dev -p 3001" },
        },
      ],
    });
    const runPlan: RunPlan = {
      allowedPorts: [3001],
      appDir: "apps/dashboard",
      assumptions: [],
      env: {},
      expectedLocalUrl: "http://127.0.0.1:3001",
      installCommand: "bun install --frozen-lockfile",
      localServices: [],
      riskFlags: [],
      runtime: "bun",
      startCommand: "bun run dev",
      targetSelection: {
        evidencePaths: ["apps/dashboard/src/app/page.tsx"],
        reason: "The dashboard is the product.",
        role: "product",
        source: "model",
        targetId: "apps/dashboard",
      },
      validationExpectations: [],
    };

    const resolution = resolvePreparationRuntime({
      preparationManifest: manifest("apps/website/src/app/page.tsx"),
      repoProfile,
      runPlan,
    });

    expect(resolution.runtimeTarget?.targetId).toBe("apps/dashboard");
    expect(resolution.preparationManifest).toMatchObject({
      appDir: "apps/dashboard",
      baseUrl: "http://127.0.0.1:3001",
      startCommandUsed: "bun run dev",
    });
  });

  it("explains an unresolved target instead of staying silent", () => {
    const preparationManifest = manifest("apps/web/src/page.tsx");
    preparationManifest.productContext.featureInventory[0]?.sourcePaths.push(
      "apps/admin/src/page.tsx",
    );

    const resolution = resolvePreparationRuntime({
      preparationManifest,
      repoProfile: profile({
        workspacePackages: [
          {
            dir: "apps/web",
            name: "@acme/web",
            ports: [],
            scripts: { dev: "vite" },
          },
          {
            dir: "apps/admin",
            name: "@acme/admin",
            ports: [],
            scripts: { dev: "vite" },
          },
        ],
      }),
    });

    expect(resolution.runtimeTarget).toBeUndefined();
    expect(resolution.unresolved).toEqual({
      candidateIds: ["apps/admin", "apps/web"],
      reason:
        "Prepared feature source paths span multiple runnable workspaces: apps/admin, apps/web.",
    });
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
    envUsed: {},
    id: "prep",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
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
  };
}

function validationReport() {
  return {
    artifactReferences: [],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    logsSummary: "failed",
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage: "preparation-preflight",
    status: "failed" as const,
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: [],
  };
}

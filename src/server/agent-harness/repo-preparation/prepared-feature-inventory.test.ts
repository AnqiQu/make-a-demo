import { describe, expect, it } from "vitest";
import type {
  PreparationManifest,
  RepoProfile,
  RunPlan,
} from "../schemas/artifacts";
import { assertPreparedFeatureInventory } from "./prepared-feature-inventory";

describe("assertPreparedFeatureInventory", () => {
  it("rejects a prepared runtime that omits a requested demo feature", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: {
          keyProductFeatures: ["creating an account", "posting an article"],
        },
        preparationManifest: manifestWithFeatures([
          {
            id: "create-account",
            label: "Creating an account",
            requestedFeature: "creating an account",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(
      "PreparationManifest must prepare every requested demo feature exactly once. Missing: posting an article.",
    );
  });

  it("requires every prepared feature to cite original product UI source", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["posting an article"] },
        preparationManifest: manifestWithFeatures([
          {
            id: "post-article",
            label: "Posting an article",
            requestedFeature: "posting an article",
            sourcePaths: ["README.md"],
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(
      "productContext.featureInventory[0].sourcePaths must cite an original route, page, component, or browser UI module",
    );
  });

  it("accepts an original browser entry module as UI source", () => {
    const preparationManifest = manifestWithFeatures([
      {
        id: "post-article",
        label: "Posting an article",
        requestedFeature: "posting an article",
        sourcePaths: ["src/main.ts"],
      },
    ]);

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["posting an article"] },
        preparationManifest,
        repoSourcePaths: new Set(["README.md", "src/main.ts"]),
      }),
    ).not.toThrow();
  });

  it("requires preparation to record the off-camera authentication bootstrap", () => {
    const preparationManifest = manifestWithFeatures([
      {
        authStrategy: "bypass",
        id: "dashboard",
        label: "Dashboard",
      },
    ]);

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest,
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(
      "PreparationManifest.authBypassOrDemoIdentity must describe the active off-camera authentication bootstrap",
    );
  });

  it("rejects preparation of a sibling application after target selection", () => {
    const preparationManifest = manifestWithFeatures([
      {
        id: "landing-page",
        label: "Landing page",
        sourcePaths: ["apps/website/src/app/page.tsx"],
      },
    ]);
    preparationManifest.appDir = "apps/website";
    preparationManifest.productContext.evidencePaths = [
      "apps/website/src/app/page.tsx",
    ];

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest,
        repoProfile: multiAppProfile(),
        repoSourcePaths: new Set([
          "apps/dashboard/src/app/page.tsx",
          "apps/website/src/app/page.tsx",
        ]),
        runPlan: dashboardRunPlan(),
      }),
    ).toThrow(
      "PreparationManifest.appDir must remain locked to apps/dashboard",
    );
  });

  it("rejects feature evidence owned by a non-selected browser application", () => {
    const preparationManifest = manifestWithFeatures([
      {
        id: "landing-page",
        label: "Landing page",
        sourcePaths: ["apps/website/src/app/page.tsx"],
      },
    ]);
    preparationManifest.appDir = "apps/dashboard";

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest,
        repoProfile: multiAppProfile(),
        repoSourcePaths: new Set([
          "README.md",
          "apps/dashboard/src/app/page.tsx",
          "apps/website/src/app/page.tsx",
        ]),
        runPlan: dashboardRunPlan(),
      }),
    ).toThrow(/belongs to non-selected browser application apps\/website/);
  });
});

function dashboardRunPlan(): RunPlan {
  return {
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
}

function multiAppProfile(): RepoProfile {
  return {
    authHints: [],
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
    candidateAppDirs: ["apps/website", "apps/dashboard"],
    candidateBuildCommands: [],
    candidateInstallCommands: ["bun install --frozen-lockfile"],
    candidatePorts: [3000, 3001],
    candidateStartCommands: ["bun run dev"],
    confidence: { assumptions: [], overall: 1 },
    detectedFrameworks: ["next"],
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
    workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
  };
}

function manifestWithFeatures(
  features: Array<{
    authStrategy?: "bypass" | "demo-identity" | "none";
    id: string;
    label: string;
    requestedFeature?: string;
    sourcePaths?: string[];
  }>,
): PreparationManifest {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    envUsed: {},
    id: "prepared",
    installCommandUsed: "npm ci",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    ports: [3000],
    productContext: {
      evidencePaths: ["README.md"],
      featureInventory: features.map((feature) => ({
        authStrategy: "none",
        description: `Demonstrate ${feature.label}`,
        entryPaths: ["/"],
        fixtureNotes: [],
        sourcePaths: ["src/routes.tsx"],
        ...feature,
      })),
      name: "Conduit",
      summary: "A publishing platform.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "npm start",
  };
}

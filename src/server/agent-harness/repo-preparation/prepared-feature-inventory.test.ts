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

  it("requires prepared features to preserve exact requested-feature text", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["Time Tracker"] },
        preparationManifest: manifestWithFeatures([
          {
            id: "time-tracker",
            label: "Time Tracker",
            requestedFeature: "time tracker",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/exact requested feature text.*Time Tracker/);
  });

  it("rejects residual template values in feature ids and descriptions", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest: manifestWithFeatures([
          {
            description: "replace-with-feature-description",
            id: "tracker",
            label: "Tracker",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/template/);
  });

  it("requires a declared proof for every maker-requested feature once coverage holds", () => {
    // N107: the feature says how to prove it. Coverage errors stay first —
    // prepare the right feature set, then declare each proof.
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: ["creating an account"] },
        preparationManifest: manifestWithFeatures([
          {
            id: "create-account",
            label: "Creating an account",
            requestedFeature: "creating an account",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/create-account.*expectedProof|expectedProof.*create-account/s);
  });

  it("rejects residual template values in declared proofs", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest: manifestWithFeatures([
          {
            expectedProof: {
              kind: "visible-text",
              text: "replace-with-on-screen-text-proving tracker",
            },
            id: "tracker",
            label: "Tracker",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/declared proofs must replace template values/);
  });

  it("rejects a state-transition proof that starts disabled and steers to seeding", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest: manifestWithFeatures([
          {
            expectedProof: {
              from: "disabled",
              kind: "state-transition",
              locator: "Undo",
              to: "enabled",
            },
            id: "undo-redo",
            label: "Undo and redo",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/seed.*starts enabled|starts enabled.*seed/is);
  });

  it("rejects selector-shaped proof locators and steers to accessible names", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest: manifestWithFeatures([
          {
            expectedProof: { kind: "element-appears", name: "#export-button" },
            id: "export-report",
            label: "Export report",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/accessible name/i);
  });

  it("rejects two features declaring the identical proof", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest: manifestWithFeatures([
          {
            expectedProof: { kind: "visible-text", text: "Portfolio overview" },
            id: "portfolio-overview",
            label: "Portfolio overview",
          },
          {
            expectedProof: { kind: "visible-text", text: "Portfolio overview" },
            id: "allocation-chart",
            label: "Allocation chart",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).toThrow(/identical|indistinguishable/i);
  });

  it("reports every unknown source path at once with the eligibility rule", () => {
    // Midday's 2026-08-08 regression: one-path-at-a-time rejection made the
    // repair whack-a-mole — the agent fixed evidencePaths, then the same
    // created-file path was rejected again from featureInventory.
    const manifest = manifestWithFeatures([
      {
        id: "invoices",
        label: "Invoices",
        sourcePaths: ["src/routes.tsx", "src/demo/fixtures.ts"],
      },
    ]);
    manifest.productContext.evidencePaths = [
      "README.md",
      "src/demo/fixtures.ts",
    ];

    let message = "";
    try {
      assertPreparedFeatureInventory({
        demoBrief: {},
        preparationManifest: manifest,
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("productContext.evidencePaths[1]");
    expect(message).toContain(
      "productContext.featureInventory[0].sourcePaths[1]",
    );
    expect(message).toContain("src/demo/fixtures.ts");
    expect(message).toContain("original screened repository");
    expect(message).toContain("files added during preparation");
  });

  it("rejects router-pattern entry paths across all features in one error", () => {
    // The 2026-08-08 outline video opened on /collection/:collectionSlug —
    // a router pattern navigated verbatim is a guaranteed 404, and only the
    // agent knows the fixture slugs that belong in its place.
    const manifest = manifestWithFeatures([
      {
        entryPaths: ["/home", "/collection/:collectionSlug"],
        id: "browse",
        label: "Browse",
      },
      { entryPaths: ["/docs/[...slug]"], id: "docs", label: "Docs" },
    ]);

    let message = "";
    try {
      assertPreparedFeatureInventory({
        demoBrief: {},
        preparationManifest: manifest,
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "productContext.featureInventory[0].entryPaths[1] /collection/:collectionSlug",
    );
    expect(message).toContain(
      "productContext.featureInventory[1].entryPaths[0] /docs/[...slug]",
    );
    expect(message).toContain("concrete");
    expect(message).toContain("fixture slugs");
    expect(message).not.toContain("/home");
  });

  it("accepts concrete entry paths including hash routes and queries", () => {
    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: {},
        preparationManifest: manifestWithFeatures([
          {
            entryPaths: [
              "/collection/demo-collection",
              "/#/editor",
              "/search?q=knowledge",
            ],
            id: "browse",
            label: "Browse",
          },
        ]),
        repoSourcePaths: new Set(["README.md", "src/routes.tsx"]),
      }),
    ).not.toThrow();
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
        expectedProof: { kind: "visible-text", text: "Published demo article" },
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

  it("does not let a root browser candidate claim selected-app evidence", () => {
    const preparationManifest = manifestWithFeatures([
      {
        id: "landing-page",
        label: "Landing page",
        sourcePaths: ["apps/dashboard/src/app/page.tsx"],
      },
    ]);
    preparationManifest.appDir = "apps/dashboard";
    preparationManifest.productContext.evidencePaths = [
      "apps/dashboard/src/app/page.tsx",
    ];
    const profile = multiAppProfile();
    profile.browserRuntimeCandidates = [
      {
        dir: ".",
        evidencePaths: ["index.html"],
        frameworks: ["vite"],
        ports: [5173],
        scripts: { dev: "vite" },
      },
      ...(profile.browserRuntimeCandidates ?? []).filter(
        (candidate) => candidate.dir === "apps/dashboard",
      ),
    ];

    expect(() =>
      assertPreparedFeatureInventory({
        demoBrief: { keyProductFeatures: [] },
        preparationManifest,
        repoProfile: profile,
        repoSourcePaths: new Set(["apps/dashboard/src/app/page.tsx"]),
        runPlan: dashboardRunPlan(),
      }),
    ).not.toThrow();
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
    description?: string;
    entryPaths?: string[];
    expectedProof?: PreparationManifest["productContext"]["featureInventory"][number]["expectedProof"];
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
      featureInventory: features.map(({ expectedProof, ...feature }) => ({
        authStrategy: "none",
        description: `Demonstrate ${feature.label}`,
        entryPaths: ["/"],
        fixtureNotes: [],
        sourcePaths: ["src/routes.tsx"],
        ...feature,
        ...(expectedProof === undefined ? {} : { expectedProof }),
      })),
      name: "Conduit",
      summary: "A publishing platform.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "npm start",
  };
}

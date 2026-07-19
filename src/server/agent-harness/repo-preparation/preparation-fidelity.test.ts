import { describe, expect, it } from "vitest";
import type { PreparationManifest } from "../schemas/artifacts";
import { validatePreparationFidelity } from "./preparation-fidelity";

const routePath = "apps/dashboard/src/app/tracker/page.tsx";

describe("validatePreparationFidelity", () => {
  it("rejects a standalone replacement runtime for an existing product", () => {
    const report = validateDiff({
      createdFiles: ["demo/server.ts"],
      modifiedFiles: ["package.json", "bun.lock"],
      patch: [
        "diff --git a/demo/server.ts b/demo/server.ts",
        "new file mode 100644",
        "+Bun.serve({ fetch() { return new Response(`<!doctype html><style>body{font-family:Arial}</style>`); } });",
        "diff --git a/package.json b/package.json",
        '-  "workspaces": ["apps/*"],',
        '+  "scripts": { "dev": "bun run demo/server.ts" }',
      ].join("\n"),
    });

    expect(report).toMatchObject({
      failureClassification: "product fidelity violation",
      stage: "preparation-fidelity",
      status: "failed",
    });
    expect(report.logsSummary).toContain("demo/server.ts");
  });

  it("rejects preparation changes to original product UI files", () => {
    const report = validateDiff({
      modifiedFiles: [routePath],
      patch: [
        `diff --git a/${routePath} b/${routePath}`,
        "-return <TrackerPage />;",
        "+return <main><h1>Projects at a glance</h1></main>;",
      ].join("\n"),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(routePath);
  });

  it("rejects changes to original feature logic outside integration seams", () => {
    const featurePath = "src/tracker.ts";
    const report = validateDiff({
      modifiedFiles: [featurePath],
      patch: `diff --git a/${featurePath} b/${featurePath}\n+export const projects = fixtures;`,
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(featurePath);
  });

  it("rejects changes to non-JavaScript backend feature logic", () => {
    const featurePath = "backend/billing/calculator.py";
    const report = validateDiff({
      modifiedFiles: [featurePath],
      patch: `diff --git a/${featurePath} b/${featurePath}\n+return demo_invoice_total`,
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(featurePath);
  });

  it("rejects newly authored replacement product routes", () => {
    const replacementPath = "src/pages/demo-dashboard.tsx";
    const report = validateDiff({
      createdFiles: [replacementPath],
      patch: `diff --git a/${replacementPath} b/${replacementPath}\n+export function DemoDashboard() { return <main>Tracker</main>; }`,
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(replacementPath);
  });

  it("rejects replacement UI hidden behind seam-like names or public directories", () => {
    const report = validateDiff({
      createdFiles: ["src/data-grid.tsx", "public/index.html"],
      modifiedFiles: ["src/components/data-grid.tsx"],
      patch: [
        "diff --git a/src/data-grid.tsx b/src/data-grid.tsx",
        "+export const DataGrid = () => <main>Replacement dashboard</main>;",
        "diff --git a/public/index.html b/public/index.html",
        "+<main>Replacement dashboard</main>",
        "diff --git a/src/components/data-grid.tsx b/src/components/data-grid.tsx",
        "-return <OriginalGrid />;",
        "+return <main>Replacement dashboard</main>;",
      ].join("\n"),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain("src/data-grid.tsx");
    expect(report.logsSummary).toContain("public/index.html");
    expect(report.logsSummary).toContain("src/components/data-grid.tsx");
  });

  it("rejects a replacement component hidden behind an API-like filename", () => {
    const replacementPath = "src/api-dashboard.tsx";
    const report = validateDiff({
      createdFiles: [replacementPath],
      patch: `diff --git a/${replacementPath} b/${replacementPath}\n+export const ApiDashboard = () => (<ReplacementDashboard />);`,
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(replacementPath);
  });

  it("allows deterministic auth, data, and vendored-asset adaptations", () => {
    const report = validateDiff({
      createdFiles: [
        "src/demo/fixtures/tracker-data.ts",
        "public/fonts/product.woff2",
      ],
      modifiedFiles: ["src/auth/session-provider.ts"],
      patch: [
        "diff --git a/src/auth/session-provider.ts b/src/auth/session-provider.ts",
        "+export const demoIdentity = localIdentity;",
        "diff --git a/src/demo/fixtures/tracker-data.ts b/src/demo/fixtures/tracker-data.ts",
        "+export const projects = [];",
        "diff --git a/public/fonts/product.woff2 b/public/fonts/product.woff2",
        "new file mode 100644",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });

  it("allows authentication and data adapters inside framework route trees", () => {
    const report = validateDiff({
      createdFiles: ["apps/dashboard/src/app/api/demo-session/route.ts"],
      modifiedFiles: [
        "apps/dashboard/src/proxy.ts",
        "apps/dashboard/src/trpc/client.tsx",
      ],
      patch: [
        "diff --git a/apps/dashboard/src/proxy.ts b/apps/dashboard/src/proxy.ts",
        "+if (process.env.MAKEADEMO_LOCAL_AUTH === '1') return demoSession(request);",
        "diff --git a/apps/dashboard/src/trpc/client.tsx b/apps/dashboard/src/trpc/client.tsx",
        "-const endpoint = getApiUrl();",
        "+const endpoint = process.env.MAKEADEMO_LOCAL_AUTH === '1' ? '/api/demo-session' : getApiUrl();",
        "diff --git a/apps/dashboard/src/app/api/demo-session/route.ts b/apps/dashboard/src/app/api/demo-session/route.ts",
        "+export const GET = () => Response.json({ user: { id: 'demo-user' } });",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });

  it("rejects executable source introduced by an install repair without blaming prior demo adaptations", () => {
    const authPath = "src/auth/session-provider.ts";
    const exportPath = "src/service/export.ts";
    const baselinePatch = `diff --git a/${authPath} b/${authPath}\n+export const demoIdentity = localIdentity;`;
    const report = validatePreparationFidelity({
      installRepairBaseline: workspaceDiff([authPath], baselinePatch),
      preparationManifest: manifest(),
      repoSourcePaths: new Set([authPath, exportPath, "package.json"]),
      workspaceDiff: workspaceDiff(
        [authPath, exportPath, "package.json"],
        [
          baselinePatch,
          `diff --git a/${exportPath} b/${exportPath}`,
          '+export const workbook = "replacement";',
          "diff --git a/package.json b/package.json",
          '+  "xlsx": "0.18.5"',
        ].join("\n"),
      ),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(exportPath);
    expect(report.logsSummary).not.toContain(
      `${authPath} was modified by dependency installation repair`,
    );
  });

  it("allows package commands for deterministic preparation seams", () => {
    const fixturePath = "src/demo/fixtures/seed.ts";
    const report = validateDiff({
      createdFiles: [fixturePath],
      modifiedFiles: ["package.json"],
      patch: [
        "diff --git a/package.json b/package.json",
        `+    "demo:seed": "bun run ${fixturePath}"`,
        `diff --git a/${fixturePath} b/${fixturePath}`,
        "+export const projects = [];",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });

  it("allows an original UI file to point an external asset at its vendored copy", () => {
    const uiPath = "src/App.tsx";
    const report = validateDiff({
      createdFiles: ["public/assets/logo.svg"],
      modifiedFiles: [uiPath],
      patch: [
        `diff --git a/${uiPath} b/${uiPath}`,
        '-  return <img src="https://cdn.example.com/logo.svg" alt="Product" />;',
        '+  return <img src="/assets/logo.svg" alt="Product" />;',
        "diff --git a/public/assets/logo.svg b/public/assets/logo.svg",
        "new file mode 100644",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });
});

function validateDiff(input: {
  createdFiles?: string[];
  modifiedFiles?: string[];
  patch: string;
}) {
  const createdFiles = input.createdFiles ?? [];
  const modifiedFiles = input.modifiedFiles ?? [];
  return validatePreparationFidelity({
    preparationManifest: manifest(),
    repoSourcePaths: new Set(["package.json", routePath, ...modifiedFiles]),
    workspaceDiff: workspaceDiff(
      [...createdFiles, ...modifiedFiles],
      input.patch,
    ),
  });
}

function workspaceDiff(changedPaths: string[], patch: string) {
  return {
    changedPaths: changedPaths.map((path) => `/workspace/repo/${path}`),
    patch,
    patchSha256: `sha256:${"a".repeat(64)}` as const,
    sourceCommitSha: "abc123",
  };
}

function manifest(
  overrides: Partial<PreparationManifest> = {},
): PreparationManifest {
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
      evidencePaths: [routePath],
      featureInventory: [
        {
          authStrategy: "bypass",
          description: "Track project time.",
          entryPaths: ["/tracker"],
          fixtureNotes: [],
          id: "tracker",
          label: "Tracker",
          sourcePaths: [routePath],
        },
      ],
      name: "Product",
      summary: "The original product.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun run dev",
    ...overrides,
  };
}

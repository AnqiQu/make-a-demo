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
      manifestOverrides: { envUsed: { MAKEADEMO_DEMO: "true" } },
      modifiedFiles: ["src/auth/session-provider.ts"],
      patch: [
        "diff --git a/src/auth/session-provider.ts b/src/auth/session-provider.ts",
        "+if (process.env.MAKEADEMO_DEMO === 'true') {",
        "+  return localIdentity;",
        "+}",
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
      manifestOverrides: { envUsed: { MAKEADEMO_DEMO: "true" } },
      patch: [
        "diff --git a/apps/dashboard/src/proxy.ts b/apps/dashboard/src/proxy.ts",
        "+if (process.env.MAKEADEMO_DEMO === 'true') return demoSession(request);",
        "diff --git a/apps/dashboard/src/trpc/client.tsx b/apps/dashboard/src/trpc/client.tsx",
        "-const endpoint = getApiUrl();",
        "+const endpoint = process.env.MAKEADEMO_DEMO === 'true' ? '/api/demo-session' : getApiUrl();",
        "diff --git a/apps/dashboard/src/app/api/demo-session/route.ts b/apps/dashboard/src/app/api/demo-session/route.ts",
        "+export const GET = () => Response.json({ user: { id: 'demo-user' } });",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });

  it("rejects server adapters that call back through the prepared app listener", () => {
    const serverPath = "apps/dashboard/src/server/trpc/context.ts";
    const report = validateDiff({
      manifestOverrides: { envUsed: { MAKEADEMO_DEMO: "true" } },
      modifiedFiles: [serverPath],
      patch: [
        `diff --git a/${serverPath} b/${serverPath}`,
        "+if (process.env.MAKEADEMO_DEMO === 'true') {",
        "+  return fetch('http://localhost:3000/api/demo-session');",
        "+}",
      ].join("\n"),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain("calls back through its own listener");
  });

  it("allows one shared demo gate to guard multiline auth and integration adaptations", () => {
    const gatePath = "apps/dashboard/src/demo.ts";
    const layoutPath = "apps/dashboard/src/app/(app)/layout.tsx";
    const clientPath = "apps/dashboard/src/trpc/client.tsx";
    const report = validateDiff({
      createdFiles: [gatePath],
      manifestOverrides: { envUsed: { NEXT_PUBLIC_MAKEADEMO_DEMO: "true" } },
      modifiedFiles: [layoutPath, clientPath],
      patch: [
        `diff --git a/${gatePath} b/${gatePath}`,
        "+export const isDemoMode = process.env.NEXT_PUBLIC_MAKEADEMO_DEMO === 'true';",
        `diff --git a/${layoutPath} b/${layoutPath}`,
        "+import { isDemoMode } from '../../demo';",
        "-if (!user) redirect('/login');",
        "+if (!isDemoMode && !user) redirect('/login');",
        `diff --git a/${clientPath} b/${clientPath}`,
        "+import { isDemoMode } from '../demo';",
        "-const client = createRemoteClient();",
        "+const client =",
        "+  isDemoMode",
        "+    ? createFixtureClient()",
        "+    : createRemoteClient();",
      ].join("\n"),
    });

    expect(report.status).toBe("passed");
  });

  it("allows a modified seam to use a demo gate from screened source", () => {
    const gatePath = "src/config/demo-mode.ts";
    const sessionPath = "src/auth/session.ts";
    const report = validateDiff({
      manifestOverrides: { envUsed: { MAKEADEMO_DEMO: "true" } },
      modifiedFiles: [sessionPath],
      patch: [
        `diff --git a/${sessionPath} b/${sessionPath}`,
        "+import { isDemoMode } from '../config/demo-mode';",
        "-if (!session) redirect('/login');",
        "+if (!isDemoMode && !session) redirect('/login');",
      ].join("\n"),
      sourceFiles: {
        [gatePath]:
          "export const isDemoMode = process.env.MAKEADEMO_DEMO === 'true';",
      },
    });

    expect(report.status).toBe("passed");
  });

  it("allows a guarded adapter selection in a generic composition root", () => {
    const bootstrapPath = "src/bootstrap.ts";
    const report = validateDemoDiff(bootstrapPath, [
      "-const projectsClient = createRemoteClient();",
      "+const projectsClient = runtimeConfig.MAKEADEMO_DEMO === 'true' ? createFixtureClient() : createRemoteClient();",
    ]);

    expect(report.status).toBe("passed");
  });

  it("allows an active demo-gated identity adapter without a seam-like filename", () => {
    const providerPath = "packages/supabase/src/client/server.ts";
    const report = validateDemoDiff(providerPath, [
      "+if (process.env.MAKEADEMO_DEMO === 'true') {",
      "+  return { auth: {",
      "+    getUser: async () => ({ data: { user: { id: 'demo-user' } }, error: null }),",
      "+    getSession: async () => ({ data: { session: { user: { id: 'demo-user' } } }, error: null }),",
      "+  } };",
      "+}",
    ]);

    expect(report.status).toBe("passed");
  });

  it("allows a demo-gated authentication guard without changing layout presentation", () => {
    const layoutPath = "apps/dashboard/src/app/(app)/layout.tsx";
    const report = validateDemoDiff(layoutPath, [
      "+const demoMode = process.env.MAKEADEMO_DEMO === 'true';",
      "-if (!user) redirect('/login');",
      "+if (!demoMode && !user) redirect('/login');",
    ]);

    expect(report.status).toBe("passed");
  });

  it("allows an additive demo branch before an unchanged authentication guard", () => {
    const routePath = "src/routes/dashboard.ts";
    const report = validateDemoDiff(routePath, [
      "+if (process.env.MAKEADEMO_DEMO === 'true') return renderDashboard();",
      " const session = await currentSession();",
      " if (!session) redirect('/login');",
    ]);

    expect(report.status).toBe("passed");
  });

  it("allows a framework-prefixed demo flag directly in an authentication guard", () => {
    const routerPath = "src/router.ts";
    const report = validateDemoDiff(
      routerPath,
      [
        "-if (!session) redirect('/login');",
        "+if (import.meta.env.VITE_MAKEADEMO_DEMO !== 'true' && !session) redirect('/login');",
      ],
      "VITE_MAKEADEMO_DEMO",
    );

    expect(report.status).toBe("passed");
  });

  it.each([
    {
      changes: [
        "+if os.getenv('MAKEADEMO_DEMO') == 'true':",
        "+    return demo_projects",
        " return load_projects(database)",
      ],
      path: "backend/repositories/projects.py",
    },
    {
      changes: [
        '+if os.Getenv("MAKEADEMO_DEMO") == "true" {',
        "+  return demoProjects()",
        "+}",
        " return loadProjects(client)",
      ],
      path: "internal/clients/projects.go",
    },
    {
      changes: [
        "+if ENV['MAKEADEMO_DEMO'] == 'true'",
        "+  return demo_user",
        "+end",
        " return current_user",
      ],
      path: "app/providers/current_user.rb",
    },
    {
      changes: [
        '+if [ "${MAKEADEMO_DEMO}" = "true" ]; then',
        "+  export API_URL=http://127.0.0.1:3000/api/fixtures",
        "+fi",
      ],
      path: "scripts/configure-service.sh",
    },
  ])("allows an additive guarded adapter in $path", ({ changes, path }) => {
    expect(validateDemoDiff(path, changes).status).toBe("passed");
  });

  it("recognizes a guarded current-user branch in a route as authentication", () => {
    const routePath = "app/routes/account.py";
    const report = validateDemoDiff(routePath, [
      "+if os.getenv('MAKEADEMO_DEMO') == 'true':",
      "+    return account_view()",
      " if current_user is None: abort(401)",
    ]);

    expect(report.status).toBe("passed");
  });

  it("allows a Python authentication guard extension that preserves its off path", () => {
    const routePath = "app/routes/account.py";
    const report = validateDemoDiff(routePath, [
      "+demo_mode = os.getenv('MAKEADEMO_DEMO') == 'true'",
      "-if current_user is None: abort(401)",
      "+if not demo_mode and current_user is None: abort(401)",
    ]);

    expect(report.status).toBe("passed");
  });

  it("rejects an authentication replacement that is not demo-gated", () => {
    const providerPath = "packages/identity/src/client/server.ts";
    const report = validateDemoDiff(providerPath, [
      "-return createIdentityClient(request);",
      "+return { auth: { getUser: async () => null } };",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      `${providerPath} changes authentication behavior without an active MakeADemo demo flag recorded in envUsed.`,
    );
    expect(report.suggestedRepairHints).toContainEqual(
      expect.stringContaining("MAKEADEMO_DEMO"),
    );
  });

  it("rejects an ungated authentication replacement inside an integration seam", () => {
    const sessionPath = "src/auth/session-provider.ts";
    const report = validateDiff({
      modifiedFiles: [sessionPath],
      patch: [
        `diff --git a/${sessionPath} b/${sessionPath}`,
        "-return loadSession(request);",
        "+return createDemoSession();",
      ].join("\n"),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      `${sessionPath} changes authentication behavior without an active MakeADemo demo flag recorded in envUsed.`,
    );
  });

  it("rejects an active demo flag that does not guard the authentication adaptation", () => {
    const sessionPath = "src/auth/session.ts";
    const report = validateDemoDiff(sessionPath, [
      "+const configuredFlag = process.env.MAKEADEMO_DEMO;",
      "+return createDemoSession();",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      `${sessionPath} does not conditionally use the repository's active MakeADemo demo gate for the authentication adaptation.`,
    );
  });

  it("does not treat a demo-flag string literal as an active guard", () => {
    const clientPath = "src/clients/projects.ts";
    const report = validateDemoDiff(clientPath, [
      "-const client = createRemoteClient();",
      "+const client = 'MAKEADEMO_DEMO' ? createFixtureClient() : createRemoteClient();",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      `${clientPath} changes integration behavior without an active MakeADemo demo flag recorded in envUsed.`,
    );
  });

  it("rejects an ungated data replacement inside an integration seam", () => {
    const repositoryPath = "backend/repositories/projects.py";
    const report = validateDiff({
      modifiedFiles: [repositoryPath],
      patch: [
        `diff --git a/${repositoryPath} b/${repositoryPath}`,
        "-return load_projects(database)",
        "+return demo_projects",
      ].join("\n"),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      `${repositoryPath} changes integration behavior without an active MakeADemo demo flag recorded in envUsed.`,
    );
  });

  it("rejects a demo flag declared beside a destructive authentication guard change", () => {
    const layoutPath = "apps/dashboard/src/app/(app)/layout.tsx";
    const report = validateDemoDiff(layoutPath, [
      "+const demoMode = process.env.MAKEADEMO_DEMO === 'true';",
      "-if (!user) redirect('/login');",
      "+if (user) redirect('/login');",
    ]);

    expect(report.status).toBe("failed");
  });

  it("rejects demo-gated authentication changes that replace visible UI", () => {
    const layoutPath = "apps/dashboard/src/app/(app)/layout.tsx";
    const report = validateDemoDiff(layoutPath, [
      "+const demoMode = process.env.MAKEADEMO_DEMO === 'true';",
      "-return <ProductLayout>{children}</ProductLayout>;",
      "+return demoMode ? <main>Demo dashboard</main> : <ProductLayout>{children}</ProductLayout>;",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(layoutPath);
  });

  it("does not treat demo-gated styling as an authentication seam", () => {
    const stylePath = "apps/dashboard/src/app/globals.css";
    const report = validateDemoDiff(stylePath, [
      "+/* MAKEADEMO_DEMO auth bypass */",
      "+.authentication-screen { display: none; }",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(stylePath);
  });

  it("does not mistake ordinary author data for authentication behavior", () => {
    const featurePath = "src/article.ts";
    const report = validateDemoDiff(featurePath, [
      "+if (process.env.MAKEADEMO_DEMO === 'true') return demoAuthor;",
    ]);

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(featurePath);
  });

  it("rejects executable source introduced by an install repair without blaming prior demo adaptations", () => {
    const authPath = "src/auth/session-provider.ts";
    const exportPath = "src/service/export.ts";
    const baselinePatch = [
      `diff --git a/${authPath} b/${authPath}`,
      "+if (process.env.MAKEADEMO_DEMO === 'true') return localIdentity;",
    ].join("\n");
    const report = validatePreparationFidelity({
      dependencyRepair: true,
      repairBaseline: workspaceDiff([authPath], baselinePatch),
      preparationManifest: manifest({
        envUsed: { MAKEADEMO_DEMO: "true" },
      }),
      repoSourceFiles: new Map<string, string>(
        [authPath, exportPath, "package.json"].map(
          (path) => [path, ""] as const,
        ),
      ),
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
    expect(report.logsSummary).not.toContain(authPath);
  });

  it("compares install-repair source by content instead of patch formatting", () => {
    const fixturePath = "src/auth/session.ts";
    const digest = `sha256:${"d".repeat(64)}` as const;
    const addition =
      "+if (process.env.MAKEADEMO_DEMO === 'true') return demoIdentity;";
    const baseline = workspaceDiff(
      [fixturePath],
      `diff --git a/${fixturePath} b/${fixturePath}\n${addition}`,
      { [fixturePath]: digest },
    );
    const reformatted = workspaceDiff(
      [fixturePath],
      `diff --git a/${fixturePath} b/${fixturePath}\n@@ -1 +1 @@\n${addition}`,
      { [fixturePath]: digest },
    );
    const changed = workspaceDiff([fixturePath], reformatted.patch, {
      [fixturePath]: `sha256:${"e".repeat(64)}`,
    });
    const input = {
      dependencyRepair: true,
      repairBaseline: baseline,
      preparationManifest: manifest({
        envUsed: { MAKEADEMO_DEMO: "true" },
      }),
      repoSourceFiles: new Map([[fixturePath, ""]]),
    };

    expect(
      validatePreparationFidelity({ ...input, workspaceDiff: reformatted })
        .status,
    ).toBe("passed");
    expect(
      validatePreparationFidelity({ ...input, workspaceDiff: changed }).status,
    ).toBe("failed");
  });

  it("rejects lockfiles edited by a dependency repair agent", () => {
    const lockfile = "bun.lock";
    const report = validatePreparationFidelity({
      dependencyRepair: true,
      repairBaseline: workspaceDiff([], ""),
      preparationManifest: manifest(),
      repoSourceFiles: new Map([
        ["package.json", "{}"],
        [lockfile, "lockfileVersion = 1"],
      ]),
      workspaceDiff: workspaceDiff(
        [lockfile],
        `diff --git a/${lockfile} b/${lockfile}\n+invalid manual entry`,
      ),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      "lockfiles must be generated by the backend package manager",
    );
  });

  it("rejects lockfiles edited by any repair agent", () => {
    const lockfile = "pnpm-lock.yaml";
    const report = validatePreparationFidelity({
      repairBaseline: workspaceDiff([], ""),
      preparationManifest: manifest(),
      repoSourceFiles: new Map([
        ["package.json", "{}"],
        [lockfile, "lockfileVersion: 9"],
      ]),
      workspaceDiff: workspaceDiff(
        [lockfile],
        `diff --git a/${lockfile} b/${lockfile}\n+packages: {}`,
      ),
    });

    expect(report.status).toBe("failed");
    expect(report.logsSummary).toContain(
      "lockfiles must be generated by the backend package manager",
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

function validateDemoDiff(
  path: string,
  changes: string[],
  flag = "MAKEADEMO_DEMO",
) {
  return validateDiff({
    manifestOverrides: { envUsed: { [flag]: "true" } },
    modifiedFiles: [path],
    patch: [`diff --git a/${path} b/${path}`, ...changes].join("\n"),
  });
}

function validateDiff(input: {
  createdFiles?: string[];
  manifestOverrides?: Partial<PreparationManifest>;
  modifiedFiles?: string[];
  patch: string;
  sourceFiles?: Record<string, string>;
}) {
  const createdFiles = input.createdFiles ?? [];
  const modifiedFiles = input.modifiedFiles ?? [];
  const repoSourceFiles = new Map<string, string>(
    ["package.json", routePath, ...modifiedFiles].map(
      (path) => [path, input.sourceFiles?.[path] ?? ""] as const,
    ),
  );
  for (const [path, source] of Object.entries(input.sourceFiles ?? {})) {
    repoSourceFiles.set(path, source);
  }
  return validatePreparationFidelity({
    preparationManifest: manifest(input.manifestOverrides),
    repoSourceFiles,
    workspaceDiff: workspaceDiff(
      [...createdFiles, ...modifiedFiles],
      input.patch,
    ),
  });
}

function workspaceDiff(
  changedPaths: string[],
  patch: string,
  changedFileSha256: Record<
    string,
    `sha256:${string}` | null
  > = Object.fromEntries(
    changedPaths.map((path) => [path, `sha256:${"a".repeat(64)}` as const]),
  ),
) {
  return {
    changedFileSha256,
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

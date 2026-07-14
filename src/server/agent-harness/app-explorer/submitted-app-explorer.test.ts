import { describe, expect, it } from "vitest";
import type { PreparedDemoFeature } from "../schemas/artifacts";
import { exploreSubmittedApp } from "./submitted-app-explorer";

const baseUrl = "http://127.0.0.1:3000";

describe("exploreSubmittedApp", () => {
  it("grounds routes and actions in submitted-code browser evidence", async () => {
    const { commands, result } = await exploreObservation({
      routes: [
        observedRoute({
          buttons: ["Open dashboard"],
          headings: ["Welcome"],
          inputLocators: [
            {
              controlKind: "fill",
              locator: { strategy: "placeholder", value: "Search" },
              name: "Search",
            },
          ],
          inputs: ["Search"],
          links: [
            {
              href: "/dashboard",
              locatorEvidence: {
                locator: {
                  exact: false,
                  name: "Dashboard",
                  role: "link",
                  strategy: "role",
                },
                observedAccessibleName: "Dashboard Open the project dashboard",
                verification: {
                  matchCount: 1,
                  route: "/",
                  targetHref: "/dashboard",
                  visible: true,
                },
              },
              name: "Dashboard",
            },
          ],
          primaryNavigation: ["Dashboard"],
          text: ["Welcome", "Build something great", "Sign in to comment"],
          title: "Example App",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(
      'NODE_PATH="$(npm root -g)" bun /workspace/.makeademo/exploration/explore-app.mjs',
    );
    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.appMap).toMatchObject({
      baseUrl,
      candidateFlows: expect.arrayContaining(["Search"]),
      discoveredRoutes: [
        expect.objectContaining({ path: "/", title: "Example App" }),
      ],
      loginOrAuthWalls: [],
      stableLocatorCandidates: expect.arrayContaining(['placeholder="Search"']),
    });
    expect(artifacts.actionCatalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "click" }),
        expect.objectContaining({ kind: "assert" }),
        expect.objectContaining({ kind: "fill" }),
        expect.objectContaining({ kind: "navigate", route: "/" }),
        expect.objectContaining({
          id: "click-link-1-1",
          locatorCandidates: [
            expect.objectContaining({
              observedAccessibleName: "Dashboard Open the project dashboard",
              verification: expect.objectContaining({
                targetHref: "/dashboard",
              }),
            }),
          ],
          preferredLocatorCandidateId: "click-link-1-1-locator-1",
        }),
      ]),
    );
  });

  it("prioritizes prepared feature entry routes and tags their evidence", async () => {
    const { commands, result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      routes: [
        observedRoute({
          buttons: ["Publish Article"],
          featureIds: ["post-article"],
          forms: ["editor"],
          headings: ["New Article"],
          inputs: ["Article Title"],
          path: "/#/editor",
          requestedPath: "/#/editor",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(readExplorerScript(commands)).toContain("/#/editor");
    expect(artifacts.appMap.discoveredRoutes[0]).toMatchObject({
      featureIds: ["post-article"],
      path: "/#/editor",
    });
    expect(artifacts.actionCatalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureIds: ["post-article"],
          kind: "click",
          route: "/#/editor",
        }),
      ]),
    );
  });

  it("routes a protected feature login wall back to Repo Preparation", async () => {
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature({ authStrategy: "bypass" })],
      routes: [
        observedRoute({
          buttons: ["Sign in"],
          featureIds: ["post-article"],
          forms: ["login"],
          headings: ["Sign in"],
          inputs: ["Email", "Password"],
          path: "/#/editor",
          requestedPath: "/#/editor",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "feature auth barrier",
      logsSummary: expect.stringContaining("posting an article"),
      status: "failed",
    });
  });

  it("keeps a login form observable when signing in is requested", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          authStrategy: "demo-identity",
          description: "Sign in with the deterministic demo identity.",
          entryPaths: ["/#/login"],
          fixtureNotes: ["Use demo@example.com"],
          id: "sign-in",
          label: "Signing in",
          requestedFeature: "signing in",
          sourcePaths: ["src/login.tsx"],
        }),
      ],
      routes: [
        observedRoute({
          buttons: ["Sign in"],
          featureIds: ["sign-in"],
          forms: ["login"],
          headings: ["Sign in"],
          inputs: ["Email", "Password"],
          path: "/#/login",
          requestedPath: "/#/login",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "none",
      status: "passed",
    });
  });

  it("fails when a requested feature has no browser evidence", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Demonstrate Dashboard",
          entryPaths: ["/"],
          id: "dashboard",
          label: "Dashboard",
          requestedFeature: "dashboard",
        }),
        preparedFeature({
          description: "Demonstrate Reporting",
          entryPaths: ["/reports"],
          id: "reporting",
          label: "Reporting",
          requestedFeature: "reporting",
        }),
      ],
      routes: [
        observedRoute({
          buttons: ["Open dashboard"],
          featureIds: ["dashboard"],
          headings: ["Dashboard"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      logsSummary: expect.stringContaining("reporting"),
      status: "failed",
    });
  });

  it("grounds scrolling when the prepared page has scrollable content", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          headings: ["Global Feed"],
          scrollTargets: [
            {
              locator: {
                reason: "The document scroll root has no semantic locator.",
                strategy: "css",
                value: "html",
              },
              locatorEvidence: {
                locator: { strategy: "css", value: "html" },
                verification: { matchCount: 1, route: "/", visible: true },
              },
              name: "Global Feed",
              position: "bottom",
            },
          ],
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "scroll",
        preferredLocator: {
          reason: "The document scroll root has no semantic locator.",
          strategy: "css",
          value: "html",
        },
        route: "/",
      }),
    );
  });

  it("reports unique attempted external resources with page errors", async () => {
    const { result } = await exploreObservation({
      blockedNetworkAttempts: [
        {
          host: "api.example.com",
          method: "GET",
          resourceType: "fetch",
          url: "https://api.example.com/v1",
        },
        {
          host: "api.example.com",
          method: "GET",
          resourceType: "fetch",
          url: "https://api.example.com/v1",
        },
      ],
      pageErrors: [`${baseUrl}/: render failed`],
      routes: [observedRoute({ headings: ["Welcome"], text: ["Welcome"] })],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport).toMatchObject({
      failureClassification: "external network attempted",
      blockedNetworkAttempts: [
        expect.objectContaining({ url: "https://api.example.com/v1" }),
      ],
      status: "failed",
    });
    expect(artifacts.validationReport.logsSummary).toContain(
      "1 required external browser resource",
    );
    expect(artifacts.validationReport.logsSummary).toContain("1 page error");
  });

  it("keeps blocked side effects as evidence when the feature remains observable", async () => {
    const feature = preparedFeature();
    const { result } = await exploreObservation({
      blockedNetworkAttempts: [
        {
          host: "analytics.example.com",
          method: "POST",
          resourceType: "fetch",
          url: "https://analytics.example.com/events",
        },
      ],
      consoleErrors: [`${baseUrl}/: net::ERR_BLOCKED_BY_CLIENT`],
      featureInventory: [feature],
      routes: [
        observedRoute({
          buttons: ["Open global feed"],
          featureIds: [feature.id],
          headings: ["Global Feed"],
          text: ["Global Feed"],
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport).toMatchObject({
      blockedNetworkAttempts: [
        expect.objectContaining({ host: "analytics.example.com" }),
      ],
      failureClassification: "none",
      status: "passed",
    });
  });

  it("uses visible text as assertion evidence when a route has no heading", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          headings: [],
          path: "/products",
          text: ["Product list"],
          title: "Products",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: { strategy: "text", value: "Product list" },
        route: "/products",
      }),
    );
  });

  it("uses a control as assertion evidence when text is unavailable", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          buttons: ["Create project"],
          headings: [],
          path: "/projects",
          title: "Projects",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: {
          name: "Create project",
          strategy: "role",
          value: "button",
        },
        route: "/projects",
      }),
    );
  });

  it("returns a repairable report when no routes are discovered", async () => {
    const { result } = await exploreObservation({ routes: [] });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "app route not discoverable",
        stage: "app-exploration",
        status: "failed",
        urlChecked: baseUrl,
      },
    });
  });
});

type ExplorationResult = Awaited<ReturnType<typeof exploreSubmittedApp>>;

async function exploreObservation(input: {
  blockedNetworkAttempts?: Array<{
    host: string;
    method?: string;
    resourceType?: string;
    url?: string;
  }>;
  consoleErrors?: string[];
  featureInventory?: PreparedDemoFeature[];
  pageErrors?: string[];
  routes: Array<Record<string, unknown>>;
}) {
  const commands: string[] = [];
  const result = await exploreSubmittedApp({
    baseUrl,
    ...(input.featureInventory === undefined
      ? {}
      : { featureInventory: input.featureInventory }),
    preparationManifestId: "prep_001",
    workspace: {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            blockedNetworkAttempts: input.blockedNetworkAttempts ?? [],
            consoleErrors: input.consoleErrors ?? [],
            pageErrors: input.pageErrors ?? [],
            routes: input.routes,
          }),
        };
      },
    },
  });
  return { commands, result };
}

function observedRoute(overrides: Record<string, unknown> = {}) {
  return {
    buttons: [],
    forms: [],
    headings: [],
    inputs: [],
    links: [],
    path: "/",
    primaryNavigation: [],
    screenshot: "/workspace/.makeademo/exploration/route.png",
    snapshot: "/workspace/.makeademo/exploration/route.aria.yml",
    text: [],
    title: "Conduit",
    ...overrides,
  };
}

function preparedFeature(
  overrides: Partial<PreparedDemoFeature> = {},
): PreparedDemoFeature {
  return {
    authStrategy: "demo-identity",
    description: "Publish a new article.",
    entryPaths: ["/#/editor"],
    fixtureNotes: [],
    id: "post-article",
    label: "Posting an article",
    requestedFeature: "posting an article",
    sourcePaths: ["src/editor.tsx"],
    ...overrides,
  };
}

function requireArtifacts(
  result: ExplorationResult,
): Extract<ExplorationResult, { kind: "artifacts" }> {
  expect(result.kind).toBe("artifacts");
  if (result.kind !== "artifacts") {
    throw new Error("Expected exploration artifacts");
  }
  return result;
}

function readExplorerScript(commands: string[]): string {
  const encodedScript = /printf %s '([^']+)'/.exec(commands[0] ?? "")?.[1];
  expect(encodedScript).toBeDefined();
  return Buffer.from(encodedScript ?? "", "base64").toString("utf8");
}

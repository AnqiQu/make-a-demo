import { describe, expect, it } from "vitest";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessWorkspace,
} from "../daytona/workspace.interface";
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
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search" },
              name: "Search",
              outcome: "Search contained the observed demo value",
            },
          ],
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
    expect(readExplorerScript(commands)).toContain(
      "await interactionLocator.click",
    );
    expect(readExplorerScript(commands)).toContain("observed.interactions");
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

  it("bounds browser work and stops crawling when the prepared app exits", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("Math.min(observed.buttons.length, 8)");
    expect(script).toContain("observed.inputLocators.slice(0, 6)");
    expect(script).toContain("if (isAppUnavailableError(error)) throw error");
    expect(script).toContain("if (isAppUnavailableError(error)) break");
  });

  it("gives first route loads a cold-start budget with one retry", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("const gotoRoute = async (url) =>");
    expect(script).toContain("timeout: 60000");
    expect(script).toContain('document.readyState === "complete"');
    expect(script).not.toContain("waitForTimeout(500)");
  });

  it("verifies unique locators without coupling evidence to DOM indexes", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain(
      "const ariaSnapshot = await candidateLocator.ariaSnapshot()",
    );
    expect(script).not.toContain("visibleButtons.nth(index)");
    expect(script).not.toContain("visibleInputs.nth(index)");
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
          interactions: [
            {
              kind: "click",
              name: "Publish Article",
              outcome: "Published article confirmation became visible",
            },
          ],
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

  it("grounds controls to the matching feature when several features share one route", async () => {
    const invoice = preparedFeature({
      description: "Create an invoice for a customer.",
      entryPaths: ["/"],
      id: "create-invoice",
      label: "Creating invoices",
      requestedFeature: "creating invoices",
    });
    const teammate = preparedFeature({
      description: "Invite a teammate to the workspace.",
      entryPaths: ["/"],
      id: "invite-teammate",
      label: "Inviting teammates",
      requestedFeature: "inviting teammates",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoice, teammate],
      routes: [
        observedRoute({
          buttons: ["Create invoice", "Invite teammate"],
          featureIds: [invoice.id, teammate.id],
          headings: ["Workspace"],
          interactions: [
            {
              kind: "click",
              name: "Create invoice",
              outcome: "New invoice form became visible",
            },
            {
              kind: "click",
              name: "Invite teammate",
              outcome: "Invite teammate dialog became visible",
            },
          ],
        }),
      ],
    });
    const actions = requireArtifacts(result).actionCatalog.actions;

    expect(
      actions.find((action) => action.kind === "navigate")?.featureIds,
    ).toEqual([invoice.id, teammate.id]);
    expect(
      actions.find(
        (action) =>
          action.kind === "click" &&
          action.preferredLocator.name === "Create invoice",
      )?.featureIds,
    ).toEqual([invoice.id]);
    expect(
      actions.find(
        (action) =>
          action.kind === "click" &&
          action.preferredLocator.name === "Invite teammate",
      )?.featureIds,
    ).toEqual([teammate.id]);
  });

  it("catalogs only exercised controls and preserves their observed visible outcome", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          buttons: ["Open settings", "Delete account"],
          headings: ["Account"],
          interactions: [
            {
              kind: "click",
              name: "Open settings",
              outcome: "Settings dialog became visible",
            },
          ],
        }),
      ],
    });
    const clickActions = requireArtifacts(result).actionCatalog.actions.filter(
      (action) => action.kind === "click",
    );

    expect(clickActions).toEqual([
      expect.objectContaining({
        evidence: expect.stringContaining("Playwright exercised"),
        exercised: true,
        expectedResult: "Settings dialog became visible",
        preferredLocator: expect.objectContaining({ name: "Open settings" }),
      }),
    ]);
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

  it("recognizes an OAuth-only redirect as a protected feature auth wall", async () => {
    const invoice = preparedFeature({
      authStrategy: "bypass",
      entryPaths: ["/invoices"],
      id: "invoices",
      label: "Invoice management",
      requestedFeature: "invoice management",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoice],
      routes: [
        observedRoute({
          buttons: [],
          featureIds: [invoice.id],
          headings: ["Welcome to Product"],
          links: [
            {
              href: "https://accounts.google.com/o/oauth2/auth",
              name: "Continue with Google",
              sameOrigin: false,
            },
          ],
          path: "/login?return_to=invoices",
          requestedPath: "/invoices",
          title: "Welcome | Product",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "feature auth barrier",
      logsSummary: expect.stringContaining("invoice management"),
      status: "failed",
    });
    expect(
      requireArtifacts(result).actionCatalog.actions.some((action) =>
        action.featureIds?.includes(invoice.id),
      ),
    ).toBe(false);
  });

  it("keeps registration observable when account creation is requested", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          authStrategy: "demo-identity",
          description: "Create the deterministic demo identity.",
          entryPaths: ["/#/signup"],
          fixtureNotes: ["Use demo@example.com"],
          id: "create-account",
          label: "Creating an account",
          requestedFeature: "creating an account",
          sourcePaths: ["src/login.tsx"],
        }),
      ],
      requestedFeatures: ["creating an account"],
      routes: [
        observedRoute({
          buttons: ["Create account"],
          featureIds: ["create-account"],
          forms: ["registration"],
          headings: ["Create account"],
          inputs: ["Email", "Password"],
          path: "/#/signup",
          requestedPath: "/#/signup",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "none",
      status: "passed",
    });
  });

  it("does not promote authentication into a default demo feature", async () => {
    const signIn = preparedFeature({
      authStrategy: "demo-identity",
      description: "Sign in to the product.",
      entryPaths: ["/login"],
      id: "sign-in",
      label: "Signing in",
      requestedFeature: "signing in",
      sourcePaths: ["src/login.tsx"],
    });
    const { result } = await exploreObservation({
      featureInventory: [signIn],
      routes: [
        observedRoute({
          buttons: ["Continue"],
          featureIds: [signIn.id],
          headings: ["Welcome back"],
          inputs: ["Work email"],
          path: "/auth",
          requestedPath: "/auth",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "feature auth barrier",
      status: "failed",
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

  it("keeps unrelated browser errors as evidence when features remain observable", async () => {
    const { result } = await exploreObservation({
      blockedNetworkAttempts: [
        {
          host: "api.example.com",
          method: "GET",
          resourceType: "fetch",
          url: "https://api.example.com/v1",
        },
      ],
      consoleErrors: [`${baseUrl}/legal: Failed to load chunk /_next/x.js`],
      pageErrors: [`${baseUrl}/legal: render failed`],
      routes: [observedRoute({ headings: ["Welcome"], text: ["Welcome"] })],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport).toMatchObject({
      failureClassification: "none",
      blockedNetworkAttempts: [
        expect.objectContaining({ url: "https://api.example.com/v1" }),
      ],
      pageErrors: [`${baseUrl}/legal: render failed`],
      status: "passed",
    });
  });

  it("names the unreachable feature entry route instead of a generic missing feature", async () => {
    const feature = preparedFeature();
    const { result } = await exploreObservation({
      featureInventory: [feature],
      routes: [observedRoute()],
      unreachableRoutes: [
        {
          error: "goto: net::ERR_ABORTED at /#/editor",
          featureIds: [feature.id],
          url: `${baseUrl}/#/editor`,
        },
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport).toMatchObject({
      failureClassification: "app route not discoverable",
      status: "failed",
    });
    expect(artifacts.validationReport.logsSummary).toContain("/#/editor");
    expect(artifacts.validationReport.logsSummary).toContain("ERR_ABORTED");
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

  it("recovers exploration results from the durable file when stdout is corrupted", async () => {
    const protocol = JSON.stringify({
      blockedNetworkAttempts: [],
      consoleErrors: [],
      pageErrors: [],
      routes: [observedRoute({ headings: ["Dashboard"] })],
      unreachableRoutes: [],
    });
    const result = await exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          return command.includes("exploration.json")
            ? { exitCode: 0, stderr: "", stdout: protocol }
            : {
                exitCode: 0,
                stderr: "",
                stdout: '[makeademo:exploration] {"routes": [tru',
              };
        },
      },
    });

    expect(requireArtifacts(result).appMap.discoveredRoutes[0]).toMatchObject({
      headings: ["Dashboard"],
    });
  });

  it("returns a repairable failure instead of throwing when the explorer crashes", async () => {
    const result = await exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          return command.includes("exploration.json")
            ? { exitCode: 1, stderr: "cat: no such file", stdout: "" }
            : {
                exitCode: 1,
                stderr: `SyntaxError: unexpected token\n${"x".repeat(10_000)}`,
                stdout: "",
              };
        },
      },
    });

    expect(result.kind).toBe("repairable-failure");
    if (result.kind !== "repairable-failure") throw new Error("unexpected");
    expect(result.validationReport).toMatchObject({
      failureClassification: "runtime crash",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("SyntaxError");
    expect(result.validationReport.logsSummary.length).toBeLessThan(3_000);
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

  it("reports managed app crash evidence when exploration discovers no routes", async () => {
    const pageError = `${baseUrl}/account/date-and-locale: goto: net::ERR_CONNECTION_RESET`;
    const { result } = await exploreObservation({
      blockedNetworkAttempts: [
        {
          host: "assets.example.com",
          method: "GET",
          resourceType: "image",
          url: "https://assets.example.com/logo.svg",
        },
      ],
      consoleErrors: ["Chunk compilation failed"],
      pageErrors: [pageError],
      readSubmittedCodeAppStatus: async () => ({
        exitCode: 137,
        running: false,
        stderr: "JavaScript heap out of memory",
        stdout: "Compiling /account/date-and-locale",
      }),
      routes: [],
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        blockedNetworkAttempts: [
          expect.objectContaining({
            url: "https://assets.example.com/logo.svg",
          }),
        ],
        consoleErrors: ["Chunk compilation failed"],
        failureClassification: "app route crashes",
        logsSummary: expect.stringContaining("exited with code 137"),
        pageErrors: [pageError],
        status: "failed",
        stderrExcerpts: ["JavaScript heap out of memory"],
        stdoutExcerpts: ["Compiling /account/date-and-locale"],
      },
    });
  });

  it("keeps route discovery classification while exposing a running app's output", async () => {
    const { result } = await exploreObservation({
      readSubmittedCodeAppStatus: async () => ({
        running: true,
        stderr: "Route compilation failed",
        stdout: "Compiling /dashboard",
      }),
      routes: [],
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "app route not discoverable",
        stderrExcerpts: ["Route compilation failed"],
        stdoutExcerpts: ["Compiling /dashboard"],
      },
    });
  });

  it("preserves the browser failure when managed app status is unavailable", async () => {
    const { result } = await exploreObservation({
      readSubmittedCodeAppStatus: async () => {
        throw new Error("Daytona status unavailable");
      },
      routes: [],
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "app route not discoverable",
        status: "failed",
        stderrExcerpts: [],
        stdoutExcerpts: [],
      },
    });
  });

  it("routes an exploration timeout from an exited app back to preparation repair", async () => {
    let timeoutMs: number | undefined;
    const result = await exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(_command, options) {
          timeoutMs = options?.timeoutMs;
          throw new AgentHarnessCommandTimeoutError(timeoutMs ?? 0);
        },
        async readSubmittedCodeAppStatus() {
          return {
            exitCode: 137,
            running: false,
            stderr: "JavaScript heap out of memory",
            stdout: "",
          };
        },
      },
    });

    expect(timeoutMs).toBe(5 * 60_000);
    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "start failure",
        logsSummary: expect.stringContaining("JavaScript heap out of memory"),
        status: "failed",
      },
    });
  });

  it("preserves an exploration timeout when managed app status is unavailable", async () => {
    const exploration = exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode() {
          throw new AgentHarnessCommandTimeoutError(5 * 60_000);
        },
        async readSubmittedCodeAppStatus() {
          throw new Error("Daytona status unavailable");
        },
      },
    });

    await expect(exploration).rejects.toBeInstanceOf(
      AgentHarnessCommandTimeoutError,
    );
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
  readSubmittedCodeAppStatus?: NonNullable<
    AgentHarnessWorkspace["readSubmittedCodeAppStatus"]
  >;
  requestedFeatures?: string[];
  routes: Array<Record<string, unknown>>;
  unreachableRoutes?: Array<{
    error: string;
    featureIds?: string[];
    url: string;
  }>;
}) {
  const commands: string[] = [];
  const result = await exploreSubmittedApp({
    baseUrl,
    ...(input.featureInventory === undefined
      ? {}
      : { featureInventory: input.featureInventory }),
    preparationManifestId: "prep_001",
    ...(input.requestedFeatures === undefined
      ? {}
      : { requestedFeatures: input.requestedFeatures }),
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
          stdout: `\n[makeademo:exploration] ${JSON.stringify({
            blockedNetworkAttempts: input.blockedNetworkAttempts ?? [],
            consoleErrors: input.consoleErrors ?? [],
            pageErrors: input.pageErrors ?? [],
            routes: input.routes,
            unreachableRoutes: input.unreachableRoutes ?? [],
          })}\n`,
        };
      },
      ...(input.readSubmittedCodeAppStatus === undefined
        ? {}
        : {
            readSubmittedCodeAppStatus: input.readSubmittedCodeAppStatus,
          }),
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

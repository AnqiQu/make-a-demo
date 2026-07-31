import { describe, expect, it } from "vitest";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessWorkspace,
} from "../daytona/workspace.interface";
import type { PreparedDemoFeature } from "../schemas/artifacts";
import { sandboxCapacityProbeCommand } from "../tools/sandbox-capacity";
import {
  exploreSubmittedApp,
  normalizeCrawlUrl,
} from "./submitted-app-explorer";

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
    // The script must run from outside /workspace: bun resolves imports by
    // walking up from the script's directory, so a submitted repo that ships
    // its own @playwright/test would otherwise shadow the image's pinned
    // install (whose browsers are the only ones present).
    expect(commands[0]).toContain(
      'NODE_PATH="$(npm root -g)" bun /tmp/makeademo/exploration/explore-app.mjs',
    );
    expect(commands[0]).not.toContain("bun /workspace");
    // A stale durable protocol from an earlier attempt must never be
    // recovered as this attempt's result.
    expect(commands[0]).toContain(
      "rm -f /workspace/.makeademo/exploration/exploration.json",
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

  it("re-verifies interactions from fresh navigation state and stops inheriting feature ids", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("observed.interactions = freshInteractions");
    // Feature ids survive only on unreachable entry targets; crawled links
    // and interaction-discovered URLs must not inherit them.
    expect(script.split("featureIds: target.featureIds ?? []")).toHaveLength(2);
    expect(script).toContain("result.unreachableRoutes.push");
  });

  it("settles the dom around interactions instead of using fixed waits", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("MutationObserver");
    expect(script).not.toContain("waitForTimeout(350)");
    expect(script).toContain('getByRole("button", { name, exact: true })');
  });

  it("stops interaction rounds at the exploration deadline", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script.split("deadlineAtMs").length).toBeGreaterThanOrEqual(5);
  });

  it("harvests assert text from the aria snapshot when a route renders no semantic content", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: [] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain(
      "observed.headings.length === 0 && observed.text.length === 0",
    );
    expect(script).toContain("ariaTextCandidates");
  });

  it("names grounded routes when prepared features are not observable", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        {
          authStrategy: "none",
          description: "Review transactions",
          entryPaths: ["/transactions"],
          fixtureNotes: [],
          id: "transaction-review",
          label: "Transaction review",
          sourcePaths: ["src/app/transactions/page.tsx"],
        },
        {
          authStrategy: "none",
          description: "Dashboard overview",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "dashboard-overview",
          label: "Dashboard overview",
          sourcePaths: ["src/app/page.tsx"],
        },
      ],
      routes: [
        observedRoute({
          headings: ["Transactions"],
          path: "/transactions",
        }),
        observedRoute({ headings: [], text: [] }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "prepared feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("/transactions");
    expect(result.validationReport.logsSummary).toContain("Reselect");
    // Steering must not invite repairs the fidelity contract rejects, such as
    // editing product UI to make features render.
    expect(result.validationReport.logsSummary).not.toContain(
      "render observable content",
    );
  });

  it("grounds a read-only feature on feature-matching assert evidence", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        {
          authStrategy: "none",
          description: "Adjust date and locale preferences",
          entryPaths: ["/settings/locale"],
          fixtureNotes: [],
          id: "date-locale-preferences",
          label: "Date & locale preferences",
          sourcePaths: ["src/app/settings/locale/page.tsx"],
        },
      ],
      routes: [
        observedRoute({
          featureIds: ["date-locale-preferences"],
          headings: ["Locale", "Time Zone"],
          path: "/settings/locale",
          title: "Date & Locale",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
  });

  it("classifies module-not-found page errors as a missing dependency", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        {
          authStrategy: "none",
          description: "Dashboard overview",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "dashboard-overview",
          label: "Dashboard overview",
          sourcePaths: ["src/app/page.tsx"],
        },
      ],
      pageErrors: [
        "http://127.0.0.1:3001/: ./src/components/chat/conversation.tsx Module not found: Can't resolve 'use-stick-to-bottom'",
      ],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "missing dependency",
      logsSummary: expect.stringContaining("use-stick-to-bottom"),
    });
  });

  it("attaches the observation to a grounding failure for diagnosis", async () => {
    const { result } = await exploreObservation({ routes: [] });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      observation: { routes: [] },
    });
  });

  it("rejects feature entry paths outside the app origin at target creation", async () => {
    const { commands } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["https://evil.com/admin", "/#/editor"],
        }),
      ],
      routes: [observedRoute()],
    });
    const script = readExplorerScript(commands);

    expect(script).not.toContain("evil.com");
    expect(script).toContain("/#/editor");
  });

  it("bounds error capture and never types into credential controls", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("pushBounded");
    expect(script).toContain(
      '["button", "checkbox", "file", "hidden", "password", "radio", "submit"]',
    );
    expect(script).toContain('timezoneId: "UTC"');
    expect(script).toContain('locale: "en-US"');
  });

  it("detects a same-route login form that has no auth call-to-action copy", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          buttons: ["Continue"],
          headings: ["Welcome back"],
          inputs: ["Email", "Password"],
        }),
      ],
    });

    expect(requireArtifacts(result).appMap.loginOrAuthWalls).toEqual(["/"]);
  });

  it("does not flag a marketing page on an auth-like path without an auth form", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          buttons: ["Sign up for updates"],
          headings: ["Join the newsletter"],
          path: "/signup",
        }),
      ],
    });

    expect(requireArtifacts(result).appMap.loginOrAuthWalls).toEqual([]);
  });

  it("does not ground a feature whose entry page merely loads", async () => {
    const feature = preparedFeature({ entryPaths: ["/"] });
    const { result } = await exploreObservation({
      featureInventory: [feature],
      routes: [
        observedRoute({
          featureIds: [feature.id],
          // Visible content unrelated to the feature: reachability evidence,
          // not feature evidence.
          headings: ["Welcome back"],
          links: [{ href: "/editor", name: "Editor" }],
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      status: "failed",
    });
  });

  it("normalizes crawl URLs so cosmetic variants share one route identity", () => {
    expect(
      normalizeCrawlUrl("http://127.0.0.1:3000/pricing/?utm_source=x&ref=nav"),
    ).toBe("http://127.0.0.1:3000/pricing");
    expect(normalizeCrawlUrl("http://127.0.0.1:3000/pricing")).toBe(
      "http://127.0.0.1:3000/pricing",
    );
    expect(normalizeCrawlUrl("http://127.0.0.1:3000/#/editor")).toBe(
      "http://127.0.0.1:3000/#/editor",
    );
    expect(normalizeCrawlUrl("http://127.0.0.1:3000/docs#")).toBe(
      "http://127.0.0.1:3000/docs",
    );
    expect(normalizeCrawlUrl("http://127.0.0.1:3000/a?page=2")).toBe(
      "http://127.0.0.1:3000/a?page=2",
    );
  });

  it("dedupes routes by normalized post-redirect URL inside the crawl", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("normalizeCrawlUrl(page.url())");
    expect(script).toContain("seen.add(normalizeCrawlUrl(target.url))");
  });

  it("gives first route loads a cold-start budget with one retry", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("const gotoRoute = async (url) =>");
    // The 60s cold-start budget is clamped to the remaining exploration
    // deadline so in-flight navigations cannot outlive the command budget.
    expect(script).toContain("Math.min(60000, Math.max(1000, remainingMs()))");
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
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "label", value: "Email" },
              name: "Email",
              outcome: "Email contained the observed demo value",
            },
          ],
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
          interactions: [
            {
              kind: "click",
              name: "Open global feed",
              outcome: "Global feed articles became visible",
            },
          ],
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
          if (command.includes("explore-app.mjs")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: '[makeademo:exploration] {"routes": [tru',
            };
          }
          return command.includes("exploration.json")
            ? { exitCode: 0, stderr: "", stdout: protocol }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    });

    expect(requireArtifacts(result).appMap.discoveredRoutes[0]).toMatchObject({
      headings: ["Dashboard"],
    });
  });

  it("recovers the durable exploration result when the command times out", async () => {
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
          if (command.includes("explore-app.mjs")) {
            throw new AgentHarnessCommandTimeoutError(300_000);
          }
          return command.includes("exploration.json")
            ? { exitCode: 0, stderr: "", stdout: protocol }
            : { exitCode: 0, stderr: "", stdout: "" };
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
          if (command.includes("explore-app.mjs")) {
            return {
              exitCode: 1,
              stderr: `SyntaxError: unexpected token\n${"x".repeat(10_000)}`,
              stdout: "",
            };
          }
          return command.includes("exploration.json")
            ? { exitCode: 1, stderr: "cat: no such file", stdout: "" }
            : { exitCode: 0, stderr: "", stdout: "" };
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

  it("classifies an app killed by the sandbox as sandbox capacity exceeded", async () => {
    const { result } = await exploreObservation({
      capacityProbeOutput: [
        "memory.max: 2147483648",
        "oom_kill 2",
        "Mem:            2048        1900          48",
        "nproc: 1",
      ].join("\n"),
      readSubmittedCodeAppStatus: async () => ({
        exitCode: 0,
        running: false,
        stderr: "",
        stdout: "GET /account 200 in 456ms",
      }),
      routes: [],
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "sandbox capacity exceeded",
        logsSummary: expect.stringContaining("2 OOM kill"),
        status: "failed",
      },
    });
    expect(result.validationReport.suggestedRepairHints.join(" ")).toContain(
      "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
    );
  });

  it("keeps the crash classification when the sandbox shows no OOM kills", async () => {
    const { result } = await exploreObservation({
      capacityProbeOutput: [
        "memory.max: max",
        "oom_kill 0",
        "Mem:            7942        1200        6000",
        "nproc: 4",
      ].join("\n"),
      readSubmittedCodeAppStatus: async () => ({
        exitCode: 0,
        running: false,
        stderr: "",
        stdout: "GET /account 200 in 456ms",
      }),
      routes: [],
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "app route crashes",
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
          timeoutMs ??= options?.timeoutMs;
          throw new AgentHarnessCommandTimeoutError(options?.timeoutMs ?? 0);
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

    expect(timeoutMs).toBe(7 * 60_000);
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
  capacityProbeOutput?: string;
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
        if (command === sandboxCapacityProbeCommand) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: input.capacityProbeOutput ?? "",
          };
        }
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

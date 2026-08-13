import { describe, expect, it } from "vitest";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessWorkspace,
} from "../daytona/workspace.interface";
import { createFakeAgentHarnessWorkspace } from "../daytona/workspace.test-helpers";
import type { PreparedDemoFeature } from "../schemas/artifacts";
import { sandboxCapacityProbeCommand } from "../tools/sandbox-capacity";
import {
  exploreSubmittedApp,
  normalizeCrawlUrl,
  readRouteDistinctContent,
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
    // MAKEADEMO_TOOLS_NODE_MODULES points at the swap-proof tooling prefix
    // (N78); the `npm root -g` fallback keeps pre-N78 images working.
    expect(commands[0]).toContain(
      'NODE_PATH="${MAKEADEMO_TOOLS_NODE_MODULES:-$(npm root -g)}" bun /tmp/makeademo/exploration/explore-app.mjs',
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
      discoveredRoutes: [
        expect.objectContaining({
          inputs: expect.arrayContaining(["Search"]),
          path: "/",
          title: "Example App",
        }),
      ],
      loginOrAuthWalls: [],
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

  it("harvests assert text from the aria snapshot on every route", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: [] })],
    });
    const script = readExplorerScript(commands);

    // N105: the accessibility tree is the canonical name-space — the same
    // one Playwright locators resolve — so its text candidates join every
    // route's harvest, not only thin-route fallbacks. Cross-route repeats
    // are still chrome and stay excluded.
    expect(script).toContain("ariaTextCandidates");
    expect(script).not.toContain("distinctHarvestCount");
    expect(script).toContain("harvestedOnEarlierRoutes.has(candidate)");
    // Rendered text only: textContent would admit <style> and <script> text
    // as heading or paragraph evidence.
    expect(script).toContain("element.innerText");
  });

  it("waits for a bounded network-quiet window and re-harvests thin feature entry routes", async () => {
    const { commands } = await exploreObservation({
      featureInventory: [preparedFeature({})],
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    // N105 stability rider: data that lands just after first paint gets a
    // short capped network-idle window, and a feature entry route about to
    // be reported content-free earns one fresh navigation and re-harvest
    // before that verdict stands.
    expect(script).toContain("networkidle");
    expect(script).toContain("reharvestThinFeatureRoute");
  });

  it("spends the control budget on feature-matching names before positional picks", async () => {
    const { commands } = await exploreObservation({
      featureInventory: [preparedFeature({})],
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    // N105: the 16-control budget is kept, but controls whose accessible
    // names token-match a prepared feature outrank purely positional picks —
    // a control-dense page's 17th button is often the feature's own.
    expect(script).toContain("featureControlTokenGroups");
    expect(script).toContain("prioritizeFeatureControls");
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

  it("classifies an app whose routes render no content as empty app state", async () => {
    const features = [
      "cash-and-runway-overview",
      "invoice-status-overview",
      "financial-work-queues",
    ].map((id) => ({
      authStrategy: "none" as const,
      description: `Show the ${id.replaceAll("-", " ")}`,
      entryPaths: ["/"],
      fixtureNotes: [],
      id,
      label: id.replaceAll("-", " "),
      sourcePaths: ["src/app/page.tsx"],
    }));
    const { result } = await exploreObservation({
      featureInventory: features,
      routes: [
        observedRoute({
          featureIds: features.map(({ id }) => id),
          title: "Overview | Midday",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      "rendered no visible content",
    );
  });

  it("classifies a same-origin script 5xx as an app server error, not empty app state", async () => {
    // N128 (twenty, 2026-08-13): Vite's import-analysis answered 500 on the
    // entry chunk, every route rendered the error overlay, and the probe
    // read "empty/unmeaningful app state" with a data-fixtures hint —
    // repairs aimed at the data layer while the fault was module serving.
    const { result } = await exploreObservation({
      failedScriptResponses: [{ status: 500, url: `${baseUrl}/src/index.tsx` }],
      routes: [observedRoute({ title: "Vite + React" })],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "app server error",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      `${baseUrl}/src/index.tsx`,
    );
    expect(result.validationReport.logsSummary).toContain("500");
  });

  it("keeps the empty-state reading when the failing script belongs to another origin", async () => {
    const { result } = await exploreObservation({
      failedScriptResponses: [
        { status: 500, url: "https://cdn.example.com/analytics.js" },
      ],
      routes: [observedRoute({ title: "Vite + React" })],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
  });

  it("never fails a grounded exploration over a script 5xx alone", async () => {
    // The serve-failure reading exists to redirect an already-failing run;
    // an app that grounds its features despite a stray 5xx is working.
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/en/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const { result } = await exploreObservation({
      failedScriptResponses: [
        { status: 500, url: `${baseUrl}/optional-widget.js` },
      ],
      featureInventory: [invoicing],
      routes: [
        observedRoute({
          featureIds: ["invoicing"],
          headings: ["Invoice INV-001 for Aperture Labs"],
          path: "/en/invoices",
          primaryNavigation: ["Overview"],
          requestedPath: "/en/invoices",
          text: ["Due in 14 days"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "none",
      status: "passed",
    });
  });

  it("lets a named missing module outrank the script 5xx reading", async () => {
    // A page error that names the unresolvable module is deeper evidence
    // than the 5xx that delivered it; the dependency hint stays first.
    const { result } = await exploreObservation({
      failedScriptResponses: [{ status: 500, url: `${baseUrl}/src/index.tsx` }],
      pageErrors: [
        `${baseUrl}/: Module not found: Can't resolve '@calcom/prisma/enums'`,
      ],
      routes: [observedRoute({ title: "Vite + React" })],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "missing dependency",
      status: "failed",
    });
  });

  it("fails a hollow app whose feature routes render only shared navigation chrome", async () => {
    const chrome = [
      "Categories",
      "Connect bank",
      "Import",
      "Create new",
      "Settings",
      "Products",
    ];
    const hollowRoute = (path: string, overrides: Record<string, unknown>) =>
      observedRoute({
        path,
        primaryNavigation: chrome,
        text: chrome,
        ...overrides,
      });
    const feature = (id: string, label: string, entryPath: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: [`src/app${entryPath}/page.tsx`],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("invoice-management", "Invoice management", "/invoices"),
        feature("transaction-review", "Transaction review", "/transactions"),
        feature("expense-tracking", "Expense tracking", "/expenses"),
      ],
      routes: [
        hollowRoute("/invoices", {
          featureIds: ["invoice-management"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search invoices..." },
              name: "Search invoices...",
              outcome: "The field contained the observed demo value",
            },
          ],
        }),
        hollowRoute("/transactions", {
          featureIds: ["transaction-review"],
          interactions: [
            {
              kind: "fill",
              locator: {
                strategy: "placeholder",
                value: "Search transactions...",
              },
              name: "Search transactions...",
              outcome: "The field contained the observed demo value",
            },
          ],
        }),
        hollowRoute("/expenses", { featureIds: ["expense-tracking"] }),
        hollowRoute("/settings", {}),
        hollowRoute("/products", {}),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("navigation chrome");
    expect(result.validationReport.logsSummary).toContain("/invoices");
    expect(result.validationReport.logsSummary).toContain("data path");
  });

  it("steers hollow feature routes toward routes that render distinct content", async () => {
    const chrome = ["Dashboard", "Reports", "Settings"];
    const feature = (id: string, label: string, entryPath: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: [`src/app${entryPath}/page.tsx`],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("invoice-management", "Invoice management", "/invoices"),
        feature("transaction-review", "Transaction review", "/transactions"),
        feature("report-review", "Report review", "/reports"),
      ],
      routes: [
        observedRoute({
          featureIds: ["invoice-management"],
          path: "/invoices",
          primaryNavigation: chrome,
          text: chrome,
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search invoices..." },
              name: "Search invoices...",
              outcome: "The field contained the observed demo value",
            },
          ],
        }),
        observedRoute({
          featureIds: ["transaction-review"],
          path: "/transactions",
          primaryNavigation: chrome,
          text: chrome,
        }),
        observedRoute({
          featureIds: ["report-review"],
          headings: ["Quarterly revenue"],
          path: "/reports",
          primaryNavigation: chrome,
          text: [...chrome, "Revenue grew 14% quarter over quarter"],
        }),
        observedRoute({
          path: "/about",
          primaryNavigation: chrome,
          text: chrome,
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "prepared feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("/reports");
    expect(result.validationReport.logsSummary).not.toContain(
      "grounded on: /invoices",
    );
  });

  it("grounds exercised features normally when their routes render distinct content", async () => {
    const chrome = ["Home", "Invoices", "Transactions", "Settings"];
    const feature = (id: string, label: string, entryPath: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: [`src/app${entryPath}/page.tsx`],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("invoice-management", "Invoice management", "/invoices"),
        feature("transaction-review", "Transaction review", "/transactions"),
        feature("locale-preferences", "Locale preferences", "/settings"),
      ],
      routes: [
        observedRoute({
          featureIds: ["invoice-management"],
          path: "/invoices",
          primaryNavigation: chrome,
          text: [...chrome, "INV-1001 Aperture Labs $4,200 unpaid"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search invoices..." },
              name: "Search invoices...",
              outcome: "The list filtered to Aperture Labs",
            },
          ],
        }),
        observedRoute({
          featureIds: ["transaction-review"],
          headings: ["Transactions"],
          path: "/transactions",
          primaryNavigation: chrome,
          text: [...chrome, "Figma -$180 Software"],
        }),
        observedRoute({
          featureIds: ["locale-preferences"],
          headings: ["Locale preferences"],
          path: "/settings",
          primaryNavigation: chrome,
          text: chrome,
        }),
        observedRoute({
          path: "/about",
          primaryNavigation: chrome,
          text: chrome,
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("quarantines routes with route-specific page errors from grounding evidence", async () => {
    // Outline's crashed /search rendered its error boundary ("Something
    // Unexpected Happened") and the demo asserted that heading as feature
    // proof (2026-08-08). A route that threw an uncaught exception supplies
    // no evidence and no asserts; its page error steers the repair.
    const chrome = ["Home", "Search", "Settings", "Archive"];
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/search?q=knowledge"],
          id: "search-documents",
          label: "Search documents",
          requestedFeature: "Search documents",
        }),
      ],
      pageErrors: [
        "http://127.0.0.1:4000/search?q=knowledge: Cannot read properties of undefined (reading 'toLocaleLowerCase')",
      ],
      requestedFeatures: ["Search documents"],
      routes: [
        observedRoute({
          featureIds: ["search-documents"],
          headings: ["Something Unexpected Happened"],
          path: "/search?q=knowledge",
          primaryNavigation: chrome,
          text: [...chrome, "Clear cache + reload", "Show detail…"],
        }),
        observedRoute({
          headings: ["Welcome"],
          path: "/",
          primaryNavigation: chrome,
          text: [...chrome, "Latest documents"],
        }),
        observedRoute({
          headings: ["Archive"],
          path: "/archive",
          primaryNavigation: chrome,
          text: chrome,
        }),
        observedRoute({
          headings: ["Settings"],
          path: "/settings",
          primaryNavigation: chrome,
          text: chrome,
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("toLocaleLowerCase");
    const assertValues = requireArtifacts(result)
      .actionCatalog.actions.filter((action) => action.kind === "assert")
      .map((action) => action.preferredLocator.value ?? "")
      .join(" ");
    expect(assertValues).not.toContain("Something Unexpected Happened");
  });

  it("does not taint routes whose page error repeats across most of the app", async () => {
    // An analytics rejection logged on every route is ambient noise, not a
    // route defect — tainting on it would fail every healthy app that logs
    // one benign error per page.
    const chrome = ["Home", "Search", "Settings", "Archive"];
    const ambientError = (path: string) =>
      `http://127.0.0.1:4000${path}: Failed to fetch telemetry`;
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/search"],
          id: "search-documents",
          label: "Search documents",
          requestedFeature: "Search documents",
        }),
      ],
      pageErrors: [
        ambientError("/search"),
        ambientError("/"),
        ambientError("/archive"),
        ambientError("/settings"),
      ],
      requestedFeatures: ["Search documents"],
      routes: [
        observedRoute({
          featureIds: ["search-documents"],
          headings: ["Search documents"],
          path: "/search",
          primaryNavigation: chrome,
          text: [...chrome, "Quarterly planning notes"],
        }),
        observedRoute({
          headings: ["Welcome"],
          path: "/",
          primaryNavigation: chrome,
          text: [...chrome, "Latest documents"],
        }),
        observedRoute({
          headings: ["Archive"],
          path: "/archive",
          primaryNavigation: chrome,
          text: chrome,
        }),
        observedRoute({
          headings: ["Settings"],
          path: "/settings",
          primaryNavigation: chrome,
          text: chrome,
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("marks routes matching the 404-probe signature as not content-bearing", async () => {
    // The probe page's content is what the app shows for a URL that cannot
    // exist; a real route showing nothing beyond that is a not-found page
    // wearing a valid URL (outline's fixture doc slug, 2026-08-08).
    const chrome = ["Home", "Search", "Settings"];
    const notFoundContent = {
      headings: ["Not found"],
      text: [...chrome, "The page you’re looking for cannot be found."],
    };
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/doc/welcome"],
          id: "read-document",
          label: "Read a document",
          requestedFeature: "Read a document",
        }),
      ],
      requestedFeatures: ["Read a document"],
      routes: [
        observedRoute({
          ...notFoundContent,
          path: "/__makeademo-404-probe__",
          primaryNavigation: chrome,
        }),
        observedRoute({
          ...notFoundContent,
          featureIds: ["read-document"],
          path: "/doc/welcome",
          primaryNavigation: chrome,
        }),
        observedRoute({
          headings: ["Welcome"],
          path: "/",
          primaryNavigation: chrome,
          text: [...chrome, "Latest documents"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    const appMapPaths = requireArtifacts(result).appMap.discoveredRoutes.map(
      (route) => route.path,
    );
    expect(appMapPaths).not.toContain("/__makeademo-404-probe__");
  });

  it("ignores the 404 probe when unknown URLs render the app's default route", async () => {
    // Apps that render home for any URL make the probe indistinguishable
    // from the default route; flagging on it would fail healthy homes.
    const chrome = ["Home", "Search", "Settings"];
    const homeContent = {
      headings: ["Dashboard overview"],
      text: [...chrome, "Latest activity"],
    };
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/"],
          id: "dashboard",
          label: "Dashboard overview",
          requestedFeature: "Dashboard overview",
        }),
      ],
      requestedFeatures: ["Dashboard overview"],
      routes: [
        observedRoute({
          ...homeContent,
          path: "/__makeademo-404-probe__",
          primaryNavigation: chrome,
        }),
        observedRoute({
          ...homeContent,
          featureIds: ["dashboard"],
          path: "/",
          primaryNavigation: chrome,
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("carries alert text as repair evidence for routes that rendered none of their own content", async () => {
    // The toast literally names the broken contract ("Could not load shared
    // documents") — it must reach the repair prompt while never grounding
    // the feature it describes failing.
    const chrome = ["Home", "Search", "Settings", "Archive"];
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/home"],
          id: "browse-workspace",
          label: "Browse the workspace",
          requestedFeature: "Browse the workspace",
        }),
      ],
      requestedFeatures: ["Browse the workspace"],
      routes: [
        observedRoute({
          alerts: ["Could not load shared documents"],
          featureIds: ["browse-workspace"],
          path: "/home",
          primaryNavigation: chrome,
          text: chrome,
        }),
        observedRoute({
          headings: ["Archive"],
          path: "/archive",
          primaryNavigation: chrome,
          text: chrome,
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.logsSummary).toContain(
      "Could not load shared documents",
    );
  });

  it("fails features that browser evidence cannot distinguish before flow planning", async () => {
    const feature = (id: string, label: string, entryPath: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: [`src${entryPath}.tsx`],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("card-dashboard", "Card dashboard", "/"),
        feature("theme-dashboard", "Theme dashboard", "/"),
        feature("service-search", "Service search", "/search"),
      ],
      routes: [
        observedRoute({
          featureIds: ["card-dashboard", "theme-dashboard"],
          headings: ["Demo dashboard"],
          path: "/",
        }),
        observedRoute({
          featureIds: ["service-search"],
          headings: ["Search results"],
          path: "/search",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "prepared feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("cannot distinguish");
    expect(result.validationReport.logsSummary).toContain("card-dashboard");
    expect(result.validationReport.logsSummary).toContain("theme-dashboard");
  });

  it("tolerates indistinguishable features when enough distinguishable ones ground", async () => {
    const feature = (id: string, label: string, entryPath: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: [`src${entryPath}.tsx`],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("card-dashboard", "Card dashboard", "/"),
        feature("theme-dashboard", "Theme dashboard", "/"),
        feature("service-search", "Service search", "/search"),
        feature("report-review", "Report review", "/reports"),
      ],
      routes: [
        observedRoute({
          featureIds: ["card-dashboard", "theme-dashboard"],
          headings: ["Demo dashboard"],
          path: "/",
        }),
        observedRoute({
          featureIds: ["service-search"],
          headings: ["Search results"],
          path: "/search",
        }),
        observedRoute({
          featureIds: ["report-review"],
          headings: ["Report review"],
          path: "/reports",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("fails requested features that are forced onto identical evidence", async () => {
    const feature = (id: string, label: string, requestedFeature: string) => ({
      authStrategy: "none" as const,
      description: `Demonstrate ${label}.`,
      entryPaths: ["/"],
      fixtureNotes: [],
      id,
      label,
      requestedFeature,
      sourcePaths: ["src/page.tsx"],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        feature("card-dashboard", "Card dashboard", "card dashboard"),
        feature("theme-dashboard", "Theme dashboard", "theme dashboard"),
      ],
      requestedFeatures: ["card dashboard", "theme dashboard"],
      routes: [
        observedRoute({
          featureIds: ["card-dashboard", "theme-dashboard"],
          headings: ["Demo dashboard"],
          path: "/",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("cannot distinguish");
  });

  it("emits up to three text asserts per headingless route, distinct content first", async () => {
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          path: "/invoices",
          primaryNavigation: ["Categories", "Import"],
          text: [
            "Categories",
            "Import",
            "INV-1001 Aperture Labs $4,200",
            "Cedar & Co. overdue",
          ],
        }),
      ],
    });
    const textAsserts = requireArtifacts(result)
      .actionCatalog.actions.filter((action) =>
        String(action.id).startsWith("assert-visible-text-"),
      )
      .map((action) => action.preferredLocator.value);

    expect(textAsserts).toEqual([
      "INV-1001 Aperture Labs $4,200",
      "Cedar & Co. overdue",
      "Categories",
    ]);
  });

  it("keeps a small site groundable when its text repeats across routes", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        {
          authStrategy: "none" as const,
          description: "Browse bookmarked services.",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "service-dashboard",
          label: "Service dashboard",
          sourcePaths: ["index.html"],
        },
      ],
      routes: [
        observedRoute({
          featureIds: ["service-dashboard"],
          headings: ["My services"],
          path: "/",
          primaryNavigation: ["My services"],
          text: ["My services"],
        }),
        observedRoute({
          headings: ["My services"],
          path: "/settings",
          primaryNavigation: ["My services"],
          text: ["My services"],
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("attaches managed-app stderr to a failed exploration verdict", async () => {
    const ssrError =
      "⨯ Error [TRPCClientError]: Failed to parse URL from /api/demo-trpc/invoice.get";
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      readSubmittedCodeAppStatus: async () => ({
        running: true,
        stderr: ssrError,
        stdout: "",
      }),
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: [],
          path: "/#/editor",
          text: [],
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.stderrExcerpts.join("\n")).toContain(
      "Failed to parse URL",
    );
    expect(result.validationReport.suggestedRepairHints.join(" ")).toContain(
      "Server-side runtime errors",
    );
  });

  it("keeps stderr as evidence but withholds the runtime-error hint when stderr carries only warnings", async () => {
    // N106: tsc watch mode narrates "Found 0 errors" on stderr forever, so
    // stderr bytes alone must never steer repair at server-side errors.
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      readSubmittedCodeAppStatus: async () => ({
        running: true,
        stderr: [
          "warn  - You have enabled experimental features.",
          "Found 0 errors. Watching for file changes.",
        ].join("\n"),
        stdout: "",
      }),
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: [],
          path: "/#/editor",
          text: [],
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.stderrExcerpts.join("\n")).toContain(
      "Found 0 errors",
    );
    expect(
      result.validationReport.suggestedRepairHints.join(" "),
    ).not.toContain("Server-side runtime errors");
  });

  it("redacts secrets from managed-app output before they enter the exploration verdict", async () => {
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      readSubmittedCodeAppStatus: async () => ({
        running: true,
        stderr:
          "fetch failed for https://api.example.com with Authorization: Bearer sk-live-4242424242",
        stdout: "",
      }),
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: [],
          path: "/#/editor",
          text: [],
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    const excerpts = result.validationReport.stderrExcerpts.join("\n");
    expect(excerpts).not.toContain("sk-live-4242424242");
    expect(excerpts).toContain("Bearer [Redacted]");
  });

  it("keeps the exploration verdict intact when app status cannot be read", async () => {
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      readSubmittedCodeAppStatus: async () => {
        throw new Error("status channel unavailable");
      },
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: [],
          path: "/#/editor",
          text: [],
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.stderrExcerpts).toEqual([]);
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

  it("names the service-worker ban when registration fails as a page error", async () => {
    // The demo browser blocks service workers by design (network lockdown),
    // so MSW-style worker mocking can never activate — twenty rendered only
    // navigation chrome on every route while repair rounds chased the
    // symptom (2026-08-12). The hint must name the structural constraint.
    const { result } = await exploreObservation({
      featureInventory: [preparedFeature()],
      pageErrors: [
        "http://127.0.0.1:3001/: [MSW] Failed to register the Service Worker: Cannot read properties of undefined (reading 'active')",
      ],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport.status).toBe("failed");
    const hints = result.validationReport.suggestedRepairHints.join(" ");
    expect(hints).toContain("blocks Service Worker registration");
    expect(hints).toContain("fetch/API-client layer");
  });

  it("names the service-worker ban when registration fails only in console errors", async () => {
    const { result } = await exploreObservation({
      consoleErrors: [
        "http://127.0.0.1:3001/: Failed to register a ServiceWorker for scope ('http://127.0.0.1:3001/') with script ('http://127.0.0.1:3001/mockServiceWorker.js')",
      ],
      featureInventory: [preparedFeature()],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport.status).toBe("failed");
    const hints = result.validationReport.suggestedRepairHints.join(" ");
    expect(hints).toContain("blocks Service Worker registration");
  });

  it("names the schema-gap fields when a client-stub declaration crashes at runtime", async () => {
    // A client-stub rung that satisfies only part of the response schema
    // crashes the app generically: error boundaries report the field the
    // component dereferenced, client caches report the field they could not
    // write. The hint must extract those identifiers and state the stub's
    // schema obligation so repair targets the transport, not the symptom
    // (twenty, 2026-08-12).
    const { result } = await exploreObservation({
      consoleErrors: [
        "http://127.0.0.1:3001/: Missing field 'currentWorkspace' while writing result",
      ],
      dataStrategy: [
        {
          detail: "Stubbed the GraphQL client transport with fixtures.",
          rung: "client-stub",
          service: "postgres",
        },
      ],
      featureInventory: [preparedFeature()],
      pageErrors: [
        "http://127.0.0.1:3001/: TypeError: Cannot read properties of undefined (reading 'authProviders')",
      ],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport.status).toBe("failed");
    const hints = result.validationReport.suggestedRepairHints.join(" ");
    expect(hints).toContain("client-stub");
    expect(hints).toContain("authProviders");
    expect(hints).toContain("currentWorkspace");
    expect(hints).toContain("complete response schema");
  });

  it("omits the schema-gap hint when no client-stub rung is declared", async () => {
    const { result } = await exploreObservation({
      dataStrategy: [
        {
          detail: "Embedded SQLite with seeded demo rows.",
          rung: "embedded-config",
          service: "postgres",
        },
      ],
      featureInventory: [preparedFeature()],
      pageErrors: [
        "http://127.0.0.1:3001/: TypeError: Cannot read properties of undefined (reading 'authProviders')",
      ],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(
      result.validationReport.suggestedRepairHints.join(" "),
    ).not.toContain("complete response schema");
  });

  it("keeps the schema-gap hint quiet when crash diagnostics match no schema pattern", async () => {
    const { result } = await exploreObservation({
      dataStrategy: [
        {
          detail: "Stubbed the GraphQL client transport with fixtures.",
          rung: "client-stub",
          service: "postgres",
        },
      ],
      featureInventory: [preparedFeature()],
      pageErrors: ["http://127.0.0.1:3001/: Error: WebSocket handshake failed"],
      routes: [observedRoute({ headings: [], text: [] })],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(
      result.validationReport.suggestedRepairHints.join(" "),
    ).not.toContain("complete response schema");
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

  it("catalogs interaction-revealed text as asserts carrying revealedBy", async () => {
    const feature = preparedFeature({
      entryPaths: ["/analyzer"],
      id: "magic-analysis",
      label: "Magic analysis",
      requestedFeature: "magic analysis",
    });
    const { result } = await exploreObservation({
      featureInventory: [feature],
      requestedFeatures: ["magic analysis"],
      routes: [
        observedRoute({
          buttons: ["Run analysis"],
          featureIds: ["magic-analysis"],
          interactions: [
            {
              kind: "click",
              locator: {
                name: "Run analysis",
                strategy: "role",
                value: "button",
              },
              locatorEvidence: {
                locator: {
                  name: "Run analysis",
                  role: "button",
                  strategy: "role",
                },
                verification: {
                  matchCount: 1,
                  route: "/analyzer",
                  visible: true,
                },
              },
              name: "Run analysis",
              outcome: "Detected format: Base64 became visible",
              revealedTexts: [
                {
                  locatorEvidence: {
                    locator: {
                      exact: true,
                      strategy: "text",
                      value: "Detected format: Base64",
                    },
                    verification: {
                      matchCount: 1,
                      route: "/analyzer",
                      visible: true,
                    },
                  },
                  value: "Detected format: Base64",
                },
              ],
            },
          ],
          path: "/analyzer",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    const interactionAction = artifacts.actionCatalog.actions.find(
      (action) => action.exercised === true,
    );
    const revealedAssert = artifacts.actionCatalog.actions.find(
      (action) => action.revealedBy !== undefined,
    );
    expect(interactionAction).toBeDefined();
    expect(revealedAssert).toMatchObject({
      kind: "assert",
      revealedBy: interactionAction?.id,
      route: "/analyzer",
    });
    expect(revealedAssert?.preferredLocator).toMatchObject({
      strategy: "text",
      value: "Detected format: Base64",
    });
    expect(revealedAssert?.featureIds).toContain("magic-analysis");
  });

  it("grounds a feature whose only evidence is interaction-revealed text", async () => {
    // cyberchef-shaped: a tool route whose static harvest is controls only —
    // the proof-text renders on demand, after the interaction.
    const feature = preparedFeature({
      entryPaths: ["/analyzer"],
      id: "magic-analysis",
      label: "Magic analysis",
      requestedFeature: "magic analysis",
    });
    const { result } = await exploreObservation({
      featureInventory: [feature],
      requestedFeatures: ["magic analysis"],
      routes: [
        observedRoute({
          buttons: ["Run analysis"],
          featureIds: ["magic-analysis"],
          interactions: [
            {
              kind: "click",
              locator: {
                name: "Run analysis",
                strategy: "role",
                value: "button",
              },
              locatorEvidence: {
                locator: {
                  name: "Run analysis",
                  role: "button",
                  strategy: "role",
                },
                verification: {
                  matchCount: 1,
                  route: "/analyzer",
                  visible: true,
                },
              },
              name: "Run analysis",
              outcome: "Detected format: Base64 became visible",
              revealedTexts: [
                {
                  locatorEvidence: {
                    locator: {
                      exact: true,
                      strategy: "text",
                      value: "Detected format: Base64",
                    },
                    verification: {
                      matchCount: 1,
                      route: "/analyzer",
                      visible: true,
                    },
                  },
                  value: "Detected format: Base64",
                },
              ],
            },
          ],
          path: "/analyzer",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("passed");
  });

  it("lists the ungrounded feature ids on grounding failures", async () => {
    const searchFeature = preparedFeature({
      entryPaths: ["/search"],
      id: "service-search",
      label: "Service search",
      requestedFeature: "service search",
    });
    const reviewFeature = preparedFeature({
      entryPaths: ["/reports"],
      id: "report-review",
      label: "Report review",
      requestedFeature: "report review",
    });
    const { result } = await exploreObservation({
      featureInventory: [searchFeature, reviewFeature],
      requestedFeatures: ["service search", "report review"],
      routes: [
        observedRoute({
          featureIds: ["service-search"],
          headings: ["Search results"],
          path: "/search",
        }),
        observedRoute({
          featureIds: ["report-review"],
          headings: ["Welcome back"],
          path: "/reports",
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failingFeatureIds: ["report-review"],
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
    expect(result.validationReport.logsSummary).toContain(
      "Seed an authenticated demo session",
    );
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

  it("names chrome-only routes when a requested feature's data never rendered", async () => {
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const transactions = preparedFeature({
      description: "Demonstrate transactions",
      entryPaths: ["/transactions"],
      id: "transactions",
      label: "Transactions",
      requestedFeature: "transactions",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoicing, transactions],
      routes: [
        observedRoute({
          featureIds: ["invoicing"],
          headings: ["Invoices"],
          path: "/invoices",
          requestedPath: "/invoices",
        }),
        observedRoute({
          buttons: ["Review"],
          featureIds: ["transactions"],
          path: "/transactions",
          primaryNavigation: ["Categories", "Connect bank"],
          requestedPath: "/transactions",
          text: ["Categories", "Connect bank"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      logsSummary: expect.stringContaining(
        'Requested feature "transactions" routes /transactions rendered only globally-repeated navigation chrome',
      ),
      status: "failed",
    });
  });

  it("steers at the serving base when chrome-only routes carry same-origin 404s", async () => {
    // Directus (2026-08-09): the admin SPA was served at a base it does not
    // expect — its own links resolved to concatenated 404 routes and its
    // session endpoint 404'd — and every repair round steered at fixtures.
    // Same-origin 404s on a chrome-only route are browser evidence that the
    // serving arrangement, not the data, is wrong.
    const dataModel = preparedFeature({
      description: "Create a collection in the data model",
      entryPaths: ["/settings/data-model"],
      id: "data-model",
      label: "Data model",
      requestedFeature: "data model",
    });
    const { result } = await exploreObservation({
      featureInventory: [dataModel],
      pageErrors: [
        "http://127.0.0.1:5173/settings/data-model: Request failed with status code 404",
      ],
      routes: [
        observedRoute({
          featureIds: ["data-model"],
          path: "/settings/data-model",
          primaryNavigation: ["Settings", "Content"],
          requestedPath: "/settings/data-model",
          text: ["Settings", "Content"],
        }),
        observedRoute({
          headings: [],
          path: "/content",
          primaryNavigation: ["Settings", "Content"],
          requestedPath: "/content",
          text: ["Settings", "Content"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      "same-origin request(s) returned 404",
    );
    expect(result.validationReport.logsSummary).toContain("base path");
  });

  it("names what a content-bearing route showed when the feature's wording matched nothing", async () => {
    const encode = preparedFeature({
      description: "Paste input and add an encoding operation",
      entryPaths: ["/"],
      id: "encode-input-output",
      label: "Encode input to output",
      requestedFeature:
        "Paste sample input, add an encoding operation to the recipe, and inspect the transformed output",
    });
    const chain = preparedFeature({
      description: "Chain and reorder recipe steps",
      entryPaths: ["/"],
      id: "chain-recipe-operations",
      label: "Chain recipe operations",
      requestedFeature:
        "Chain multiple recipe operations and reorder or disable one",
    });
    const { result } = await exploreObservation({
      featureInventory: [encode, chain],
      routes: [
        observedRoute({
          buttons: ["To Base64", "From Hex", "Fork"],
          featureIds: [encode.id, chain.id],
          headings: [],
          path: "/",
          requestedPath: "/",
          text: ["To Base64", "From Hex", "Magic wand"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      "rendered distinct content (To Base64",
    );
    expect(result.validationReport.logsSummary).toContain(
      "align the featureInventory wording with the on-screen labels",
    );
  });

  it("reports an empty data table on a requested feature's chrome-only routes", async () => {
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const transactions = preparedFeature({
      description: "Demonstrate transactions",
      entryPaths: ["/transactions"],
      id: "transactions",
      label: "Transactions",
      requestedFeature: "transactions",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoicing, transactions],
      routes: [
        observedRoute({
          featureIds: ["invoicing"],
          headings: ["Invoices"],
          path: "/invoices",
          requestedPath: "/invoices",
        }),
        observedRoute({
          buttons: ["Review"],
          emptyDataTables: [{ columnHeaders: 7 }],
          featureIds: ["transactions"],
          path: "/transactions",
          primaryNavigation: ["Categories", "Connect bank"],
          requestedPath: "/transactions",
          text: ["Categories", "Connect bank"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      logsSummary: expect.stringContaining(
        "An empty data table (7 column headers, zero data rows) rendered on these routes. Two causes produce this: the data query resolved empty (fixture shape or default filters exclude the fixture rows), or a virtualized table body measured zero height and rendered no rows despite data being present — identify which before repairing, and prefer fixture and data-path fixes over changing product components.",
      ),
      status: "failed",
    });
  });

  it("fails a run whose only route-distinct text is empty-table header text", async () => {
    // A skeleton app's zero-row tables still render their column headers, and
    // the accessibility-tree harvest surfaces them as route text — both as
    // individual cells and as the combined header-row name. Header words of an
    // empty table are structure, not rendered data, so they must not ground a
    // feature.
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/en/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const transactions = preparedFeature({
      description: "Demonstrate transactions",
      entryPaths: ["/en/transactions"],
      id: "transactions",
      label: "Transactions",
      requestedFeature: "transactions",
    });
    const chrome = ["Categories", "Connect bank"];
    const { result } = await exploreObservation({
      featureInventory: [invoicing, transactions],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 17,
              headerTexts: ["Invoice no.", "Due date", "Amount"],
            },
          ],
          featureIds: ["invoicing"],
          path: "/en/invoices",
          primaryNavigation: chrome,
          requestedPath: "/en/invoices",
          text: [...chrome, "Invoice no.", "Due date", "Amount"],
        }),
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 8,
              headerTexts: ["Date", "Description", "Amount"],
            },
          ],
          featureIds: ["transactions"],
          interactions: [
            {
              kind: "fill",
              locator: {
                strategy: "placeholder",
                value: "Search transactions...",
              },
              name: "Search transactions...",
              outcome: "The field contained the observed demo value",
            },
          ],
          path: "/en/transactions",
          primaryNavigation: chrome,
          requestedPath: "/en/transactions",
          text: [
            ...chrome,
            "Date Description Amount",
            "Date",
            "Description",
            "Amount",
          ],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("navigation chrome");
    expect(result.validationReport.logsSummary).toContain(
      "column headers, zero data rows",
    );
  });

  it("keeps genuine content distinct on a route that also has an empty table", () => {
    const content = readRouteDistinctContent([
      {
        emptyDataTables: [
          {
            columnHeaders: 3,
            headerTexts: ["Invoice no.", "Due date", "Amount"],
          },
        ],
        headings: [],
        path: "/invoices",
        primaryNavigation: ["Overview"],
        text: [
          "Invoice no.",
          "Due date Amount",
          "Amount due today: $1,200",
          "No invoices yet",
        ],
      },
    ]);

    expect(content.get("/invoices")).toEqual([
      "Amount due today: $1,200",
      "No invoices yet",
    ]);
  });

  it("keeps content repeated across same-shell route variants out of chrome", () => {
    // excalidraw and cyberchef prepare entry routes as query variants of one
    // pathname (/?flow=…, /?recipe=…). Those are one shell, not four sites:
    // content repeated across them is the product's persistent UI, and
    // discounting it as chrome left single-shell apps with zero evidence
    // (2026-08-07 matrix).
    const shellRoutes = [
      {
        headings: ["Recipe"],
        path: "/?recipe=to-base64",
        text: ["Drop input here", "To Base64"],
      },
      {
        headings: ["Recipe"],
        path: "/?recipe=reverse",
        text: ["Drop input here", "Reverse"],
      },
      { headings: ["Recipe"], path: "/#settings", text: ["Drop input here"] },
      {
        headings: ["Recipe"],
        path: "/?recipe=zip",
        text: ["Drop input here", "Zip"],
      },
    ];

    const content = readRouteDistinctContent(shellRoutes);

    expect(content.get("/?recipe=to-base64")).toContain("Drop input here");
    expect(content.get("/?recipe=to-base64")).toContain("Recipe");
    expect(content.get("/?recipe=to-base64")).toContain("To Base64");
  });

  it("keeps a single-shell app's nav-listed content as route-distinct", () => {
    // cyberchef (2026-08-08): the operations sidebar is nav-role markup, so
    // its names land in primaryNavigation and swallow their text matches as
    // chrome — but on a single-shell app there is no cross-page navigation
    // to discount; the "nav" is the product. Zero-row-table and
    // assert-matching gates still guard hollowness downstream.
    const shellRoutes = [
      {
        headings: [],
        path: "/?op=From%20Base64",
        primaryNavigation: ["From Base64", "To Base64", "Magic"],
        text: ["From Base64", "Operations", "Recipe"],
      },
      {
        headings: [],
        path: "/?op=Magic",
        primaryNavigation: ["From Base64", "To Base64", "Magic"],
        text: ["Magic", "Operations", "Recipe"],
      },
    ];

    const content = readRouteDistinctContent(shellRoutes);

    expect(content.get("/?op=From%20Base64")).toContain("From Base64");
    expect(content.get("/?op=Magic")).toContain("Magic");
  });

  it("still detects chrome across hash-routed pages", () => {
    // /#/… is hash routing — real pages, exactly like pathname routing
    // (conduit). A sidebar repeated across them stays chrome.
    const hashRoutes = [
      "/#/feed",
      "/#/editor",
      "/#/settings",
      "/#/article/x",
    ].map((path, index) => ({
      headings: [`Page ${index}`],
      path,
      text: ["Conduit sidebar"],
    }));

    const content = readRouteDistinctContent(hashRoutes);

    expect(content.get("/#/feed")).toEqual(["Page 0"]);
  });

  it("steers a stuck-loading route at the runtime, never at feature wording", async () => {
    // cyberchef (2026-08-08 matrix): the app sat on its full-page loading
    // overlay through the whole exploration — text harvested from the DOM
    // behind the overlay, zero exercisable actions, no errors anywhere —
    // and five repair rounds chased featureInventory wording alignment.
    const recipe = preparedFeature({
      description: "Demonstrate building an encoding recipe",
      entryPaths: ["/"],
      id: "encode-recipe",
      label: "Encoding recipe",
      requestedFeature:
        "Paste sample input, add an encoding operation to the recipe, and inspect the transformed output",
    });
    const { result } = await exploreObservation({
      featureInventory: [recipe],
      routes: [
        observedRoute({
          buttons: ["To Base64", "From Base64", "Bake!"],
          featureIds: ["encode-recipe"],
          loadingOverlay: true,
          path: "/",
          text: ["Download CyberChef", "Options", "To Base64", "Bake!"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain("loading overlay");
    expect(result.validationReport.logsSummary).toContain(
      "never finished initializing",
    );
    expect(result.validationReport.logsSummary).not.toContain(
      "align the featureInventory wording",
    );
  });

  it("fails a requested feature grounded only over a zero-row data table", async () => {
    // Hollow pass #3: the invoices route rendered populated summary cards
    // while its data table stayed at zero rows, and grounding accepted the
    // card text as content. The table is the feature's data surface — cards
    // and tab labels render from separate queries in hollow and healthy apps
    // alike — so a requested feature's tagged route with a zero-row table
    // must not count as content-bearing for that feature.
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/en/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoicing],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 9,
              headerTexts: ["Invoice no.", "Due date", "Amount"],
            },
          ],
          featureIds: ["invoicing"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search invoices..." },
              name: "Search invoices...",
              outcome: "The field contained the observed demo value",
            },
          ],
          path: "/en/invoices",
          primaryNavigation: ["Overview"],
          requestedPath: "/en/invoices",
          text: ["Open $4,200", "Paid $1,800", "Payment score Good"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      "zero-row data table as the feature's data surface",
    );
    expect(result.validationReport.logsSummary).toContain(
      "column headers, zero data rows",
    );
    // The gate reports the observation with both candidate causes — it
    // cannot discriminate empty data from a zero-height virtualizer
    // (midday, 2026-08-07 matrix), so it must not assert either one.
    expect(result.validationReport.logsSummary).toContain(
      "virtualized table body",
    );
    expect(result.validationReport.logsSummary).not.toContain(
      "align the fixture shape",
    );
  });

  it("names the stuck-loading cause when a zero-row table mounted textless skeleton rows", async () => {
    // Midday (2026-08-09): the transactions table mounted rows whose every
    // cell was empty — loading skeletons for a query that never resolves.
    // Neither of the two-cause candidates (empty query, zero-height
    // virtualizer) fits, so both repair rounds steered at fixture shape
    // while the actual defect was the wiring between fixture and UI. Rows
    // without text are a third, distinguishable state, and the declared
    // data seam names exactly where to repair it.
    const transactions = preparedFeature({
      dataSeams: [
        {
          fixtureModule: "src/demo/transaction-fixtures.ts",
          functionName: "getTransactions",
          path: "apps/dashboard/src/lib/queries.ts",
        },
      ],
      description: "Demonstrate transactions",
      entryPaths: ["/transactions"],
      id: "transactions",
      label: "Transactions",
      requestedFeature: "transactions",
    });
    const { result } = await exploreObservation({
      featureInventory: [transactions],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 8,
              headerTexts: ["Date", "Description", "Amount"],
              skeletonRows: 12,
            },
          ],
          featureIds: ["transactions"],
          interactions: [
            {
              kind: "fill",
              locator: {
                strategy: "placeholder",
                value: "Search transactions...",
              },
              name: "Search transactions...",
              outcome: "The field contained the observed demo value",
            },
          ],
          path: "/transactions",
          primaryNavigation: ["Overview"],
          requestedPath: "/transactions",
          text: ["Search transactions...", "Review"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "empty/unmeaningful app state",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      "12 textless skeleton rows",
    );
    expect(result.validationReport.logsSummary).toContain("never resolved");
    // Steering points at the declared seam, not at fixture shape.
    expect(result.validationReport.logsSummary).toContain("getTransactions");
    expect(result.validationReport.logsSummary).toContain(
      "src/demo/transaction-fixtures.ts",
    );
    expect(result.validationReport.logsSummary).not.toContain(
      "virtualized table body",
    );
  });

  it("keeps a requested feature grounded when its route also renders a populated data table", async () => {
    // The zero-row veto reads "the data surface rendered empty", so a route
    // whose tables include a populated one — an incidental empty secondary
    // table beside the feature's populated primary table — stays
    // demonstrable: its rows are the honest content evidence.
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/en/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoicing],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 4,
              headerTexts: ["Draft no.", "Customer", "Amount", "Status"],
            },
          ],
          featureIds: ["invoicing"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Search invoices..." },
              name: "Search invoices...",
              outcome: "The field contained the observed demo value",
            },
          ],
          path: "/en/invoices",
          populatedDataTables: 1,
          primaryNavigation: ["Overview"],
          requestedPath: "/en/invoices",
          text: ["INV-001 Aperture Labs $4,200", "INV-002 Cedar & Co. $1,800"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "none",
      status: "passed",
    });
  });

  it("grounds a requested feature whose second tagged route renders content without an empty table", async () => {
    // The zero-row veto is per route, not per feature: a detail route that
    // renders the feature's data keeps the feature demonstrable even when
    // the index route's table is empty.
    const invoicing = preparedFeature({
      description: "Demonstrate invoicing",
      entryPaths: ["/en/invoices"],
      id: "invoicing",
      label: "Invoices",
      requestedFeature: "invoicing",
    });
    const { result } = await exploreObservation({
      featureInventory: [invoicing],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 9,
              headerTexts: ["Invoice no.", "Due date", "Amount"],
            },
          ],
          featureIds: ["invoicing"],
          path: "/en/invoices",
          primaryNavigation: ["Overview"],
          requestedPath: "/en/invoices",
          text: ["Open $4,200"],
        }),
        observedRoute({
          featureIds: ["invoicing"],
          headings: ["Invoice INV-001 for Aperture Labs"],
          path: "/en/invoices/inv-001",
          primaryNavigation: ["Overview"],
          requestedPath: "/en/invoices/inv-001",
          text: ["Due in 14 days"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "none",
      status: "passed",
    });
  });

  it("adds a feature-matching assert candidate beyond the distinct-first cap", async () => {
    // The cap-3 distinct-first slots can all go to strings matching no
    // feature — download buttons, settings labels — while the texts that
    // could token-match a feature sit past the cap. Preparation cannot
    // influence which texts become asserts, so every feature tagged to the
    // route gets at least one verified text whose tokens match it.
    const base64 = preparedFeature({
      description: "Encode text to Base64.",
      entryPaths: ["/"],
      id: "base64-encoding",
      label: "Base64 encoding",
      requestedFeature: "base64 encoding",
    });
    const hashing = preparedFeature({
      description: "Produce an MD5 digest.",
      entryPaths: ["/"],
      id: "md5-hashing",
      label: "MD5 hashing",
      requestedFeature: "md5 hashing",
    });
    const { result } = await exploreObservation({
      featureInventory: [base64, hashing],
      routes: [
        observedRoute({
          featureIds: ["base64-encoding", "md5-hashing"],
          path: "/",
          text: [
            "Download CyberChef file_download",
            "Options settings",
            "About / Support help",
            "To Base64",
            "MD5 hashing",
          ],
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        featureIds: ["base64-encoding"],
        kind: "assert",
        preferredLocator: { strategy: "text", value: "To Base64" },
      }),
    );
    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        featureIds: ["md5-hashing"],
        kind: "assert",
        preferredLocator: { strategy: "text", value: "MD5 hashing" },
      }),
    );
  });

  it("emits text asserts alongside heading asserts on the same route", async () => {
    // Heading presence used to gate text asserts off entirely, so a
    // dashboard whose data renders under a page title had no assertable
    // data text — features grounded by content, not by the title, failed
    // as wording mismatches. Both assert kinds must coexist.
    const { result } = await exploreObservation({
      routes: [
        observedRoute({
          headings: ["Fleet dashboard"],
          text: [
            "Total balance $12,400",
            "Seven vehicles are currently active",
          ],
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: {
          name: "Fleet dashboard",
          strategy: "role",
          value: "heading",
        },
      }),
    );
    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: { strategy: "text", value: "Total balance $12,400" },
      }),
    );
  });

  it("fails a requested feature whose catalog tagging cannot satisfy flow planning", async () => {
    // Exploration grounds a feature on exercised evidence alone, but flow
    // planning demands an interaction AND a visible assertion. When no
    // on-screen string shares a token with the feature wording, even the
    // assert floor cannot help, flow planning is structurally
    // unsatisfiable, and the gap must fail here, where preparation repair
    // can render assertable content or reselect the feature.
    const posting = preparedFeature({
      description: "Publish a new article.",
      entryPaths: ["/#/article/demo"],
      id: "post-article",
      label: "Posting an article",
      requestedFeature: "posting an article",
    });
    const comments = preparedFeature({
      description: "Comment on an article.",
      entryPaths: ["/#/article/demo"],
      id: "article-comments",
      label: "Article comments",
      requestedFeature: "article comments",
    });
    const { result } = await exploreObservation({
      featureInventory: [posting, comments],
      routes: [
        observedRoute({
          featureIds: ["post-article", "article-comments"],
          headings: ["Publish demo draft"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Write a comment..." },
              name: "Write a comment...",
              outcome: "The comment field contained the observed article text",
            },
          ],
          path: "/#/article/demo",
          requestedPath: "/#/article/demo",
          text: ["A shared placeholder draft body"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "requested feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      '"article comments" lacks a visible-text assert',
    );
    expect(result.validationReport.logsSummary).toContain(
      "reselect featureInventory",
    );
    // The route is content-bearing, so the gap is a wording mismatch, not a
    // rendering defect: the steering must name the shown labels so the
    // repair aligns featureInventory wording instead of reworking the data
    // path.
    expect(result.validationReport.logsSummary).toContain(
      "align the featureInventory wording",
    );
    expect(result.validationReport.logsSummary).toContain("Publish demo draft");
  });

  it("fails forced agent-selected features whose tagging cannot satisfy flow planning", async () => {
    // conduit (2026-08-07): no maker-requested features, so the evidence-gap
    // check skipped every inventory entry — yet flow planning must select
    // min(3, |inventory|) features, and comment-on-article had zero tagged
    // asserts. With no token-overlapping string for the assert floor to
    // multi-tag, this stays structurally unsatisfiable from planning's
    // first attempt; the wedge must fail here, where preparation repair can
    // act.
    const asAgentSelected = ({
      requestedFeature: _requestedFeature,
      ...feature
    }: PreparedDemoFeature): PreparedDemoFeature => feature;
    const posting = asAgentSelected(
      preparedFeature({
        description: "Publish a new article.",
        entryPaths: ["/#/article/demo"],
        id: "post-article",
        label: "Posting an article",
      }),
    );
    const comments = asAgentSelected(
      preparedFeature({
        description: "Comment on an article.",
        entryPaths: ["/#/article/demo"],
        id: "article-comments",
        label: "Article comments",
      }),
    );
    const { result } = await exploreObservation({
      featureInventory: [posting, comments],
      routes: [
        observedRoute({
          featureIds: ["post-article", "article-comments"],
          headings: ["Publish demo draft"],
          interactions: [
            {
              kind: "fill",
              locator: { strategy: "placeholder", value: "Write a comment..." },
              name: "Write a comment...",
              outcome: "The comment field contained the observed article text",
            },
          ],
          path: "/#/article/demo",
          requestedPath: "/#/article/demo",
          text: ["A shared placeholder draft body"],
        }),
      ],
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "prepared feature not observable",
      status: "failed",
    });
    expect(result.validationReport.logsSummary).toContain(
      '"Article comments" lacks a visible-text assert',
    );
    expect(result.validationReport.logsSummary).toContain(
      "reselect featureInventory",
    );
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
      workspace: createFakeAgentHarnessWorkspace({
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
      }),
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
      workspace: createFakeAgentHarnessWorkspace({
        async executeSubmittedCode(command) {
          if (command.includes("explore-app.mjs")) {
            throw new AgentHarnessCommandTimeoutError(300_000);
          }
          return command.includes("exploration.json")
            ? { exitCode: 0, stderr: "", stdout: protocol }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    });

    expect(requireArtifacts(result).appMap.discoveredRoutes[0]).toMatchObject({
      headings: ["Dashboard"],
    });
  });

  it("never navigates router-pattern entry paths that slip past the manifest gate", async () => {
    // Defense in depth behind the manifest rejection: a placeholder like
    // /collection/:collectionSlug navigated verbatim is a guaranteed 404
    // (outline, 2026-08-08). The generated script must only receive
    // concrete targets.
    const protocol = JSON.stringify({
      blockedNetworkAttempts: [],
      consoleErrors: [],
      pageErrors: [],
      routes: [observedRoute({ headings: ["Dashboard"] })],
      unreachableRoutes: [],
    });
    let explorerScript = "";
    await exploreSubmittedApp({
      baseUrl,
      featureInventory: [
        preparedFeature({
          entryPaths: ["/collection/demo-collection", "/doc/:documentSlug"],
        }),
      ],
      preparationManifestId: "prep_001",
      workspace: createFakeAgentHarnessWorkspace({
        async executeSubmittedCode(command) {
          if (command.includes("explore-app.mjs")) {
            const encoded = /printf %s '([^']+)' \| base64 -d/.exec(command);
            explorerScript = Buffer.from(encoded?.[1] ?? "", "base64").toString(
              "utf8",
            );
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          return command.includes("exploration.json")
            ? { exitCode: 0, stderr: "", stdout: protocol }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    });

    expect(explorerScript).toContain("/collection/demo-collection");
    expect(explorerScript).not.toContain("/doc/:documentSlug");
  });

  it("returns a repairable failure instead of throwing when the explorer crashes", async () => {
    const result = await exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: createFakeAgentHarnessWorkspace({
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
      }),
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
      workspace: createFakeAgentHarnessWorkspace({
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
      }),
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

  it("classifies an exploration timeout with the app still up as a repairable render timeout", async () => {
    // Outline (2026-08-09): the final exploration attempt hung for the full
    // 420s protocol budget and the raw Daytona timeout escaped unclassified,
    // killing the run and forfeiting its reserved repair rounds. An app
    // that is up but never yields a protocol is a wedged route, not
    // infrastructure.
    const result = await exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: createFakeAgentHarnessWorkspace({
        async executeSubmittedCode(_command, options) {
          throw new AgentHarnessCommandTimeoutError(options?.timeoutMs ?? 0);
        },
        async readSubmittedCodeAppStatus() {
          return {
            running: true,
            stderr: "GET /collection/product-handbook-demo pending",
            stdout: "",
          };
        },
      }),
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "render timeout",
        logsSummary: expect.stringContaining("still running"),
        status: "failed",
      },
    });
    expect(result.validationReport.logsSummary).toContain("never completed");
  });

  it("preserves an exploration timeout when managed app status is unavailable", async () => {
    const exploration = exploreSubmittedApp({
      baseUrl,
      preparationManifestId: "prep_001",
      workspace: createFakeAgentHarnessWorkspace({
        async executeSubmittedCode() {
          throw new AgentHarnessCommandTimeoutError(5 * 60_000);
        },
        async readSubmittedCodeAppStatus() {
          throw new Error("Daytona status unavailable");
        },
      }),
    });

    await expect(exploration).rejects.toBeInstanceOf(
      AgentHarnessCommandTimeoutError,
    );
  });
});

describe("feature verdict ledger", () => {
  it("records grounded verdicts with their evidence class on a passed report", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/holdings"],
          id: "holding-management",
          label: "Holding management",
          requestedFeature: "managing holdings",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["holding-management"],
          headings: ["Holding management"],
          interactions: [
            {
              kind: "click",
              locator: {
                name: "Add holding",
                strategy: "role",
                value: "button",
              },
              locatorEvidence: {
                locator: {
                  exact: true,
                  name: "Add holding",
                  role: "button",
                  strategy: "role",
                },
                verification: {
                  matchCount: 1,
                  route: "/holdings",
                  visible: true,
                },
              },
              name: "Add holding",
              outcome: "Add holding dialog became visible",
            },
          ],
          path: "/holdings",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.validationReport.featureVerdicts).toEqual([
      {
        detail: "Add holding dialog became visible",
        evidence: ["click-interaction-1-1"],
        featureId: "holding-management",
        groundedBy: "interaction",
        verdict: "grounded",
      },
    ]);
  });

  it("grounds a feature through a recorded control state transition", async () => {
    // N105: a toggle that renames itself (Follow → Unfollow) or enables a
    // control is wording-free proof of behavior; the ledger names it as its
    // own evidence class so steering never asks for wording alignment.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Follow another author.",
          entryPaths: ["/#/profile"],
          id: "follow-author",
          label: "Follow an author",
          requestedFeature: "following an author",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["follow-author"],
          headings: ["Author profile"],
          interactions: [
            {
              kind: "click",
              locator: { name: "Follow", strategy: "role", value: "button" },
              locatorEvidence: {
                locator: {
                  exact: true,
                  name: "Follow",
                  role: "button",
                  strategy: "role",
                },
                verification: {
                  matchCount: 1,
                  route: "/#/profile",
                  visible: true,
                },
              },
              name: "Follow",
              outcome: "Follow became Unfollow",
              stateTransition: {
                control: "Follow",
                from: "Follow",
                to: "Unfollow",
              },
            },
          ],
          path: "/#/profile",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("Unfollow"),
        featureId: "follow-author",
        groundedBy: "state-transition",
        verdict: "grounded",
      }),
    ]);
    const clickAction = artifacts.actionCatalog.actions.find(
      (action) => action.kind === "click" && action.exercised === true,
    );
    expect(clickAction?.stateTransition).toEqual({
      control: "Follow",
      from: "Follow",
      to: "Unfollow",
    });
  });

  it("observes transitions, skips disabled controls, and re-proves through stored locator evidence in the generated script", async () => {
    const { commands } = await exploreObservation({
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("readStateTransition");
    expect(script).toContain("[disabled] → [enabled]");
    expect(script).toContain("isEnabled");
    // Zero matches on the fresh-state name lookup must fall back to the
    // stored verified locator before the interaction is dropped (N105).
    expect(script).toContain("resolveStoredLocator");
  });

  it("grounds a feature through its passed declared proof regardless of wording", async () => {
    // N107: the proof is the evidence. The route's rendered wording shares
    // nothing with the feature, and grounding must not depend on it.
    const { result } = await exploreObservation({
      declaredProofs: [
        {
          detail: '"Published demo article" is visible on /#/editor',
          featureId: "post-article",
          passed: true,
        },
      ],
      featureInventory: [
        preparedFeature({
          expectedProof: {
            kind: "visible-text",
            text: "Published demo article",
          },
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: ["Wombat maintenance schedule"],
          path: "/#/editor",
          requestedPath: "/#/editor",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        featureId: "post-article",
        groundedBy: "declared-proof",
        verdict: "grounded",
      }),
    ]);
    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        featureIds: ["post-article"],
        id: "declared-proof-post-article",
        kind: "assert",
        preferredLocator: {
          strategy: "text",
          value: "Published demo article",
        },
      }),
    );
  });

  it("normalizes a bare fragment entryPath into observed route space for declared-proof actions", async () => {
    // N124 (homer): the manifest contract legally allows entryPaths that
    // start with "#" or "?", but every observed AppMap route lives in
    // pathname+search+hash space. A declared-proof action carrying the raw
    // "#additional-page" would point Capture at a route the catalog never
    // observed, so ingestion must normalize entryPaths against the base URL.
    const { result } = await exploreObservation({
      declaredProofs: [
        {
          detail: '"This is another page" is visible on /#additional-page',
          featureId: "additional-page",
          passed: true,
        },
      ],
      featureInventory: [
        preparedFeature({
          entryPaths: ["#additional-page"],
          expectedProof: {
            kind: "visible-text",
            text: "This is another page",
          },
          id: "additional-page",
          label: "Additional page",
          requestedFeature: "additional page",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["additional-page"],
          headings: ["Additional page"],
          path: "/#additional-page",
          requestedPath: "/#additional-page",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        id: "declared-proof-additional-page",
        route: "/#additional-page",
      }),
    );
    // Ingestion-time normalization is the invariant: no catalog action may
    // ever carry a route outside the observed pathname+search+hash space.
    for (const action of artifacts.actionCatalog.actions) {
      expect(action.route).toMatch(/^\//);
    }
  });

  it("reclassifies regrounding as unreproducible when prefix replay cannot find the candidate", async () => {
    // N125(3): the candidate stayed missing even in the replayed capture
    // context, so the exploration-time evidence does not exist in the state
    // the demo replays. That is app-state divergence for preparation
    // repair; the script channel cannot fix an app that no longer shows
    // the element.
    const { result } = await exploreObservation({
      captureFailure: {
        actionId: "click-save",
        locator: { name: "Save entry", role: "button", strategy: "role" },
        locatorCandidateId: "save-entry-locator-1",
        sceneId: "scene-editor",
        scenePrefix: [{ id: "goto-root", path: "/", type: "goto" }],
        screenshotPath: "/tmp/run/makeademo-validation-failure.png",
      },
      replayVerification: {
        actionId: "click-save",
        detail:
          "locator matched 0 visible element(s) after replaying 1 prefix action(s) in Scene scene-editor",
        locatorCandidateId: "save-entry-locator-1",
        reproduced: false,
        sceneId: "scene-editor",
      },
      routes: [observedRoute({ headings: ["Records workspace"] })],
    });

    expect(result.kind).toBe("repairable-failure");
    expect(result.validationReport).toMatchObject({
      failureClassification: "evidence unreproducible at replay",
      status: "failed",
    });
    // The exploration-vs-replay evidence pair: the certified locator on one
    // side, the replayed observation on the other.
    expect(result.validationReport.logsSummary).toContain("click-save");
    expect(result.validationReport.logsSummary).toContain("Save entry");
    expect(result.validationReport.logsSummary).toContain(
      "matched 0 visible element(s)",
    );
    expect(result.validationReport.screenshots).toContain(
      "/tmp/run/makeademo-validation-failure.png",
    );
  });

  it("keeps regrounding artifacts when prefix replay reproduces the candidate", async () => {
    // A reproduced candidate means the exploration evidence stands; the
    // capture failure was transient, and regrounding proceeds normally.
    const { result } = await exploreObservation({
      captureFailure: {
        actionId: "click-save",
        locator: { name: "Save entry", role: "button", strategy: "role" },
        locatorCandidateId: "save-entry-locator-1",
        sceneId: "scene-editor",
        scenePrefix: [{ id: "goto-root", path: "/", type: "goto" }],
      },
      replayVerification: {
        actionId: "click-save",
        detail:
          "locator resolved to one visible element after replaying 1 prefix action(s) in Scene scene-editor",
        locatorCandidateId: "save-entry-locator-1",
        reproduced: true,
        sceneId: "scene-editor",
      },
      routes: [observedRoute({ headings: ["Records workspace"] })],
    });

    requireArtifacts(result);
  });

  it("fails a feature whose declared proof failed even when wording would ground it", async () => {
    // The excalidraw vacuous-pass hole: "undo/redo" must pass its declared
    // transition, not ride a nearby heading. A failed proof subsumes every
    // wording bridge.
    const { result } = await exploreObservation({
      declaredProofs: [
        {
          detail:
            'control "Follow" reads "Follow" after the click; declared to "Unfollow"',
          featureId: "post-article",
          passed: false,
        },
      ],
      featureInventory: [
        preparedFeature({
          expectedProof: {
            from: "Follow",
            kind: "state-transition",
            locator: "Follow",
            to: "Unfollow",
          },
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: ["Posting an article"],
          path: "/#/editor",
          requestedPath: "/#/editor",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('declared to "Unfollow"'),
        failedBecause: "declared-proof-failed",
        featureId: "post-article",
        verdict: "failed",
      }),
    ]);
    expect(result.validationReport.logsSummary).toContain("declared proof");
  });

  it("falls back to wording grounding when a declared proof was never executed", async () => {
    // An unexecuted proof (deadline, unreachable entry) is missing
    // evidence, not failed evidence: the wording chain still applies.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          expectedProof: {
            kind: "visible-text",
            text: "Published demo article",
          },
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["post-article"],
          headings: ["Posting an article"],
          path: "/#/editor",
          requestedPath: "/#/editor",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        featureId: "post-article",
        groundedBy: "assert",
        verdict: "grounded",
      }),
    ]);
  });

  it("embeds declared proof targets in the generated script", async () => {
    const { commands } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          expectedProof: {
            kind: "visible-text",
            text: "Published demo article",
          },
        }),
      ],
      routes: [observedRoute({ headings: ["Dashboard"] })],
    });
    const script = readExplorerScript(commands);

    expect(script).toContain("declaredProofTargets");
    expect(script).toContain("result.declaredProofs");
  });

  it("names the winning feature and steers at an unclaimed entry route when the crawl never tagged the feature", async () => {
    // The untagged corner: allocation-chart's entry route rendered content
    // whose tokens overlap the feature, but the crawl tagged the route to
    // portfolio-overview alone (redirect or tagging miss). The assert floor
    // cannot reach an untagged feature, so route-shared-with-winners is the
    // honest verdict and the steering asks for an unclaimed entry route.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Show the portfolio overview.",
          entryPaths: ["/en/portfolio"],
          id: "portfolio-overview",
          label: "Portfolio overview",
          requestedFeature: "portfolio overview",
        }),
        preparedFeature({
          description: "Chart the portfolio allocation split.",
          entryPaths: ["/en/portfolio"],
          id: "allocation-chart",
          label: "Allocation chart",
          requestedFeature: "allocation chart",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["portfolio-overview"],
          headings: ["Portfolio holdings overview"],
          path: "/en/portfolio",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        featureId: "portfolio-overview",
        groundedBy: "assert",
        verdict: "grounded",
      }),
      expect.objectContaining({
        detail: expect.stringContaining('"Portfolio holdings overview"'),
        failedBecause: "route-shared-with-winners",
        featureId: "allocation-chart",
        verdict: "failed",
      }),
    ]);
    const failed = result.validationReport.featureVerdicts?.[1];
    expect(failed?.detail).toContain("portfolio-overview");
    expect(result.validationReport.logsSummary).toContain(
      "an entry route no other feature claims",
    );
    expect(result.validationReport.logsSummary).toContain(
      '"Portfolio holdings overview"',
    );
  });

  it("keeps at least one assert for a route-tagged feature the winners out-scored", async () => {
    // Winner-take-all tagging awards every shared string to the strongest
    // feature, leaving a co-tagged feature assertless and failing the whole
    // run — even though one shared heading could serve both. The floor
    // multi-tags the best wording-matched assert so the feature grounds.
    const overview = preparedFeature({
      description: "Review the portfolio holdings overview.",
      entryPaths: ["/en/portfolio"],
      id: "portfolio-overview",
      label: "Portfolio overview",
      requestedFeature: "portfolio overview",
    });
    const allocation = preparedFeature({
      description: "Chart the holdings allocation.",
      entryPaths: ["/en/portfolio"],
      id: "allocation-chart",
      label: "Allocation chart",
      requestedFeature: "allocation chart",
    });
    const { result } = await exploreObservation({
      featureInventory: [overview, allocation],
      routes: [
        observedRoute({
          featureIds: ["portfolio-overview", "allocation-chart"],
          headings: [
            "Portfolio holdings overview",
            "Overview performance summary",
          ],
          path: "/en/portfolio",
          requestedPath: "/en/portfolio",
        }),
      ],
    });
    const artifacts = requireArtifacts(result);

    expect(artifacts.validationReport.status).toBe("passed");
    expect(artifacts.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        featureIds: ["portfolio-overview", "allocation-chart"],
        kind: "assert",
        preferredLocator: expect.objectContaining({
          name: "Portfolio holdings overview",
        }),
      }),
    );
    expect(artifacts.validationReport.featureVerdicts).toContainEqual(
      expect.objectContaining({
        featureId: "allocation-chart",
        groundedBy: "assert",
        verdict: "grounded",
      }),
    );
  });

  it("distinguishes a token mismatch from shared-route loss and names the on-screen content", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Show the portfolio overview.",
          entryPaths: ["/en/portfolio"],
          id: "portfolio-overview",
          label: "Portfolio overview",
          requestedFeature: "portfolio overview",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["portfolio-overview"],
          headings: ["Wombat maintenance schedule"],
          path: "/en/portfolio",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("Wombat maintenance schedule"),
        failedBecause: "token-mismatch",
        featureId: "portfolio-overview",
        verdict: "failed",
      }),
    ]);
    expect(result.validationReport.logsSummary).toContain(
      "align the featureInventory wording",
    );
  });

  it("marks error-state routes as runtime faults that wording cannot repair", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/broken"],
          id: "invoice-review",
          label: "Invoice review",
          requestedFeature: "reviewing invoices",
        }),
      ],
      pageErrors: [
        "http://127.0.0.1:3000/broken: TypeError: Cannot read properties of undefined",
      ],
      routes: [
        observedRoute({
          featureIds: ["invoice-review"],
          headings: ["Application error"],
          path: "/broken",
        }),
        observedRoute({
          headings: ["Completely unrelated welcome copy"],
          path: "/",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("TypeError"),
        failedBecause: "error-state-route",
        featureId: "invoice-review",
        verdict: "failed",
      }),
    ]);
    expect(result.validationReport.logsSummary).toContain(
      "featureInventory wording cannot help",
    );
  });

  it("treats a 4xx or 5xx document response as an error state no matter what the page renders", async () => {
    // ghostfolio-class failure: the server answers the entry route with a
    // 500 whose body still renders headings. Any wording steering there is
    // a lie — the fault is the runtime, and only the document status says
    // so once the page paints a plausible-looking shell.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Browse generated reports.",
          entryPaths: ["/reports"],
          id: "report-list",
          label: "Report list",
          requestedFeature: "report list",
        }),
      ],
      routes: [
        observedRoute({
          documentStatus: 500,
          featureIds: ["report-list"],
          headings: ["Report list"],
          path: "/reports",
          requestedPath: "/reports",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("HTTP 500"),
        failedBecause: "error-state-route",
        featureId: "report-list",
        verdict: "failed",
      }),
    ]);
    expect(result.validationReport.featureVerdicts?.[0]?.detail).toContain(
      "runtime fault, not a wording fault",
    );
  });

  it("reads a bare error body as an error state and carries the sample as evidence", async () => {
    // A crashed SPA route serves HTTP 200 and paints nothing but the
    // exception text in an unstyled body: no headings, no verifiable text.
    // The bounded innerText sample is the only witness, and its error shape
    // must route the failure to runtime repair, not wording alignment.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Browse generated reports.",
          entryPaths: ["/reports"],
          id: "report-list",
          label: "Report list",
          requestedFeature: "report list",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["report-list"],
          path: "/reports",
          requestedPath: "/reports",
          textSample:
            "TypeError: Cannot read properties of undefined (reading 'map') at ReportList.render",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("TypeError"),
        failedBecause: "error-state-route",
        featureId: "report-list",
        verdict: "failed",
      }),
    ]);
  });

  it("keeps a plain-worded empty body out of the error-state diagnosis", async () => {
    // The sample only diagnoses when it is error-shaped: a thin route whose
    // body text is ordinary copy stays a wording problem, not a runtime
    // fault.
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Browse generated reports.",
          entryPaths: ["/reports"],
          id: "report-list",
          label: "Report list",
          requestedFeature: "report list",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["report-list"],
          path: "/reports",
          requestedPath: "/reports",
          textSample: "Welcome to the reporting workspace",
        }),
      ],
    });

    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        failedBecause: "no-assert-candidates",
        featureId: "report-list",
        verdict: "failed",
      }),
    ]);
  });

  it("marks the empty-table veto as skeleton rows with the table shape in the detail", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Review recent transactions.",
          entryPaths: ["/transactions"],
          id: "transaction-review",
          label: "Transaction review",
          requestedFeature: "transaction review",
        }),
      ],
      routes: [
        observedRoute({
          emptyDataTables: [
            {
              columnHeaders: 5,
              headerTexts: ["Date", "Payee", "Amount"],
              skeletonRows: 6,
            },
          ],
          featureIds: ["transaction-review"],
          headings: ["Transactions"],
          path: "/transactions",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("6 textless skeleton rows"),
        failedBecause: "skeleton-rows",
        featureId: "transaction-review",
        verdict: "failed",
      }),
    ]);
  });

  it("marks auth-walled features and unreachable entry routes with their own enums", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/invoices"],
          id: "invoice-list",
          label: "Invoice list",
          requestedFeature: "listing invoices",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["invoice-list"],
          headings: ["Sign in"],
          inputs: ["Email", "Password"],
          path: "/invoices",
        }),
      ],
    });
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        failedBecause: "auth-wall",
        featureId: "invoice-list",
        verdict: "failed",
      }),
    ]);

    const unreachable = await exploreObservation({
      featureInventory: [
        preparedFeature({
          entryPaths: ["/reports"],
          id: "report-review",
          label: "Report review",
          requestedFeature: "reviewing reports",
        }),
      ],
      routes: [observedRoute({ headings: ["Welcome home"] })],
      unreachableRoutes: [
        {
          error: "net::ERR_CONNECTION_REFUSED",
          featureIds: ["report-review"],
          url: "http://127.0.0.1:3000/reports",
        },
      ],
    });
    expect(unreachable.result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("ERR_CONNECTION_REFUSED"),
        failedBecause: "app-unreachable",
        featureId: "report-review",
        verdict: "failed",
      }),
    ]);
  });

  it("marks routes with nothing to assert as no-assert-candidates", async () => {
    const { result } = await exploreObservation({
      featureInventory: [
        preparedFeature({
          description: "Browse the media library.",
          entryPaths: ["/library"],
          id: "media-library",
          label: "Media library",
          requestedFeature: "browsing the media library",
        }),
        preparedFeature({
          description: "Read the welcome dashboard.",
          entryPaths: ["/"],
          id: "welcome-dashboard",
          label: "Welcome dashboard",
          requestedFeature: "welcome dashboard",
        }),
      ],
      routes: [
        observedRoute({
          featureIds: ["media-library"],
          path: "/library",
        }),
        observedRoute({
          featureIds: ["welcome-dashboard"],
          headings: ["Welcome dashboard"],
          path: "/",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual([
      expect.objectContaining({
        failedBecause: "no-assert-candidates",
        featureId: "media-library",
        verdict: "failed",
      }),
      expect.objectContaining({
        featureId: "welcome-dashboard",
        groundedBy: "assert",
        verdict: "grounded",
      }),
    ]);
  });

  it("extends per-feature wording steering to default-demo features", async () => {
    const defaultFeature = (
      id: string,
      label: string,
      entryPath: string,
      description: string,
    ): PreparedDemoFeature => ({
      authStrategy: "none",
      description,
      entryPaths: [entryPath],
      fixtureNotes: [],
      id,
      label,
      sourcePaths: ["src/app.tsx"],
    });
    const { result } = await exploreObservation({
      featureInventory: [
        defaultFeature(
          "board-view",
          "Board view",
          "/board",
          "Show the kanban board view.",
        ),
        defaultFeature(
          "list-view",
          "List view",
          "/list",
          "Show the task list view.",
        ),
        defaultFeature(
          "settings-panel",
          "Settings panel",
          "/settings",
          "Adjust workspace settings.",
        ),
      ],
      routes: [
        observedRoute({
          featureIds: ["board-view"],
          headings: ["Board view"],
          path: "/board",
        }),
        observedRoute({
          featureIds: ["list-view"],
          headings: ["List view"],
          path: "/list",
        }),
        observedRoute({
          featureIds: ["settings-panel"],
          headings: ["Notification preferences"],
          path: "/settings",
        }),
      ],
    });

    expect(result.validationReport.status).toBe("failed");
    expect(result.validationReport.featureVerdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failedBecause: "token-mismatch",
          featureId: "settings-panel",
          verdict: "failed",
        }),
      ]),
    );
    expect(result.validationReport.logsSummary).toContain("Settings panel");
    expect(result.validationReport.logsSummary).toContain(
      "align the featureInventory wording",
    );
    expect(result.validationReport.logsSummary).toContain(
      "Notification preferences",
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
  captureFailure?: Parameters<typeof exploreSubmittedApp>[0]["captureFailure"];
  consoleErrors?: string[];
  dataStrategy?: Parameters<typeof exploreSubmittedApp>[0]["dataStrategy"];
  declaredProofs?: Array<{
    detail: string;
    featureId: string;
    passed: boolean;
  }>;
  failedScriptResponses?: Array<{ status: number; url: string }>;
  featureInventory?: PreparedDemoFeature[];
  pageErrors?: string[];
  readSubmittedCodeAppStatus?: AgentHarnessWorkspace["readSubmittedCodeAppStatus"];
  replayVerification?: {
    actionId: string;
    detail: string;
    locatorCandidateId?: string;
    reproduced: boolean;
    sceneId: string;
  };
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
    ...(input.captureFailure === undefined
      ? {}
      : { captureFailure: input.captureFailure }),
    ...(input.dataStrategy === undefined
      ? {}
      : { dataStrategy: input.dataStrategy }),
    ...(input.featureInventory === undefined
      ? {}
      : { featureInventory: input.featureInventory }),
    preparationManifestId: "prep_001",
    ...(input.requestedFeatures === undefined
      ? {}
      : { requestedFeatures: input.requestedFeatures }),
    workspace: createFakeAgentHarnessWorkspace({
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
            ...(input.declaredProofs === undefined
              ? {}
              : { declaredProofs: input.declaredProofs }),
            ...(input.failedScriptResponses === undefined
              ? {}
              : { failedScriptResponses: input.failedScriptResponses }),
            pageErrors: input.pageErrors ?? [],
            ...(input.replayVerification === undefined
              ? {}
              : { replayVerification: input.replayVerification }),
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
    }),
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

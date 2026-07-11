import { executeSubmittedCode } from "../daytona/submitted-code-execution";
import type { AgentHarnessWorkspace } from "../daytona/workspace.interface";
import {
  type ActionCatalog,
  type AppMap,
  type NetworkAttempt,
  type ValidationReport,
  type VerifiedLocatorCandidate,
  readActionCatalog,
  readAppMap,
  readValidationReport,
} from "../schemas/artifacts";

/**
 * The typed outcome of browser exploration. `repairable-failure` deliberately
 * omits AppMap and ActionCatalog so callers cannot plan a flow from fabricated
 * route evidence; they must route the attached report to preparation repair.
 */
export type SubmittedAppExplorationResult =
  | {
      actionCatalog: ActionCatalog;
      appMap: AppMap;
      kind: "artifacts";
      validationReport: ValidationReport;
    }
  | {
      kind: "repairable-failure";
      validationReport: ValidationReport;
    };

type ObservedLocatorEvidence = Omit<VerifiedLocatorCandidate, "id">;
type ObservedLink = {
  href: string;
  locatorEvidence?: ObservedLocatorEvidence | null;
  name: string;
  sameOrigin?: boolean;
};
type ObservedInputLocator = {
  controlKind: "fill" | "select";
  locatorEvidence?: ObservedLocatorEvidence | null;
  locator: {
    reason?: string;
    strategy: "css" | "label" | "placeholder";
    value: string;
  };
  name: string;
};
type ObservedRoute = {
  buttons: string[];
  buttonLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  forms: string[];
  headings: string[];
  headingLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  inputLocators?: ObservedInputLocator[];
  inputs: string[];
  links: ObservedLink[];
  path: string;
  primaryNavigation: string[];
  screenshot: string;
  snapshot: string;
  text: string[];
  textLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  title: string;
};
type BrowserExplorationProtocol = {
  blockedNetworkAttempts: Array<{ host: string; route?: string; url?: string }>;
  consoleErrors: string[];
  pageErrors: string[];
  routes: ObservedRoute[];
};

const explorerDirectory = "/workspace/.makeademo/exploration";
const explorerPath = `${explorerDirectory}/explore-app.mjs`;

/**
 * Explores the real prepared app with Playwright inside the secret-free
 * submitted-code sandbox. Implementations consuming this result can trust that
 * routes and locators came from browser observations rather than agent memory.
 */
export async function exploreSubmittedApp(input: {
  baseUrl: string;
  preparationManifestId: string;
  workspace: AgentHarnessWorkspace;
}): Promise<SubmittedAppExplorationResult> {
  const script = createExplorerScript(input.baseUrl);
  const encodedScript = Buffer.from(script).toString("base64");
  const result = await executeSubmittedCode(
    input.workspace,
    [
      `mkdir -p ${explorerDirectory}`,
      `printf %s ${shellQuote(encodedScript)} | base64 -d > ${explorerPath}`,
      `NODE_PATH="$(npm root -g)" bun ${explorerPath}`,
    ].join(" && "),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Submitted app exploration failed: ${result.stderr || result.stdout}`,
    );
  }

  const observation = readExplorationProtocol(result.stdout);
  if (observation.routes.length === 0) {
    return createRepairableExplorationFailure({
      baseUrl: input.baseUrl,
      observation,
    });
  }

  return createExplorationArtifacts({
    baseUrl: input.baseUrl,
    observation,
    preparationManifestId: input.preparationManifestId,
  });
}

function createExplorationArtifacts(input: {
  baseUrl: string;
  observation: BrowserExplorationProtocol;
  preparationManifestId: string;
}): SubmittedAppExplorationResult {
  const appMapId = `${input.preparationManifestId}_app_map`;
  const actionCatalogId = `${input.preparationManifestId}_actions`;
  const networkAttempts = readObservedNetworkAttempts(input.observation);
  const routes = input.observation.routes.map((route) => ({
    buttons: route.buttons,
    forms: route.forms,
    headings: route.headings,
    inputs: route.inputs,
    links: route.links.map((link) => link.href),
    path: route.path,
    primaryNavigation: route.primaryNavigation,
    screenshots: [route.screenshot],
    snapshotPath: route.snapshot,
    stableLocatorCandidates: createRouteLocatorCandidates(route),
    text: route.text,
    title: route.title,
  }));
  const loginOrAuthWalls = input.observation.routes
    .filter(isAuthWall)
    .map((route) => route.path);
  const appMap = readAppMap({
    accessibilitySnapshots: input.observation.routes.map(
      (route) => route.snapshot,
    ),
    actionCatalogId,
    appStateAssumptions: [],
    baseUrl: input.baseUrl,
    blockedNetworkAttempts: networkAttempts,
    buttons: unique(input.observation.routes.flatMap((route) => route.buttons)),
    candidateFlows: unique(
      input.observation.routes.flatMap((route) => [
        ...route.buttons,
        ...route.forms,
        ...route.inputs,
        ...route.links
          .filter((link) => link.sameOrigin !== false)
          .map((link) => link.name),
      ]),
    ),
    consoleErrors: unique(input.observation.consoleErrors),
    discoveredRoutes: routes,
    forms: unique(input.observation.routes.flatMap((route) => route.forms)),
    id: appMapId,
    inputs: unique(input.observation.routes.flatMap((route) => route.inputs)),
    links: unique(
      input.observation.routes.flatMap((route) =>
        route.links.map((link) => link.href),
      ),
    ),
    loginOrAuthWalls,
    networkAttempts,
    pageErrors: unique(input.observation.pageErrors),
    primaryNavigation: unique(
      input.observation.routes.flatMap((route) => route.primaryNavigation),
    ),
    routeTitles: Object.fromEntries(
      input.observation.routes.map((route) => [route.path, route.title]),
    ),
    screenshots: input.observation.routes.map((route) => route.screenshot),
    stableLocatorCandidates: unique(
      input.observation.routes.flatMap(createRouteLocatorCandidates),
    ),
  });
  const actionCatalog = readActionCatalog({
    actions: createActions(input.observation.routes),
    appMapId,
    id: actionCatalogId,
  });
  const validationReport = createExplorationValidationReport({
    appMap,
    networkAttempts,
  });

  return { actionCatalog, appMap, kind: "artifacts", validationReport };
}

function createRepairableExplorationFailure(input: {
  baseUrl: string;
  observation: BrowserExplorationProtocol;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const networkAttempts = readObservedNetworkAttempts(input.observation);
  return {
    kind: "repairable-failure",
    validationReport: readValidationReport({
      artifactReferences: [explorerPath],
      blockedNetworkAttempts: networkAttempts,
      browserObservations: [],
      consoleErrors: unique(input.observation.consoleErrors),
      failureClassification: "app route not discoverable",
      logsSummary:
        "Playwright completed exploration but did not discover a browser route to ground Flow Planning.",
      networkAttempts,
      pageErrors: unique(input.observation.pageErrors),
      retryCount: 0,
      screenshots: [],
      stage: "app-exploration",
      status: "failed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [
        "Repair the prepared app start command, base URL, route crash, or initial app state, then rerun browser exploration.",
      ],
      urlChecked: input.baseUrl,
    }),
  };
}

function createActions(routes: ObservedRoute[]) {
  const actions: Array<Record<string, unknown>> = [];
  routes.forEach((route, routeIndex) => {
    actions.push({
      confidence: 1,
      evidence: `Playwright loaded ${route.path}`,
      expectedResult: `${route.title || route.path} becomes visible`,
      id: `navigate-route-${routeIndex + 1}`,
      kind: "navigate",
      preferredLocator: {
        reason: "Navigation actions target an observed route, not an element.",
        strategy: "css",
        value: "body",
      },
      risks: [],
      route: route.path,
    });
    route.headings.forEach((heading, index) => {
      const locatorEvidence = route.headingLocatorEvidence?.[index];
      if (route.headingLocatorEvidence !== undefined && !locatorEvidence) {
        return;
      }
      const id = `assert-heading-${routeIndex + 1}-${index + 1}`;
      actions.push({
        confidence: 0.95,
        evidence: `Playwright observed heading on ${route.path}`,
        expectedResult: `${heading} remains visible`,
        id,
        kind: "assert",
        ...createLocatorCandidateFields(id, locatorEvidence),
        preferredLocator: {
          name: heading,
          strategy: "role",
          value: "heading",
        },
        risks: [],
        route: route.path,
      });
    });
    if (route.headings.length === 0) {
      const visibleText = route.text.find(
        (text, index) =>
          text.length > 0 &&
          (route.textLocatorEvidence === undefined ||
            Boolean(route.textLocatorEvidence[index])),
      );
      if (visibleText !== undefined) {
        const textIndex = route.text.indexOf(visibleText);
        const id = `assert-visible-text-${routeIndex + 1}`;
        actions.push({
          confidence: 0.85,
          evidence: `Playwright observed visible text on ${route.path}`,
          expectedResult: `${visibleText} remains visible`,
          id,
          kind: "assert",
          ...createLocatorCandidateFields(
            id,
            route.textLocatorEvidence?.[textIndex],
          ),
          preferredLocator: { strategy: "text", value: visibleText },
          risks: [],
          route: route.path,
        });
      } else {
        const visibleButton = route.buttons.find(
          (button, index) =>
            button.length > 0 &&
            (route.buttonLocatorEvidence === undefined ||
              Boolean(route.buttonLocatorEvidence[index])),
        );
        if (visibleButton !== undefined) {
          const buttonIndex = route.buttons.indexOf(visibleButton);
          const id = `assert-visible-control-${routeIndex + 1}`;
          actions.push({
            confidence: 0.85,
            evidence: `Playwright observed a visible control on ${route.path}`,
            expectedResult: `${visibleButton} remains visible`,
            id,
            kind: "assert",
            ...createLocatorCandidateFields(
              id,
              route.buttonLocatorEvidence?.[buttonIndex],
            ),
            preferredLocator: {
              name: visibleButton,
              strategy: "role",
              value: "button",
            },
            risks: [],
            route: route.path,
          });
        }
      }
    }
    route.buttons.forEach((button, index) => {
      const locatorEvidence = route.buttonLocatorEvidence?.[index];
      if (route.buttonLocatorEvidence !== undefined && !locatorEvidence) {
        return;
      }
      const id = `click-button-${routeIndex + 1}-${index + 1}`;
      actions.push({
        confidence: 0.9,
        evidence: `Playwright observed button on ${route.path}`,
        expectedResult: `Clicking ${button} changes visible app state`,
        id,
        kind: "click",
        ...createLocatorCandidateFields(id, locatorEvidence),
        preferredLocator: {
          name: button,
          strategy: "role",
          value: "button",
        },
        risks: [],
        route: route.path,
      });
    });
    route.links.forEach((link, index) => {
      if (
        link.name.length === 0 ||
        link.sameOrigin === false ||
        link.locatorEvidence === null
      ) {
        return;
      }
      const id = `click-link-${routeIndex + 1}-${index + 1}`;
      actions.push({
        confidence: 0.9,
        evidence: `Playwright observed link to ${link.href}`,
        expectedResult: `${link.href} becomes visible`,
        id,
        kind: "click",
        ...createLocatorCandidateFields(id, link.locatorEvidence),
        preferredLocator: {
          name: link.name,
          strategy: "role",
          value: "link",
        },
        risks: [],
        route: route.path,
      });
    });
    (route.inputLocators ?? []).forEach((input, index) => {
      if (input.locatorEvidence === null) {
        return;
      }
      const id = `${input.controlKind}-input-${routeIndex + 1}-${index + 1}`;
      actions.push({
        confidence: 0.9,
        evidence: `Playwright observed ${input.name} control on ${route.path}`,
        expectedResult:
          input.controlKind === "select"
            ? `Selecting an option in ${input.name} changes visible app state`
            : `Entering a value in ${input.name} changes visible app state`,
        id,
        kind: input.controlKind,
        ...createLocatorCandidateFields(id, input.locatorEvidence),
        preferredLocator: input.locator,
        risks: [],
        route: route.path,
      });
    });
  });

  return actions;
}

function createLocatorCandidateFields(
  actionId: string,
  evidence: ObservedLocatorEvidence | null | undefined,
) {
  if (!evidence) {
    return {};
  }
  const candidate = { ...evidence, id: `${actionId}-locator-1` };
  return {
    locatorCandidates: [candidate],
    preferredLocatorCandidateId: candidate.id,
  };
}

function createExplorationValidationReport(input: {
  appMap: AppMap;
  networkAttempts: NetworkAttempt[];
}): ValidationReport {
  const failure = readExplorationFailure(input.appMap, input.networkAttempts);
  return readValidationReport({
    artifactReferences: [
      "/workspace/.makeademo/app-map.json",
      "/workspace/.makeademo/action-catalog.json",
      ...input.appMap.accessibilitySnapshots,
      ...(input.appMap.screenshots ?? []),
    ],
    blockedNetworkAttempts: input.networkAttempts,
    browserObservations: input.appMap.discoveredRoutes.map(
      (route) =>
        `${route.path}: ${route.headings.join(", ") || route.title || "visible route"}`,
    ),
    consoleErrors: input.appMap.consoleErrors,
    ...(failure === undefined
      ? { failureClassification: "none" }
      : { failureClassification: failure.classification }),
    logsSummary:
      failure?.message ??
      `Playwright explored ${input.appMap.discoveredRoutes.length} route(s) in the submitted-code sandbox.`,
    networkAttempts: input.networkAttempts,
    pageErrors: input.appMap.pageErrors,
    retryCount: 0,
    screenshots: input.appMap.screenshots ?? [],
    stage: "app-exploration",
    status: failure === undefined ? "passed" : "failed",
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints:
      failure === undefined
        ? []
        : [
            ...(input.networkAttempts.length === 0
              ? []
              : [
                  `Remove, vendor, mock, or locally replace every blocked browser URL: ${input.networkAttempts.map((attempt) => attempt.url ?? attempt.host).join(", ")}`,
                ]),
            ...(input.appMap.pageErrors.length === 0
              ? []
              : [
                  `Repair these route-aware page errors: ${input.appMap.pageErrors.join(" | ")}`,
                ]),
            ...(input.appMap.consoleErrors.length === 0
              ? []
              : [
                  `Repair these route-aware console errors: ${input.appMap.consoleErrors.join(" | ")}`,
                ]),
            "Rerun browser exploration after repairing the prepared runtime.",
          ],
    urlChecked: input.appMap.baseUrl,
  });
}

function readExplorationFailure(
  appMap: AppMap,
  networkAttempts: NetworkAttempt[],
): { classification: string; message: string } | undefined {
  if (networkAttempts.length > 0) {
    const pageErrorSummary =
      appMap.pageErrors.length === 0
        ? ""
        : ` Browser exploration also observed ${formatCount(appMap.pageErrors.length, "page error")}: ${appMap.pageErrors.slice(0, 3).join(" | ")}.`;
    const consoleErrorSummary =
      appMap.consoleErrors.length === 0
        ? ""
        : ` Browser exploration also observed ${formatCount(appMap.consoleErrors.length, "console error")}: ${appMap.consoleErrors.slice(0, 3).join(" | ")}.`;
    return {
      classification: "external network attempted",
      message: `Browser exploration blocked ${formatCount(networkAttempts.length, "unique external network request")}: ${networkAttempts.map((attempt) => attempt.url ?? attempt.host).join(", ")}.${pageErrorSummary}${consoleErrorSummary}`,
    };
  }
  if (appMap.pageErrors.length > 0 || appMap.consoleErrors.length > 0) {
    return {
      classification: "browser console/page error",
      message: `Browser exploration observed ${formatCount(appMap.pageErrors.length, "page error")} and ${formatCount(appMap.consoleErrors.length, "console error")}: ${[...appMap.pageErrors, ...appMap.consoleErrors].slice(0, 6).join(" | ")}.`,
    };
  }
  if (
    appMap.loginOrAuthWalls.length === appMap.discoveredRoutes.length &&
    appMap.loginOrAuthWalls.length > 0
  ) {
    return {
      classification: "auth wall",
      message: "Every discovered route is blocked by authentication.",
    };
  }
  return undefined;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function uniqueNetworkAttempts(attempts: NetworkAttempt[]): NetworkAttempt[] {
  const uniqueAttempts = new Map<string, NetworkAttempt>();
  for (const attempt of attempts) {
    const key = `${attempt.host}\u0000${attempt.url ?? ""}`;
    if (!uniqueAttempts.has(key)) {
      uniqueAttempts.set(key, attempt);
    }
  }
  return [...uniqueAttempts.values()];
}

function readObservedNetworkAttempts(
  observation: BrowserExplorationProtocol,
): NetworkAttempt[] {
  return uniqueNetworkAttempts(
    observation.blockedNetworkAttempts.map(
      (attempt): NetworkAttempt => ({
        direction: "outbound",
        host: attempt.host,
        phase: "browser",
        ...(attempt.route === undefined ? {} : { route: attempt.route }),
        ...(attempt.url === undefined ? {} : { url: attempt.url }),
      }),
    ),
  );
}

function createRouteLocatorCandidates(route: ObservedRoute): string[] {
  return unique([
    ...route.headings.map(
      (name) => `role=heading[name=${JSON.stringify(name)}]`,
    ),
    ...route.buttons.map((name) => `role=button[name=${JSON.stringify(name)}]`),
    ...route.links
      .filter((link) => link.name.length > 0)
      .map((link) => `role=link[name=${JSON.stringify(link.name)}]`),
    ...(route.inputLocators ?? []).map(
      (input) =>
        `${input.locator.strategy}=${JSON.stringify(input.locator.value)}`,
    ),
  ]);
}

function isAuthWall(route: ObservedRoute): boolean {
  return /\b(?:log in|login|sign in|authenticate)\b/i.test(
    [...route.headings, ...route.text.slice(0, 20)].join(" "),
  );
}

function readExplorationProtocol(stdout: string): BrowserExplorationProtocol {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as BrowserExplorationProtocol;
      if (Array.isArray(value.routes)) {
        return value;
      }
    } catch {}
  }
  throw new Error("Submitted app explorer did not emit its JSON protocol.");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function createExplorerScript(baseUrl: string): string {
  return `
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = ${JSON.stringify(baseUrl)};
const baseOrigin = new URL(baseUrl).origin;
const outputDirectory = ${JSON.stringify(explorerDirectory)};
const result = { blockedNetworkAttempts: [], consoleErrors: [], pageErrors: [], routes: [] };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const parsed = new URL(requestUrl);
      if (["127.0.0.1", "localhost", "0.0.0.0"].includes(parsed.hostname) || ["about:", "blob:", "data:"].includes(parsed.protocol)) {
        await route.continue();
        return;
      }
      let initiatorRoute;
      try { initiatorRoute = route.request().frame().url(); } catch {}
      result.blockedNetworkAttempts.push({ host: parsed.host, route: initiatorRoute, url: requestUrl });
      await route.abort("blockedbyclient");
    } catch {
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  const readAriaRootName = (snapshot) => {
    const firstLine = snapshot.split("\\n", 1)[0] || "";
    const match = /^-\\s+[a-zA-Z]+(?:\\s+("(?:[^"\\\\]|\\\\.)*"))?/.exec(firstLine);
    if (!match || !match[1]) return "";
    try { return JSON.parse(match[1]); } catch { return ""; }
  };
  const createVerifiedRoleLocatorEvidence = async ({ candidateNames, element, role, route, targetHref }) => {
    const ariaSnapshot = await element.ariaSnapshot();
    const observedAccessibleName = readAriaRootName(ariaSnapshot);
    const queries = [
      ...candidateNames.filter(Boolean).map((name) => ({ exact: false, name })),
      ...(observedAccessibleName ? [{ exact: true, name: observedAccessibleName }] : []),
    ];
    const seenQueries = new Set();
    for (const query of queries) {
      const key = JSON.stringify(query);
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      const candidateLocator = page.getByRole(role, query);
      const matchCount = await candidateLocator.count();
      if (matchCount !== 1 || !(await candidateLocator.isVisible())) continue;
      const elementHandle = await element.elementHandle();
      if (!elementHandle) continue;
      const resolvesToObservedElement = await candidateLocator.evaluate(
        (match, observedElement) => match === observedElement,
        elementHandle,
      );
      await elementHandle.dispose();
      if (!resolvesToObservedElement) continue;
      return {
        locator: { exact: query.exact, name: query.name, role, strategy: "role" },
        ...(observedAccessibleName ? { observedAccessibleName } : {}),
        verification: {
          matchCount: 1,
          route,
          ...(targetHref ? { targetHref } : {}),
          visible: true,
        },
      };
    }
    return undefined;
  };
  const createVerifiedDirectLocatorEvidence = async ({ element, locator, route }) => {
    const candidateLocator = locator.strategy === "label"
      ? page.getByLabel(locator.value, { exact: locator.exact })
      : locator.strategy === "placeholder"
        ? page.getByPlaceholder(locator.value, { exact: locator.exact })
        : locator.strategy === "text"
          ? page.getByText(locator.value, { exact: locator.exact })
          : locator.strategy === "test-id"
            ? page.getByTestId(locator.value)
            : page.locator(locator.strategy === "xpath" && !locator.value.startsWith("xpath=") ? "xpath=" + locator.value : locator.value);
    const matchCount = await candidateLocator.count();
    if (matchCount !== 1 || !(await candidateLocator.isVisible())) return undefined;
    const elementHandle = await element.elementHandle();
    if (!elementHandle) return undefined;
    const resolvesToObservedElement = await candidateLocator.evaluate(
      (match, observedElement) => match === observedElement,
      elementHandle,
    );
    await elementHandle.dispose();
    if (!resolvesToObservedElement) return undefined;
    const ariaSnapshot = await element.ariaSnapshot();
    const observedAccessibleName = readAriaRootName(ariaSnapshot);
    return {
      locator,
      ...(observedAccessibleName ? { observedAccessibleName } : {}),
      verification: { matchCount: 1, route, visible: true },
    };
  };
  page.on("console", (message) => {
    if (message.type() === "error") result.consoleErrors.push(page.url() + ": " + message.text());
  });
  page.on("pageerror", (error) => result.pageErrors.push(page.url() + ": " + error.message));
  const queue = [new URL(baseUrl).toString()];
  const seen = new Set();
  await mkdir(outputDirectory, { recursive: true });
  while (queue.length > 0 && seen.size < 10) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      await page.goto(url, { timeout: 20000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      const observed = await page.evaluate(() => {
        const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
        };
        const texts = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).map((element) => clean(element.textContent)).filter(Boolean);
        const links = Array.from(document.querySelectorAll("a[href]")).filter(visible).map((element) => {
          const target = new URL(element.href, location.href);
          const explicitName = clean(element.getAttribute("aria-label"));
          const nestedHeading = clean(element.querySelector("h1, h2, h3, [role=heading]")?.textContent);
          return {
            candidateNames: [explicitName, nestedHeading].filter(Boolean),
            href: target.href,
            name: explicitName || nestedHeading || clean(element.textContent),
            sameOrigin: target.origin === location.origin,
          };
        });
        const inputLocators = Array.from(document.querySelectorAll("input, textarea, select")).filter(visible).flatMap((element) => {
          const tag = element.tagName.toLowerCase();
          const label = clean(element.getAttribute("aria-label") || Array.from(element.labels || [])[0]?.textContent);
          const placeholder = clean(element.getAttribute("placeholder"));
          const nameAttribute = clean(element.getAttribute("name"));
          const id = clean(element.id);
          const name = label || placeholder || nameAttribute || id || tag;
          const cssReason = "No accessible label or placeholder was available for this observed control.";
          const locator = label
            ? { strategy: "label", value: label }
            : placeholder
              ? { strategy: "placeholder", value: placeholder }
              : id
                ? { reason: cssReason, strategy: "css", value: "#" + CSS.escape(id) }
                : nameAttribute
                  ? { reason: cssReason, strategy: "css", value: "[name=" + JSON.stringify(nameAttribute) + "]" }
                  : undefined;
          return locator === undefined
            ? []
            : [{ controlKind: tag === "select" ? "select" : "fill", locator, name }];
        });
        const inputs = inputLocators.map((input) => input.name);
        return {
          buttons: texts("button, [role=button]"),
          forms: Array.from(document.querySelectorAll("form")).filter(visible).map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.id || "form")),
          headings: texts("h1, h2, h3, [role=heading]"),
          inputLocators,
          inputs,
          links,
          primaryNavigation: texts("nav a, [role=navigation] a"),
          text: Array.from(document.querySelectorAll("main p, main li, article p, [role=main] p")).filter(visible).map((element) => clean(element.textContent)).filter(Boolean).slice(0, 80),
          title: document.title || clean(document.querySelector("h1")?.textContent) || location.pathname,
        };
      });
      const current = new URL(page.url());
      const path = current.pathname + current.search + current.hash;
      const visibleLinks = page.locator("a[href]:visible");
      observed.links = await Promise.all(observed.links.map(async (link, index) => ({
        href: link.href,
        locatorEvidence: (await createVerifiedRoleLocatorEvidence({
          candidateNames: link.candidateNames,
          element: visibleLinks.nth(index),
          role: "link",
          route: path,
          targetHref: link.href,
        })) ?? null,
        name: link.name,
        sameOrigin: link.sameOrigin,
      })));
      const visibleHeadings = page.locator("h1, h2, h3, [role=heading]").filter({ visible: true });
      observed.headingLocatorEvidence = await Promise.all(observed.headings.map((heading, index) =>
        createVerifiedRoleLocatorEvidence({
          candidateNames: [heading],
          element: visibleHeadings.nth(index),
          role: "heading",
          route: path,
        }),
      ));
      const visibleButtons = page.locator("button, [role=button]").filter({ visible: true });
      observed.buttonLocatorEvidence = await Promise.all(observed.buttons.map((button, index) =>
        createVerifiedRoleLocatorEvidence({
          candidateNames: [button],
          element: visibleButtons.nth(index),
          role: "button",
          route: path,
        }),
      ));
      const visibleInputs = page.locator("input, textarea, select").filter({ visible: true });
      observed.inputLocators = await Promise.all(observed.inputLocators.map(async (input, index) => {
        const locator = input.locator.strategy === "label" || input.locator.strategy === "placeholder"
          ? { exact: true, strategy: input.locator.strategy, value: input.locator.value }
          : { strategy: input.locator.strategy, value: input.locator.value };
        return {
          ...input,
          locatorEvidence: (await createVerifiedDirectLocatorEvidence({
            element: visibleInputs.nth(index),
            locator,
            route: path,
          })) ?? null,
        };
      }));
      const visibleBodyText = page.locator("main p, main li, article p, [role=main] p").filter({ visible: true });
      observed.textLocatorEvidence = await Promise.all(observed.text.map((text, index) =>
        createVerifiedDirectLocatorEvidence({
          element: visibleBodyText.nth(index),
          locator: { exact: true, strategy: "text", value: text },
          route: path,
        }),
      ));
      const slug = path === "/" ? "root" : path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "route";
      const screenshot = outputDirectory + "/" + slug + ".png";
      const snapshot = outputDirectory + "/" + slug + ".aria.yml";
      await page.screenshot({ fullPage: true, path: screenshot });
      const ariaSnapshot = typeof page.locator("body").ariaSnapshot === "function" ? await page.locator("body").ariaSnapshot() : await page.locator("body").innerText();
      await writeFile(snapshot, ariaSnapshot);
      result.routes.push({ ...observed, path, screenshot, snapshot });
      for (const link of observed.links) {
        const target = new URL(link.href, baseUrl);
        if (link.sameOrigin && target.origin === baseOrigin && !seen.has(target.toString())) queue.push(target.toString());
      }
    } catch (error) {
      result.pageErrors.push(url + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify(result));
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

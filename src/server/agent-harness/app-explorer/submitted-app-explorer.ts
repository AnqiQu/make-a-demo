import { executeSubmittedCode } from "../daytona/submitted-code-execution";
import type { AgentHarnessWorkspace } from "../daytona/workspace.interface";
import {
  type ActionCatalog,
  type AppMap,
  type NetworkAttempt,
  type ValidationReport,
  readActionCatalog,
  readAppMap,
  readValidationReport,
} from "../schemas/artifacts";

export type SubmittedAppExplorationResult = {
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  validationReport: ValidationReport;
};

type ObservedLink = { href: string; name: string; sameOrigin?: boolean };
type ObservedRoute = {
  buttons: string[];
  forms: string[];
  headings: string[];
  inputs: string[];
  links: ObservedLink[];
  path: string;
  primaryNavigation: string[];
  screenshot: string;
  snapshot: string;
  text: string[];
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
    throw new Error("Submitted app exploration did not discover any routes.");
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
  const networkAttempts = uniqueNetworkAttempts(
    input.observation.blockedNetworkAttempts.map(
      (attempt): NetworkAttempt => ({
        direction: "outbound",
        host: attempt.host,
        phase: "browser",
        ...(attempt.route === undefined ? {} : { route: attempt.route }),
        ...(attempt.url === undefined ? {} : { url: attempt.url }),
      }),
    ),
  );
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

  return { actionCatalog, appMap, validationReport };
}

function createActions(routes: ObservedRoute[]) {
  const actions: Array<Record<string, unknown>> = [];
  routes.forEach((route, routeIndex) => {
    route.headings.forEach((heading, index) => {
      actions.push({
        confidence: 0.95,
        evidence: `Playwright observed heading on ${route.path}`,
        expectedResult: `${heading} remains visible`,
        id: `assert-heading-${routeIndex + 1}-${index + 1}`,
        kind: "assert",
        preferredLocator: {
          name: heading,
          strategy: "role",
          value: "heading",
        },
        risks: [],
        route: route.path,
      });
    });
    route.buttons.forEach((button, index) => {
      actions.push({
        confidence: 0.9,
        evidence: `Playwright observed button on ${route.path}`,
        expectedResult: `Clicking ${button} changes visible app state`,
        id: `click-button-${routeIndex + 1}-${index + 1}`,
        kind: "click",
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
      if (link.name.length === 0 || link.sameOrigin === false) {
        return;
      }
      actions.push({
        confidence: 0.9,
        evidence: `Playwright observed link to ${link.href}`,
        expectedResult: `${link.href} becomes visible`,
        id: `click-link-${routeIndex + 1}-${index + 1}`,
        kind: "click",
        preferredLocator: {
          name: link.name,
          strategy: "role",
          value: "link",
        },
        risks: [],
        route: route.path,
      });
    });
  });

  if (actions.length === 0) {
    const firstRoute = routes[0];
    const firstText = firstRoute?.text.find((text) => text.length > 0);
    if (firstRoute !== undefined && firstText !== undefined) {
      actions.push({
        confidence: 0.75,
        evidence: `Playwright observed visible text on ${firstRoute.path}`,
        expectedResult: `${firstText} is visible`,
        id: "assert-visible-text-1",
        kind: "assert",
        preferredLocator: { strategy: "text", value: firstText },
        risks: [],
        route: firstRoute.path,
      });
    }
  }
  return actions;
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

function createRouteLocatorCandidates(route: ObservedRoute): string[] {
  return unique([
    ...route.headings.map(
      (name) => `role=heading[name=${JSON.stringify(name)}]`,
    ),
    ...route.buttons.map((name) => `role=button[name=${JSON.stringify(name)}]`),
    ...route.links
      .filter((link) => link.name.length > 0)
      .map((link) => `role=link[name=${JSON.stringify(link.name)}]`),
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
          return { href: target.href, name: clean(element.textContent || element.getAttribute("aria-label")), sameOrigin: target.origin === location.origin };
        });
        const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter(visible).map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.id || element.tagName.toLowerCase())).filter(Boolean);
        return {
          buttons: texts("button, [role=button]"),
          forms: Array.from(document.querySelectorAll("form")).filter(visible).map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.id || "form")),
          headings: texts("h1, h2, h3, [role=heading]"),
          inputs,
          links,
          primaryNavigation: texts("nav a, [role=navigation] a"),
          text: Array.from(document.querySelectorAll("main p, main li, article p, [role=main] p")).filter(visible).map((element) => clean(element.textContent)).filter(Boolean).slice(0, 80),
          title: document.title || clean(document.querySelector("h1")?.textContent) || location.pathname,
        };
      });
      const current = new URL(page.url());
      const path = current.pathname + current.search + current.hash;
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

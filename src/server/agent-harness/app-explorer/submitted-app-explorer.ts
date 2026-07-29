import { createBrowserRuntimeNetworkPolicySource } from "../../shared/external-resources/browser-runtime-network-policy";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { executeSubmittedCode } from "../daytona/submitted-code-execution";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessSubmittedCodeAppStatus,
  type AgentHarnessWorkspace,
} from "../daytona/workspace.interface";
import {
  type ActionCatalog,
  type AppMap,
  type NetworkAttempt,
  type PreparedDemoFeature,
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
  inputType?: string;
  locatorEvidence?: ObservedLocatorEvidence | null;
  locator: {
    reason?: string;
    strategy: "css" | "label" | "placeholder";
    value: string;
  };
  name: string;
};
type ObservedScrollTarget = {
  locator: {
    reason: string;
    strategy: "css";
    value: string;
  };
  locatorEvidence?: ObservedLocatorEvidence | null;
  name: string;
  position: "bottom" | "top";
};
type ObservedRoute = {
  buttons: string[];
  buttonLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  forms: string[];
  featureIds?: string[];
  headings: string[];
  headingLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  inputLocators?: ObservedInputLocator[];
  inputs: string[];
  interactions?: ObservedInteraction[];
  links: ObservedLink[];
  path: string;
  primaryNavigation: string[];
  requestedPath?: string;
  screenshot: string;
  scrollTargets?: ObservedScrollTarget[];
  snapshot: string;
  text: string[];
  textLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  title: string;
};
type ObservedInteraction = {
  kind: "click" | "fill" | "select";
  locator?: {
    name?: string;
    reason?: string;
    strategy: "css" | "label" | "placeholder" | "role";
    value: string;
  };
  locatorEvidence?: ObservedLocatorEvidence | null;
  name: string;
  outcome: string;
};
type UnreachableRoute = {
  error: string;
  featureIds?: string[];
  url: string;
};
type BrowserExplorationProtocol = {
  blockedNetworkAttempts: Array<
    Pick<NetworkAttempt, "host"> & Partial<NetworkAttempt>
  >;
  consoleErrors: string[];
  fatalError?: string;
  pageErrors: string[];
  routes: ObservedRoute[];
  unreachableRoutes?: UnreachableRoute[];
};

/**
 * Collapses cosmetic URL variants (tracking params, trailing slashes, bare
 * fragments) into one route identity. Fragments are otherwise preserved
 * because hash-routed apps use them as routes. This function is embedded
 * verbatim into the generated explorer script — keep it self-contained.
 */
export function normalizeCrawlUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|mc_)|^(?:fbclid|gclid|msclkid|ref)$/.test(key)) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/[?#]+$/, "");
}

const explorerDirectory = "/workspace/.makeademo/exploration";
const explorerPath = `${explorerDirectory}/explore-app.mjs`;
const explorationCommandTimeoutMs = 5 * 60_000;

/**
 * Explores the real prepared app with Playwright inside the secret-free
 * submitted-code sandbox. Implementations consuming this result can trust that
 * routes and locators came from browser observations rather than agent memory.
 */
export async function exploreSubmittedApp(input: {
  baseUrl: string;
  externalResourceManifest?: ExternalResourceManifest;
  featureInventory?: PreparedDemoFeature[];
  preparationManifestId: string;
  requestedFeatures?: string[];
  workspace: AgentHarnessWorkspace;
}): Promise<SubmittedAppExplorationResult> {
  const script = createExplorerScript(
    input.baseUrl,
    input.featureInventory ?? [],
    input.externalResourceManifest,
  );
  const encodedScript = Buffer.from(script).toString("base64");
  let result: Awaited<ReturnType<typeof executeSubmittedCode>>;
  try {
    result = await executeSubmittedCode(
      input.workspace,
      [
        `mkdir -p ${explorerDirectory}`,
        `printf %s ${shellQuote(encodedScript)} | base64 -d > ${explorerPath}`,
        `NODE_PATH="$(npm root -g)" bun ${explorerPath}`,
      ].join(" && "),
      { timeoutMs: explorationCommandTimeoutMs },
    );
  } catch (error) {
    if (!(error instanceof AgentHarnessCommandTimeoutError)) {
      throw error;
    }
    const appStatus = await readAppStatus(input.workspace);
    if (appStatus?.running !== false) throw error;
    return createExitedAppExplorationFailure({
      appStatus,
      baseUrl: input.baseUrl,
      timeoutError: error,
    });
  }

  const observation =
    readExplorationProtocol(result.stdout) ??
    (await readExplorationProtocolFile(input.workspace));
  if (observation === undefined) {
    const appStatus = await readAppStatus(input.workspace);
    return createCrashedExplorerFailure({
      appStatus,
      baseUrl: input.baseUrl,
      result,
    });
  }
  if (observation.routes.length === 0) {
    const appStatus = await readAppStatus(input.workspace);
    return createRepairableExplorationFailure({
      appStatus,
      baseUrl: input.baseUrl,
      observation,
    });
  }

  return createExplorationArtifacts({
    baseUrl: input.baseUrl,
    featureInventory: input.featureInventory ?? [],
    observation,
    preparationManifestId: input.preparationManifestId,
    requestedFeatures: input.requestedFeatures ?? [],
  });
}

function createExitedAppExplorationFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus;
  baseUrl: string;
  timeoutError: AgentHarnessCommandTimeoutError;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  return {
    kind: "repairable-failure",
    validationReport: readValidationReport({
      artifactReferences: [explorerPath],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: "start failure",
      logsSummary: `The prepared app exited${input.appStatus.exitCode === undefined ? "" : ` with code ${input.appStatus.exitCode}`} while App Exploration was running: ${diagnostics.output || input.timeoutError.message}`,
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "app-exploration",
      status: "failed",
      stderrExcerpts: diagnostics.stderrExcerpts,
      stdoutExcerpts: diagnostics.stdoutExcerpts,
      suggestedRepairHints: [
        "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration.",
      ],
      urlChecked: input.baseUrl,
    }),
  };
}

function createExplorationArtifacts(input: {
  baseUrl: string;
  featureInventory: PreparedDemoFeature[];
  observation: BrowserExplorationProtocol;
  preparationManifestId: string;
  requestedFeatures: string[];
}): SubmittedAppExplorationResult {
  const appMapId = `${input.preparationManifestId}_app_map`;
  const actionCatalogId = `${input.preparationManifestId}_actions`;
  const networkAttempts = readObservedNetworkAttempts(input.observation);
  const explicitAuthenticationFeatureIds = new Set(
    input.featureInventory
      .filter((feature) =>
        isExplicitAuthenticationFeature(feature, input.requestedFeatures),
      )
      .map(({ id }) => id),
  );
  const routes = input.observation.routes.map((route) => ({
    buttons: route.buttons,
    ...(route.featureIds === undefined ? {} : { featureIds: route.featureIds }),
    forms: route.forms,
    headings: route.headings,
    inputs: route.inputs,
    links: route.links.map((link) => link.href),
    path: route.path,
    primaryNavigation: route.primaryNavigation,
    ...(route.requestedPath === undefined
      ? {}
      : { requestedPath: route.requestedPath }),
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
    actions: createActions(
      input.observation.routes,
      input.featureInventory,
      explicitAuthenticationFeatureIds,
    ),
    appMapId,
    id: actionCatalogId,
  });
  const validationReport = createExplorationValidationReport({
    actionCatalog,
    appMap,
    explicitAuthenticationFeatureIds,
    featureInventory: input.featureInventory,
    networkAttempts,
    unreachableRoutes: input.observation.unreachableRoutes ?? [],
  });

  return { actionCatalog, appMap, kind: "artifacts", validationReport };
}

function createRepairableExplorationFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus | undefined;
  baseUrl: string;
  observation: BrowserExplorationProtocol;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const networkAttempts = readObservedNetworkAttempts(input.observation);
  const appExited = input.appStatus?.running === false;
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  return {
    kind: "repairable-failure",
    validationReport: readValidationReport({
      artifactReferences: [explorerPath],
      blockedNetworkAttempts: networkAttempts,
      browserObservations: [],
      consoleErrors: unique(input.observation.consoleErrors),
      failureClassification: appExited
        ? "app route crashes"
        : "app route not discoverable",
      logsSummary: appExited
        ? `The prepared app exited${input.appStatus?.exitCode === undefined ? "" : ` with code ${input.appStatus.exitCode}`} while Playwright was exploring it${diagnostics.output ? `: ${diagnostics.output}` : "."}`
        : `Playwright completed exploration but did not discover a browser route to ground Flow Planning.${
            input.observation.fatalError === undefined
              ? ""
              : ` Explorer error: ${input.observation.fatalError}`
          }${(input.observation.unreachableRoutes ?? [])
            .slice(0, 3)
            .map((route) => ` Unreachable ${route.url}: ${route.error}`)
            .join(" |")}`,
      networkAttempts,
      pageErrors: unique(input.observation.pageErrors),
      retryCount: 0,
      screenshots: [],
      stage: "app-exploration",
      status: "failed",
      stderrExcerpts: diagnostics.stderrExcerpts,
      stdoutExcerpts: diagnostics.stdoutExcerpts,
      suggestedRepairHints: appExited
        ? [
            "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration.",
          ]
        : [
            "Repair the prepared app start command, base URL, route crash, or initial app state, then rerun browser exploration.",
          ],
      urlChecked: input.baseUrl,
    }),
  };
}

function createAppStatusDiagnostics(
  appStatus?: AgentHarnessSubmittedCodeAppStatus,
): {
  output: string;
  stderrExcerpts: string[];
  stdoutExcerpts: string[];
} {
  const stderrExcerpt = appStatus?.stderr.slice(-500) ?? "";
  const stdoutExcerpt = appStatus?.stdout.slice(-500) ?? "";
  return {
    output: [stderrExcerpt, stdoutExcerpt].filter(Boolean).join("\n"),
    stderrExcerpts: stderrExcerpt ? [stderrExcerpt] : [],
    stdoutExcerpts: stdoutExcerpt ? [stdoutExcerpt] : [],
  };
}

async function readAppStatus(
  workspace: AgentHarnessWorkspace,
): Promise<AgentHarnessSubmittedCodeAppStatus | undefined> {
  try {
    return await workspace.readSubmittedCodeAppStatus?.();
  } catch {
    return undefined;
  }
}

function createActions(
  routes: ObservedRoute[],
  featureInventory: PreparedDemoFeature[],
  explicitAuthenticationFeatureIds: ReadonlySet<string>,
) {
  const actions: Array<Record<string, unknown>> = [];
  routes.forEach((route, routeIndex) => {
    const matchFeatureIds = (evidence: string) =>
      matchActionFeatureIds(
        route,
        evidence,
        featureInventory,
        explicitAuthenticationFeatureIds,
      );
    actions.push({
      confidence: 1,
      evidence: `Playwright loaded ${route.path}`,
      expectedResult: `${route.title || route.path} becomes visible`,
      featureIds: matchFeatureIds(""),
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
        featureIds: matchFeatureIds(heading),
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
          featureIds: matchFeatureIds(visibleText),
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
            featureIds: matchFeatureIds(visibleButton),
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
    (route.interactions ?? []).forEach((interaction, index) => {
      if (interaction.locatorEvidence === null) return;
      const id = `${interaction.kind}-interaction-${routeIndex + 1}-${index + 1}`;
      const preferredLocator =
        interaction.locator ??
        (interaction.kind === "click"
          ? {
              name: interaction.name,
              strategy: "role" as const,
              value: "button",
            }
          : undefined);
      if (preferredLocator === undefined) return;
      actions.push({
        confidence: 0.98,
        evidence: `Playwright exercised ${interaction.name} on ${route.path} and observed: ${interaction.outcome}`,
        exercised: true,
        expectedResult: interaction.outcome,
        featureIds: matchFeatureIds(
          `${interaction.name} ${interaction.outcome}`,
        ),
        id,
        kind: interaction.kind,
        ...createLocatorCandidateFields(id, interaction.locatorEvidence),
        preferredLocator,
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
        featureIds: matchFeatureIds(`${link.name} ${link.href}`),
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
    (route.scrollTargets ?? []).forEach((target, index) => {
      if (target.locatorEvidence === null) {
        return;
      }
      const id = `scroll-route-${routeIndex + 1}-${index + 1}`;
      actions.push({
        confidence: 0.95,
        evidence: `Playwright observed scrollable content on ${route.path}`,
        expectedResult: `Scrolling ${target.name} reveals more visible content`,
        featureIds: matchFeatureIds(target.name),
        id,
        kind: "scroll",
        ...createLocatorCandidateFields(id, target.locatorEvidence),
        preferredLocator: target.locator,
        risks: [],
        route: route.path,
        scrollPosition: target.position,
      });
    });
  });

  return actions;
}

function matchActionFeatureIds(
  route: ObservedRoute,
  actionEvidence: string,
  featureInventory: PreparedDemoFeature[],
  explicitAuthenticationFeatureIds: ReadonlySet<string>,
): string[] {
  const routeFeatureIds = route.featureIds ?? [];
  if (isAuthWall(route)) {
    return featureInventory
      .filter(
        (feature) =>
          routeFeatureIds.includes(feature.id) &&
          explicitAuthenticationFeatureIds.has(feature.id),
      )
      .map(({ id }) => id);
  }
  if (actionEvidence.length === 0 || routeFeatureIds.length <= 1) {
    return routeFeatureIds;
  }
  const actionTokens = semanticTokens(actionEvidence);
  const matches = featureInventory
    .filter((feature) => routeFeatureIds.includes(feature.id))
    .map((feature) => ({
      id: feature.id,
      score: semanticTokens(
        `${feature.id} ${feature.label} ${feature.requestedFeature ?? ""} ${feature.description}`,
      ).filter((token) => actionTokens.includes(token)).length,
    }));
  const bestScore = Math.max(0, ...matches.map(({ score }) => score));
  return bestScore === 0
    ? []
    : matches.filter(({ score }) => score === bestScore).map(({ id }) => id);
}

function semanticTokens(value: string): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "before",
    "button",
    "create",
    "demonstrate",
    "feature",
    "show",
    "the",
    "this",
    "with",
  ]);
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4 && !stopWords.has(token))
        .map((token) => token.slice(0, 5)),
    ),
  ];
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
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  explicitAuthenticationFeatureIds: ReadonlySet<string>;
  featureInventory: PreparedDemoFeature[];
  networkAttempts: NetworkAttempt[];
  unreachableRoutes: UnreachableRoute[];
}): ValidationReport {
  const failure = readExplorationFailure(
    input.appMap,
    input.featureInventory,
    input.actionCatalog,
    input.explicitAuthenticationFeatureIds,
    input.unreachableRoutes,
  );
  const actionableConsoleErrors = input.appMap.consoleErrors.filter(
    isActionableBrowserConsoleError,
  );
  return readValidationReport({
    artifactReferences: [
      "/workspace/.makeademo/app-map.json",
      "/workspace/.makeademo/action-catalog.json",
      ...input.appMap.accessibilitySnapshots,
      ...(input.appMap.screenshots ?? []),
    ],
    blockedNetworkAttempts: input.networkAttempts,
    browserObservations: [
      ...input.appMap.discoveredRoutes.map(
        (route) =>
          `${route.path}: ${route.headings.join(", ") || route.title || "visible route"}`,
      ),
      ...input.unreachableRoutes.map(
        (route) => `unreachable ${route.url}: ${route.error}`,
      ),
    ],
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
            ...(input.appMap.pageErrors.length === 0
              ? []
              : [
                  `Repair these route-aware page errors: ${input.appMap.pageErrors.join(" | ")}`,
                ]),
            ...(actionableConsoleErrors.length === 0
              ? []
              : [
                  `Repair these route-aware console errors: ${actionableConsoleErrors.join(" | ")}`,
                ]),
            "Rerun browser exploration after repairing the prepared runtime.",
          ],
    urlChecked: input.appMap.baseUrl,
  });
}

/**
 * Decides whether exploration failed. Browser errors alone are never terminal:
 * dev-server noise (chunk-load races, HMR reloads, aborted navigations) stays
 * in the report as evidence. Exploration fails only when a feature cannot be
 * demonstrated — its entry route is unreachable, it has no grounded evidence,
 * or authentication blocks it without the maker requesting auth footage.
 */
function readExplorationFailure(
  appMap: AppMap,
  featureInventory: PreparedDemoFeature[],
  actionCatalog: ActionCatalog,
  explicitAuthenticationFeatureIds: ReadonlySet<string>,
  unreachableRoutes: UnreachableRoute[],
): { classification: string; message: string } | undefined {
  const unreachableForFeatures = (featureIds: ReadonlySet<string>) =>
    unreachableRoutes.filter((route) =>
      (route.featureIds ?? []).some((featureId) => featureIds.has(featureId)),
    );
  const formatUnreachable = (routes: UnreachableRoute[]) =>
    `Feature entry routes failed to load: ${routes
      .slice(0, 2)
      .map((route) => `${route.url}: ${route.error}`)
      .join(" | ")}.`;
  const featuresById = new Map(
    featureInventory.map((feature) => [feature.id, feature]),
  );
  const authWallRoutes = new Set(appMap.loginOrAuthWalls);
  const authBarrierFeatureIds = new Set(
    appMap.discoveredRoutes
      .filter((route) => authWallRoutes.has(route.path))
      .flatMap((route) =>
        (route.featureIds ?? []).filter((featureId) => {
          const feature = featuresById.get(featureId);
          return (
            feature !== undefined &&
            !explicitAuthenticationFeatureIds.has(feature.id)
          );
        }),
      ),
  );
  if (authBarrierFeatureIds.size > 0) {
    const blockedFeatures = featureInventory
      .filter((feature) => authBarrierFeatureIds.has(feature.id))
      .map((feature) => feature.requestedFeature ?? feature.label);
    return {
      classification: "feature auth barrier",
      message: `Prepared feature routes redirected to authentication for: ${blockedFeatures.join(", ")}.`,
    };
  }
  const groundedFeatureIds = new Set(
    featureInventory
      .filter((feature) => {
        const actions = actionCatalog.actions.filter((action) =>
          action.featureIds?.includes(feature.id),
        );
        return (
          actions.some((action) => action.kind === "assert") &&
          actions.some((action) => action.kind !== "assert")
        );
      })
      .map((feature) => feature.id),
  );
  const missingRequestedFeatures = featureInventory.filter(
    (feature) =>
      feature.requestedFeature !== undefined &&
      !groundedFeatureIds.has(feature.id),
  );
  if (missingRequestedFeatures.length > 0) {
    const unreachable = unreachableForFeatures(
      new Set(missingRequestedFeatures.map(({ id }) => id)),
    );
    if (unreachable.length > 0) {
      return {
        classification: "app route not discoverable",
        message: formatUnreachable(unreachable),
      };
    }
    return {
      classification: "requested feature not observable",
      message: `App Exploration found no browser evidence for requested features: ${missingRequestedFeatures
        .map((feature) => feature.requestedFeature as string)
        .join(", ")}.`,
    };
  }
  if (
    !featureInventory.some((feature) => feature.requestedFeature !== undefined)
  ) {
    const ungroundedFeatures = featureInventory.filter(
      (feature) => !groundedFeatureIds.has(feature.id),
    );
    const observedPreparedFeatureCount =
      featureInventory.length - ungroundedFeatures.length;
    const requiredPreparedFeatureCount = Math.min(3, featureInventory.length);
    if (observedPreparedFeatureCount < requiredPreparedFeatureCount) {
      const unreachable = unreachableForFeatures(
        new Set(ungroundedFeatures.map(({ id }) => id)),
      );
      if (unreachable.length > 0) {
        return {
          classification: "app route not discoverable",
          message: formatUnreachable(unreachable),
        };
      }
      return {
        classification: "prepared feature not observable",
        message: `App Exploration observed ${observedPreparedFeatureCount} prepared features but needs ${requiredPreparedFeatureCount} to plan the default demo.`,
      };
    }
  }
  if (
    featureInventory.length === 0 &&
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

function isActionableBrowserConsoleError(error: string): boolean {
  return !/(?:ERR_BLOCKED_BY_CLIENT|_next\/webpack-hmr.*ERR_INVALID_HTTP_RESPONSE)/i.test(
    error,
  );
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
        direction: attempt.direction ?? "outbound",
        ...(attempt.hasCredentials === undefined
          ? {}
          : { hasCredentials: attempt.hasCredentials }),
        host: attempt.host,
        ...(attempt.method === undefined ? {} : { method: attempt.method }),
        phase: attempt.phase ?? "browser",
        ...(attempt.resourceType === undefined
          ? {}
          : { resourceType: attempt.resourceType }),
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

function isAuthWall(route: {
  buttons: string[];
  forms?: string[];
  headings: string[];
  inputs: string[];
  links?: Array<{ name: string }>;
  path?: string;
  requestedPath?: string;
  title?: string;
}): boolean {
  const actionLabels = [
    ...route.buttons,
    ...(route.links ?? []).map(({ name }) => name),
  ];
  const hasPassword = route.inputs.some((input) => /password/i.test(input));
  const hasIdentity = route.inputs.some((input) =>
    /email|username|user name/i.test(input),
  );
  const visibleCopy = [
    route.title ?? "",
    ...route.headings,
    ...actionLabels,
    ...(route.forms ?? []),
  ].join(" ");
  const hasAuthCallToAction =
    /\b(?:authenticate|log in|login|magic link|one[- ]time (?:code|password)|passkey|sign in|sign up|sso)\b/i.test(
      visibleCopy,
    );
  const hasIdentityProviderAction = actionLabels.some((button) =>
    /\b(?:continue|log in|sign in)\s+(?:with\s+)?(?:apple|facebook|github|google|linkedin|microsoft|sso)\b/i.test(
      button,
    ),
  );
  const hasAuthPath =
    /(?:^|[/#?_-])(?:auth|log-?in|oauth|sign-?in|sign-?up|sso)(?:[/#?&=_-]|$)/i.test(
      route.path ?? "",
    );
  const redirected =
    route.requestedPath !== undefined && route.requestedPath !== route.path;
  return (
    (hasPassword && hasIdentity && hasAuthCallToAction) ||
    (hasAuthPath &&
      (hasAuthCallToAction || hasIdentity || hasIdentityProviderAction)) ||
    (redirected && hasIdentityProviderAction)
  );
}

/** Returns true only when the maker explicitly requested authentication footage. */
export function isExplicitAuthenticationFeature(
  feature: PreparedDemoFeature,
  requestedFeatures: readonly string[],
): boolean {
  if (feature.requestedFeature === undefined) return false;
  const requestedFeature = normalizeRequestedFeature(feature.requestedFeature);
  return (
    requestedFeatures.some(
      (candidate) => normalizeRequestedFeature(candidate) === requestedFeature,
    ) &&
    /\b(?:account (?:creation|registration)|authenticate|authentication|creat(?:e|ing) an? account|log(?:ging)?\s*in|login|magic link|oauth|passkey|sign(?:ing)?\s*(?:in|up)|single sign-on|sso)\b/i.test(
      feature.requestedFeature,
    )
  );
}

function normalizeRequestedFeature(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

const explorationProtocolMarker = "[makeademo:exploration] ";

function readExplorationProtocol(
  text: string,
): BrowserExplorationProtocol | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const payload = line.startsWith(explorationProtocolMarker)
      ? line.slice(explorationProtocolMarker.length)
      : line;
    try {
      const value = JSON.parse(payload) as BrowserExplorationProtocol;
      if (Array.isArray(value.routes)) {
        return value;
      }
    } catch {}
  }
  return undefined;
}

/**
 * Durable fallback for a corrupted stdout stream: the generated explorer
 * always writes its protocol to exploration.json before exiting.
 */
async function readExplorationProtocolFile(
  workspace: AgentHarnessWorkspace,
): Promise<BrowserExplorationProtocol | undefined> {
  try {
    const result = await executeSubmittedCode(
      workspace,
      `cat ${explorerDirectory}/exploration.json`,
    );
    return result.exitCode === 0
      ? readExplorationProtocol(result.stdout)
      : undefined;
  } catch {
    return undefined;
  }
}

function createCrashedExplorerFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus | undefined;
  baseUrl: string;
  result: { exitCode: number; stderr: string; stdout: string };
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const appExited = input.appStatus?.running === false;
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  const excerpt = (input.result.stderr || input.result.stdout)
    .trim()
    .slice(0, 2000);
  return {
    kind: "repairable-failure",
    validationReport: readValidationReport({
      artifactReferences: [explorerPath],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: appExited ? "app route crashes" : "runtime crash",
      logsSummary: `Browser exploration exited with code ${input.result.exitCode} without emitting its result protocol${excerpt ? `: ${excerpt}` : "."}`,
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "app-exploration",
      status: "failed",
      stderrExcerpts: diagnostics.stderrExcerpts,
      stdoutExcerpts: diagnostics.stdoutExcerpts,
      suggestedRepairHints: [
        appExited
          ? "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration."
          : "Repair the prepared app runtime so the browser explorer can load it, then rerun browser exploration.",
      ],
      urlChecked: input.baseUrl,
    }),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function createExplorerScript(
  baseUrl: string,
  featureInventory: PreparedDemoFeature[],
  externalResourceManifest?: ExternalResourceManifest,
): string {
  const featureEntryTargets = createFeatureEntryTargets(
    baseUrl,
    featureInventory,
  );
  return `
import { chromium } from "@playwright/test";
import { mkdir, readFile as makeADemoReadReplayFile, writeFile } from "node:fs/promises";

const baseUrl = ${JSON.stringify(baseUrl)};
const baseOrigin = new URL(baseUrl).origin;
const featureEntryTargets = ${JSON.stringify(featureEntryTargets)};
const outputDirectory = ${JSON.stringify(explorerDirectory)};
const deadlineAtMs = Date.now() + ${Math.floor(explorationCommandTimeoutMs * 0.7)};
const result = { blockedNetworkAttempts: [], consoleErrors: [], pageErrors: [], routes: [], unreachableRoutes: [] };
const isAppUnavailableError = (error) => /(?:ERR_CONNECTION_(?:CLOSED|REFUSED|RESET)|Target page, context or browser has been closed)/i.test(
  error instanceof Error ? error.message : String(error),
);
const normalizeCrawlUrl = ${normalizeCrawlUrl.toString()};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
  ${createBrowserRuntimeNetworkPolicySource({
    ...(externalResourceManifest === undefined
      ? {}
      : { manifest: externalResourceManifest }),
    mode: "exploration",
  })}
  const page = await context.newPage();
  const readAriaRootName = (snapshot) => {
    const firstLine = snapshot.split("\\n", 1)[0] || "";
    const match = /^-\\s+[a-zA-Z]+(?:\\s+("(?:[^"\\\\]|\\\\.)*"))?/.exec(firstLine);
    if (!match || !match[1]) return "";
    try { return JSON.parse(match[1]); } catch { return ""; }
  };
  const createVerifiedRoleLocatorEvidence = async ({ candidateNames, role, route, targetHref }) => {
    const queries = candidateNames.filter(Boolean).map((name) => ({ exact: false, name }));
    const seenQueries = new Set();
    for (const query of queries) {
      const key = JSON.stringify(query);
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      const candidateLocator = page.getByRole(role, query);
      const matchCount = await candidateLocator.count();
      if (matchCount !== 1 || !(await candidateLocator.isVisible())) continue;
      const ariaSnapshot = await candidateLocator.ariaSnapshot();
      const observedAccessibleName = readAriaRootName(ariaSnapshot);
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
  const createVerifiedDirectLocatorEvidence = async ({ locator, route }) => {
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
    const ariaSnapshot = await candidateLocator.ariaSnapshot();
    const observedAccessibleName = readAriaRootName(ariaSnapshot);
    return {
      locator,
      ...(observedAccessibleName ? { observedAccessibleName } : {}),
      verification: { matchCount: 1, route, visible: true },
    };
  };
  const createInteractionLocator = (locator) => locator.strategy === "label"
    ? page.getByLabel(locator.value, { exact: true })
    : locator.strategy === "placeholder"
      ? page.getByPlaceholder(locator.value, { exact: true })
      : page.locator(locator.value);
  const readVisibleState = async () => await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const read = (selector) => Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((element) => clean(element.textContent || element.getAttribute("aria-label")))
      .filter(Boolean)
      .slice(0, 80);
    return {
      dialogs: read("[role=dialog], dialog[open]"),
      headings: read("h1, h2, h3, [role=heading]"),
      text: read("main p, main li, article p, [role=main] p, [role=status], [role=alert]"),
      title: document.title,
      url: location.href,
    };
  });
  const describeVisibleOutcome = (before, after) => {
    if (after.url !== before.url) {
      const target = new URL(after.url);
      return target.pathname + target.search + target.hash + " became visible";
    }
    const newDialog = after.dialogs.find((value) => !before.dialogs.includes(value));
    if (newDialog) return newDialog + " dialog became visible";
    const newHeading = after.headings.find((value) => !before.headings.includes(value));
    if (newHeading) return newHeading + " became visible";
    const newText = after.text.find((value) => !before.text.includes(value));
    if (newText) return newText + " became visible";
    if (after.title !== before.title) return after.title + " became visible";
    return undefined;
  };
  page.on("console", (message) => {
    if (message.type() === "error") result.consoleErrors.push(page.url() + ": " + message.text());
  });
  page.on("pageerror", (error) => result.pageErrors.push(page.url() + ": " + error.message));
  const gotoRoute = async (url) => {
    // Dev servers compile each route on first hit; give the initial load a
    // cold-start budget and absorb one transient failure (mid-recompile
    // reloads surface as ERR_ABORTED) before treating the route as broken.
    try {
      await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });
    } catch (error) {
      if (isAppUnavailableError(error)) throw error;
      await page.goto(url, { timeout: 60000, waitUntil: "domcontentloaded" });
    }
    await page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(250);
  };
  const queue = [
    ...featureEntryTargets,
    { featureIds: [], requestedPath: new URL(baseUrl).pathname, url: new URL(baseUrl).toString() },
  ];
  const seen = new Set();
  const maxRoutes = Math.min(30, featureEntryTargets.length + 9);
  await mkdir(outputDirectory, { recursive: true });
  while (queue.length > 0 && seen.size < maxRoutes && Date.now() < deadlineAtMs) {
    const target = queue.shift();
    if (!target) continue;
    const targetUrl = normalizeCrawlUrl(target.url);
    if (seen.has(targetUrl)) continue;
    seen.add(normalizeCrawlUrl(target.url));
    try {
      await gotoRoute(target.url);
      const landedUrl = normalizeCrawlUrl(page.url());
      if (landedUrl !== targetUrl && seen.has(landedUrl)) continue;
      seen.add(landedUrl);
      const observed = await page.evaluate(() => {
        const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
        };
        const texts = (selector, limit = 40) => Array.from(document.querySelectorAll(selector)).filter(visible).map((element) => clean(element.textContent || element.getAttribute("aria-label"))).filter(Boolean).slice(0, limit);
        const links = Array.from(document.querySelectorAll("a[href]")).filter(visible).map((element) => {
          const target = new URL(element.href, location.href);
          const explicitName = clean(element.getAttribute("aria-label"));
          const nestedHeading = clean(element.querySelector("h1, h2, h3, [role=heading]")?.textContent);
          const textName = clean(element.textContent);
          return {
            candidateNames: [explicitName, nestedHeading, textName].filter(Boolean),
            href: target.href,
            name: explicitName || nestedHeading || textName,
            sameOrigin: target.origin === location.origin,
          };
        }).slice(0, 60);
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
            : [{ controlKind: tag === "select" ? "select" : "fill", inputType: clean(element.getAttribute("type")).toLowerCase(), locator, name }];
        }).slice(0, 12);
        const inputs = inputLocators.map((input) => input.name);
        const scrollTargets = document.documentElement.scrollHeight > window.innerHeight + 40
          ? [{
              locator: {
                reason: "The document scroll root has no semantic locator.",
                strategy: "css",
                value: "html",
              },
              name: clean(document.querySelector("h1, h2, [role=heading]")?.textContent) || "page",
              position: "bottom",
            }]
          : [];
        return {
          buttons: texts("button, [role=button]", 16),
          forms: Array.from(document.querySelectorAll("form")).filter(visible).map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.id || "form")).slice(0, 20),
          headings: texts("h1, h2, h3, [role=heading]"),
          inputLocators,
          inputs,
          links,
          primaryNavigation: texts("nav a, [role=navigation] a"),
          scrollTargets,
          text: Array.from(document.querySelectorAll("main p, main li, article p, [role=main] p")).filter(visible).map((element) => clean(element.textContent)).filter(Boolean).slice(0, 80),
          title: document.title || clean(document.querySelector("h1")?.textContent) || location.pathname,
        };
      });
      const current = new URL(page.url());
      const path = current.pathname + current.search + current.hash;
      observed.links = await Promise.all(observed.links.map(async (link) => ({
        href: link.href,
        locatorEvidence: (await createVerifiedRoleLocatorEvidence({
          candidateNames: link.candidateNames,
          role: "link",
          route: path,
          targetHref: link.href,
        })) ?? null,
        name: link.name,
        sameOrigin: link.sameOrigin,
      })));
      observed.headingLocatorEvidence = await Promise.all(observed.headings.map((heading) =>
        createVerifiedRoleLocatorEvidence({
          candidateNames: [heading],
          role: "heading",
          route: path,
        }),
      ));
      observed.buttonLocatorEvidence = await Promise.all(observed.buttons.map((button) =>
        createVerifiedRoleLocatorEvidence({
          candidateNames: [button],
          role: "button",
          route: path,
        }),
      ));
      observed.inputLocators = await Promise.all(observed.inputLocators.map(async (input) => {
        const locator = input.locator.strategy === "label" || input.locator.strategy === "placeholder"
          ? { exact: true, strategy: input.locator.strategy, value: input.locator.value }
          : { strategy: input.locator.strategy, value: input.locator.value };
        return {
          ...input,
          locatorEvidence: (await createVerifiedDirectLocatorEvidence({
            locator,
            route: path,
          })) ?? null,
        };
      }));
      observed.textLocatorEvidence = await Promise.all(observed.text.map((text) =>
        createVerifiedDirectLocatorEvidence({
          locator: { exact: true, strategy: "text", value: text },
          route: path,
        }),
      ));
      observed.scrollTargets = await Promise.all(observed.scrollTargets.map(async (target) => ({
        ...target,
        locatorEvidence: (await createVerifiedDirectLocatorEvidence({
          locator: { strategy: target.locator.strategy, value: target.locator.value },
          route: path,
        })) ?? null,
      })));
      observed.interactions = [];
      const routeUrl = page.url();
      for (let index = 0; index < Math.min(observed.buttons.length, 8); index += 1) {
        const name = observed.buttons[index];
        const locatorEvidence = observed.buttonLocatorEvidence[index];
        if (!name || !locatorEvidence || /\\b(?:buy|checkout|delete|destroy|disconnect|log out|logout|pay|purchase|remove|revoke|sign out)\\b/i.test(name)) continue;
        try {
          await page.goto(routeUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
          await page.waitForTimeout(250);
          const interactionLocator = page.getByRole("button", { name, exact: false });
          if (await interactionLocator.count() !== 1 || !(await interactionLocator.isVisible())) continue;
          const before = await readVisibleState();
          await interactionLocator.click({ timeout: 4000 });
          await page.waitForTimeout(350);
          const after = await readVisibleState();
          const outcome = describeVisibleOutcome(before, after);
          if (!outcome) continue;
          if (after.url !== before.url) {
            const landed = new URL(after.url);
            if (landed.origin === baseOrigin && !seen.has(normalizeCrawlUrl(landed.href))) {
              queue.push({
                featureIds: [],
                requestedPath: landed.pathname + landed.search + landed.hash,
                url: landed.href,
              });
            }
          }
          observed.interactions.push({
            kind: "click",
            locator: { name, strategy: "role", value: "button" },
            locatorEvidence,
            name,
            outcome,
          });
        } catch (error) {
          if (isAppUnavailableError(error)) throw error;
        }
      }
      for (const input of observed.inputLocators.slice(0, 6)) {
        if (!input.locatorEvidence || ["button", "checkbox", "file", "hidden", "radio", "submit"].includes(input.inputType)) continue;
        try {
          await page.goto(routeUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
          await page.waitForTimeout(250);
          const interactionLocator = createInteractionLocator(input.locator);
          if (await interactionLocator.count() !== 1 || !(await interactionLocator.isVisible())) continue;
          let outcome;
          if (input.controlKind === "select") {
            const options = await interactionLocator.locator("option").evaluateAll((entries) => entries.map((option) => ({
              disabled: option.disabled,
              label: (option.textContent || "").trim(),
              value: option.value,
            })));
            const currentValue = await interactionLocator.inputValue();
            const option = options.find((entry) => !entry.disabled && entry.value && entry.value !== currentValue);
            if (!option) continue;
            await interactionLocator.selectOption(option.value);
            if (await interactionLocator.inputValue() !== option.value) continue;
            outcome = input.name + " selected " + (option.label || option.value);
          } else {
            const value = input.inputType === "email"
              ? "demo@example.com"
              : input.inputType === "number"
                ? "1"
                : input.inputType === "password"
                  ? "makeademo-demo-password"
                  : "MakeADemo sample";
            await interactionLocator.fill(value);
            if (await interactionLocator.inputValue() !== value) continue;
            outcome = input.name + " contained the observed demo value";
          }
          observed.interactions.push({
            kind: input.controlKind,
            locator: input.locator,
            locatorEvidence: input.locatorEvidence,
            name: input.name,
            outcome,
          });
        } catch (error) {
          if (isAppUnavailableError(error)) throw error;
        }
      }
      await page.goto(routeUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(250);
      const slugHash = Math.abs([...path].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)).toString(36);
      const slug = (path === "/" ? "root" : path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "route") + "-" + slugHash;
      const screenshot = outputDirectory + "/" + slug + ".png";
      const snapshot = outputDirectory + "/" + slug + ".aria.yml";
      await page.screenshot({ fullPage: true, path: screenshot });
      const ariaSnapshot = typeof page.locator("body").ariaSnapshot === "function" ? await page.locator("body").ariaSnapshot() : await page.locator("body").innerText();
      await writeFile(snapshot, ariaSnapshot);
      result.routes.push({
        ...observed,
        featureIds: target.featureIds,
        path,
        requestedPath: target.requestedPath,
        screenshot,
        snapshot,
      });
      const primaryNames = new Set(observed.primaryNavigation);
      const orderedLinks = [...observed.links].sort(
        (a, b) => Number(primaryNames.has(b.name)) - Number(primaryNames.has(a.name)),
      );
      for (const link of orderedLinks) {
        const linkTarget = new URL(link.href, baseUrl);
        if (link.sameOrigin && linkTarget.origin === baseOrigin && !seen.has(normalizeCrawlUrl(linkTarget.toString()))) {
          queue.push({
            featureIds: target.featureIds ?? [],
            requestedPath: linkTarget.pathname + linkTarget.search + linkTarget.hash,
            url: linkTarget.toString(),
          });
        }
      }
    } catch (error) {
      result.unreachableRoutes.push({
        error: error instanceof Error ? error.message : String(error),
        featureIds: target.featureIds ?? [],
        url: target.url,
      });
      if (isAppUnavailableError(error)) break;
    }
  }
} catch (error) {
  result.fatalError = error instanceof Error ? error.message : String(error);
} finally {
  if (browser) await browser.close().catch(() => {});
}
await writeFile(outputDirectory + "/exploration.json", JSON.stringify(result)).catch(() => {});
process.stdout.write("\\n[makeademo:exploration] " + JSON.stringify(result) + "\\n");
`;
}

function createFeatureEntryTargets(
  baseUrl: string,
  featureInventory: PreparedDemoFeature[],
): Array<{ featureIds: string[]; requestedPath: string; url: string }> {
  const targets = new Map<
    string,
    { featureIds: Set<string>; requestedPath: string; url: string }
  >();
  for (const feature of featureInventory) {
    for (const entryPath of feature.entryPaths) {
      const url = new URL(entryPath, baseUrl);
      const absoluteUrl = url.toString();
      const existing = targets.get(absoluteUrl) ?? {
        featureIds: new Set<string>(),
        requestedPath: url.pathname + url.search + url.hash,
        url: absoluteUrl,
      };
      existing.featureIds.add(feature.id);
      targets.set(absoluteUrl, existing);
    }
  }
  return [...targets.values()].map((target) => ({
    featureIds: [...target.featureIds],
    requestedPath: target.requestedPath,
    url: target.url,
  }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

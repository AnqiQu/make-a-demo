import { createBrowserRuntimeNetworkPolicySource } from "../../shared/external-resources/browser-runtime-network-policy";
import type { ExternalResourceManifest } from "../../shared/external-resources/external-resource-manifest.schema";
import { shellQuote } from "../../shared/shell/shell-quote";
import {
  AgentHarnessCommandTimeoutError,
  type AgentHarnessSubmittedCodeAppStatus,
  type AgentHarnessWorkspace,
} from "../daytona/workspace.interface";
import { redactSecretText } from "../default/json-artifact-diagnostic";
import {
  type ActionCatalog,
  type AppMap,
  type FeatureVerdict,
  type NetworkAttempt,
  type PreparedDemoFeature,
  type ValidationReport,
  type VerifiedLocatorCandidate,
  readActionCatalog,
  readAppMap,
  readValidationReport,
} from "../schemas/artifacts";
import { findRoutePlaceholder } from "../tools/route-placeholders";
import {
  type SandboxCapacityEvidence,
  readSandboxCapacityEvidence,
  sandboxCapacityProbeCommand,
} from "../tools/sandbox-capacity";
import { readStderrErrorSignal } from "./stderr-error-signal";

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
      observation?: BrowserExplorationProtocol;
      validationReport: ValidationReport;
    }
  | {
      kind: "repairable-failure";
      observation?: BrowserExplorationProtocol;
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
  /**
   * Visible data tables/grids whose header cells rendered but whose body
   * contains zero populated rows. A silently-empty table is the signature of
   * a data query that resolved empty or mis-shaped — it produces no error,
   * no network failure, and no skeleton, so this structural fact is the only
   * browser evidence that distinguishes it from a broken transport. The
   * header texts are carried so harvested strings made only of header words
   * can be recognized as table structure rather than rendered data.
   * `skeletonRows` counts body rows that mounted with no cell text at all —
   * the signature of a loading state whose query never resolves (midday,
   * 2026-08-09), a third cause distinct from an empty result set.
   */
  emptyDataTables?: Array<{
    columnHeaders: number;
    headerTexts?: string[];
    skeletonRows?: number;
  }>;
  forms: string[];
  featureIds?: string[];
  /**
   * Count of visible data tables/grids with at least one populated body row.
   * A populated table proves the route's data surface renders rows, so the
   * zero-row grounding veto must not fire there even when a secondary table
   * on the same route is empty. The rows themselves are harvested into
   * `text`, where they ground features as ordinary route content.
   */
  populatedDataTables?: number;
  headings: string[];
  headingLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  inputLocators?: ObservedInputLocator[];
  inputs: string[];
  interactions?: ObservedInteraction[];
  links: ObservedLink[];
  /**
   * True when a full-viewport loading indicator was still covering the page
   * at harvest time despite the protocol's bounded readiness wait. Text
   * harvested behind such an overlay is not exercisable evidence, so
   * grounding failures on these routes steer repair at the app's startup
   * path, never at feature wording (cyberchef, 2026-08-08 matrix).
   */
  loadingOverlay?: boolean;
  /**
   * Text harvested from alert/status/live regions (toasts, banners). Error
   * copy is what an app shows when it fails, so these strings are
   * quarantined from `headings`/`text` at harvest: they can never ground a
   * feature or seed an assert, but they name the broken contract better
   * than any inference, so failed verdicts carry them as repair evidence
   * ("Could not load shared documents" — outline, 2026-08-08).
   */
  alerts?: string[];
  /**
   * HTTP status of the route's main-document response when it was an error
   * (>= 400). A 4xx/5xx document is a runtime fault no matter how plausible
   * the rendered shell looks, so this outranks every wording-based
   * diagnosis. Absent for healthy responses and for hash navigations, which
   * ride the last full document load.
   */
  documentStatus?: number;
  path: string;
  primaryNavigation: string[];
  requestedPath?: string;
  screenshot: string;
  scrollTargets?: ObservedScrollTarget[];
  snapshot: string;
  text: string[];
  textLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
  /**
   * Bounded body innerText captured only when the selector harvest found no
   * headings and no text. A crashed SPA route paints its exception as bare
   * unstructured body text — this sample lets an error-shaped body carry
   * its own diagnosis instead of reading as missing content.
   */
  textSample?: string;
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
  /**
   * The control state change this interaction caused (N105): a
   * self-renaming toggle or a control leaving its disabled state. Recorded
   * whenever the before/after control harvest shows one, independent of
   * which visible delta named the outcome — transition evidence is
   * wording-free proof of behavior.
   */
  stateTransition?: { control: string; from: string; to: string };
  /**
   * Text that became visible only after this interaction, verified as a
   * unique visible locator in the revealed state. Tool-shaped UIs render
   * their proof-text on demand, so these are the only assertable evidence
   * such routes can offer; alert/status copy never qualifies.
   */
  revealedTexts?: Array<{
    locatorEvidence?: ObservedLocatorEvidence | null;
    value: string;
  }>;
};
type UnreachableRoute = {
  error: string;
  featureIds?: string[];
  url: string;
};
/**
 * One declared proof's execution verdict (N107), recorded from a fresh
 * navigation of the feature's first entry route after the crawl. Where a
 * result exists it subsumes wording-based grounding for that feature:
 * `passed` grounds it, `!passed` fails it as declared-proof-failed. An
 * absent result (deadline, unreachable entry route) is missing evidence,
 * not failed evidence — the wording chain still applies.
 */
type DeclaredProofResult = {
  detail: string;
  featureId: string;
  locatorEvidence?: ObservedLocatorEvidence | null;
  passed: boolean;
};
type BrowserExplorationProtocol = {
  blockedNetworkAttempts: Array<
    Pick<NetworkAttempt, "host"> & Partial<NetworkAttempt>
  >;
  consoleErrors: string[];
  declaredProofs?: DeclaredProofResult[];
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
// The script itself lives outside /workspace: bun resolves imports by walking
// up from the script's directory before consulting NODE_PATH, so a submitted
// repo shipping its own @playwright/test would otherwise shadow the image's
// pinned install — the only one whose browsers exist in the image.
const explorerRuntimeDirectory = "/tmp/makeademo/exploration";
const explorerPath = `${explorerRuntimeDirectory}/explore-app.mjs`;
// Sized for per-navigation content waits on streaming-SSR apps; the script's
// own deadline stays at 70% of this budget, leaving headroom to finalize.
const explorationCommandTimeoutMs = 7 * 60_000;

/**
 * Explores the real prepared app with Playwright inside the secret-free
 * submitted-code sandbox. Implementations consuming this result can trust that
 * routes and locators came from browser observations rather than agent memory.
 *
 * `scope: "feature-entries"` restricts the crawl to the manifest's declared
 * entry routes plus the base URL — no discovered link or navigation is
 * followed — while keeping every other gate behavior (harvest, interactions,
 * declared proofs, verdict ledger) identical. This is the N108 preparation
 * probe: same judgment as the gate, cost proportional to the feature count.
 */
export async function exploreSubmittedApp(input: {
  baseUrl: string;
  externalResourceManifest?: ExternalResourceManifest;
  featureInventory?: PreparedDemoFeature[];
  preparationManifestId: string;
  requestedFeatures?: string[];
  scope?: "feature-entries" | "full";
  workspace: AgentHarnessWorkspace;
}): Promise<SubmittedAppExplorationResult> {
  const script = createExplorerScript(
    input.baseUrl,
    input.featureInventory ?? [],
    input.externalResourceManifest,
    input.scope ?? "full",
  );
  const encodedScript = Buffer.from(script).toString("base64");
  const capacityFailure = async (
    appStatus: AgentHarnessSubmittedCodeAppStatus | undefined,
  ) => {
    if (appStatus?.running !== false) return undefined;
    const evidence = await readWorkspaceCapacityEvidence(input.workspace);
    if (evidence === undefined || (evidence.oomKills ?? 0) === 0) {
      return undefined;
    }
    return createSandboxCapacityFailure({
      appStatus,
      baseUrl: input.baseUrl,
      evidence,
    });
  };
  let result: Awaited<
    ReturnType<AgentHarnessWorkspace["executeSubmittedCode"]>
  >;
  let recoveredObservation: BrowserExplorationProtocol | undefined;
  try {
    result = await input.workspace.executeSubmittedCode(
      [
        `mkdir -p ${explorerRuntimeDirectory}`,
        `rm -f ${explorerDirectory}/exploration.json`,
        `printf %s ${shellQuote(encodedScript)} | base64 -d > ${explorerPath}`,
        `NODE_PATH="\${MAKEADEMO_TOOLS_NODE_MODULES:-$(npm root -g)}" bun ${explorerPath}`,
      ].join(" && "),
      { timeoutMs: explorationCommandTimeoutMs },
    );
  } catch (error) {
    if (!(error instanceof AgentHarnessCommandTimeoutError)) {
      throw error;
    }
    // A script that finishes marginally after the command budget still
    // leaves its durable protocol behind; recover the crawl instead of
    // discarding it.
    recoveredObservation = await readExplorationProtocolFile(input.workspace);
    if (recoveredObservation === undefined) {
      const appStatus = await readAppStatus(input.workspace);
      // Unreadable status is genuinely ambiguous (the sandbox itself may be
      // gone) — preserve the infrastructure timeout. A live app that never
      // yielded a protocol is a wedged route, which an agent can repair
      // (outline's 420s hang killed the whole run unclassified, 2026-08-09).
      if (appStatus === undefined) throw error;
      if (appStatus.running !== false) {
        return createHungExplorationFailure({
          appStatus,
          baseUrl: input.baseUrl,
          timeoutError: error,
        });
      }
      return (
        (await capacityFailure(appStatus)) ??
        createExitedAppExplorationFailure({
          appStatus,
          baseUrl: input.baseUrl,
          timeoutError: error,
        })
      );
    }
    result = { exitCode: 0, stderr: "", stdout: "" };
  }

  const observation =
    recoveredObservation ??
    readExplorationProtocol(result.stdout) ??
    (await readExplorationProtocolFile(input.workspace));
  if (observation === undefined) {
    const appStatus = await readAppStatus(input.workspace);
    return (
      (await capacityFailure(appStatus)) ??
      createCrashedExplorerFailure({
        appStatus,
        baseUrl: input.baseUrl,
        result,
      })
    );
  }
  if (observation.routes.length === 0) {
    const appStatus = await readAppStatus(input.workspace);
    return (
      (await capacityFailure(appStatus)) ??
      createRepairableExplorationFailure({
        appStatus,
        baseUrl: input.baseUrl,
        observation,
      })
    );
  }

  const artifacts = createExplorationArtifacts({
    baseUrl: input.baseUrl,
    featureInventory: input.featureInventory ?? [],
    observation,
    preparationManifestId: input.preparationManifestId,
    requestedFeatures: input.requestedFeatures ?? [],
  });
  if (artifacts.validationReport.status !== "failed") return artifacts;
  // Browser-side evidence cannot see server-side render failures: an SSR
  // throw leaves pageErrors and consoleErrors empty while routes stream no
  // content. The managed app's stderr is evidence, never a gate — dev
  // servers also log benign errors, and watch-mode toolchains narrate
  // success on stderr, so the runtime-error hint fires only when an
  // error-class line survives the warning and zero-errors filters (N106).
  const diagnostics = createAppStatusDiagnostics(
    await readAppStatus(input.workspace),
  );
  if (diagnostics.stderrExcerpts.length === 0) return artifacts;
  const errorSignal = readStderrErrorSignal(
    diagnostics.stderrExcerpts.join("\n"),
  );
  return {
    ...artifacts,
    validationReport: {
      ...artifacts.validationReport,
      stderrExcerpts: diagnostics.stderrExcerpts,
      suggestedRepairHints: [
        ...(errorSignal === undefined
          ? []
          : [
              "Server-side runtime errors were observed while routes rendered; inspect the stderr evidence before changing feature selection.",
            ]),
        ...artifacts.validationReport.suggestedRepairHints,
      ],
    },
  };
}

async function readWorkspaceCapacityEvidence(
  workspace: AgentHarnessWorkspace,
): Promise<SandboxCapacityEvidence | undefined> {
  try {
    const result = await workspace.executeSubmittedCode(
      sandboxCapacityProbeCommand,
      { timeoutMs: 30_000 },
    );
    return readSandboxCapacityEvidence(`${result.stdout}\n${result.stderr}`);
  } catch {
    return undefined;
  }
}

/**
 * Shared shape of every repairable exploration failure report: identical
 * artifact, stage, excerpt, and status plumbing, with only the classification,
 * summary, hints, and observed browser evidence varying per failure kind.
 */
function explorationFailure(input: {
  baseUrl: string;
  classification: string;
  consoleErrors?: string[];
  diagnostics: { stderrExcerpts: string[]; stdoutExcerpts: string[] };
  hints: string[];
  networkAttempts?: NetworkAttempt[];
  observation?: BrowserExplorationProtocol;
  pageErrors?: string[];
  summary: string;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  return {
    kind: "repairable-failure",
    ...(input.observation === undefined
      ? {}
      : { observation: input.observation }),
    validationReport: readValidationReport({
      artifactReferences: [explorerPath],
      blockedNetworkAttempts: input.networkAttempts ?? [],
      browserObservations: [],
      consoleErrors: input.consoleErrors ?? [],
      failureClassification: input.classification,
      logsSummary: input.summary,
      networkAttempts: input.networkAttempts ?? [],
      pageErrors: input.pageErrors ?? [],
      retryCount: 0,
      screenshots: [],
      stage: "app-exploration",
      status: "failed",
      stderrExcerpts: input.diagnostics.stderrExcerpts,
      stdoutExcerpts: input.diagnostics.stdoutExcerpts,
      suggestedRepairHints: input.hints,
      urlChecked: input.baseUrl,
    }),
  };
}

function createSandboxCapacityFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus;
  baseUrl: string;
  evidence: SandboxCapacityEvidence;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  const memoryCeiling =
    input.evidence.memoryMaxBytes === undefined
      ? ""
      : ` under a ${Math.round(input.evidence.memoryMaxBytes / (1024 * 1024))} MiB memory ceiling`;
  return explorationFailure({
    baseUrl: input.baseUrl,
    classification: "sandbox capacity exceeded",
    diagnostics,
    hints: [
      "Rebuild the MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT snapshot with a larger sandbox class (more memory and cpu); no repository change can add sandbox capacity.",
    ],
    summary: `The sandbox killed the prepared app: the cgroup reports ${input.evidence.oomKills} OOM kill(s)${memoryCeiling}. The app needs more resources than the submitted-code sandbox provides.${diagnostics.output ? ` App output: ${diagnostics.output}` : ""}`,
  });
}

function createExitedAppExplorationFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus;
  baseUrl: string;
  timeoutError: AgentHarnessCommandTimeoutError;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  return explorationFailure({
    baseUrl: input.baseUrl,
    classification: "start failure",
    diagnostics,
    hints: [
      "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration.",
    ],
    summary: `The prepared app exited${input.appStatus.exitCode === undefined ? "" : ` with code ${input.appStatus.exitCode}`} while App Exploration was running: ${diagnostics.output || input.timeoutError.message}`,
  });
}

function createHungExplorationFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus;
  baseUrl: string;
  timeoutError: AgentHarnessCommandTimeoutError;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  return explorationFailure({
    baseUrl: input.baseUrl,
    classification: "render timeout",
    diagnostics,
    hints: [
      "The app serves requests but at least one explored route or interaction never settles. Repair the prepared app's hanging data or navigation path — a request that waits forever on missing backend state is the usual cause — then rerun browser exploration.",
    ],
    summary: `App Exploration timed out after ${Math.round(input.timeoutError.timeoutMs / 1000)}s with the prepared app still running: the browser protocol never completed, so a route or interaction is hanging rather than failing.${diagnostics.output ? ` App output: ${diagnostics.output}` : ""}`,
  });
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
  // The 404 probe exists only to teach the backend the app's not-found
  // signature; it must never appear in the AppMap or ground anything.
  const probeRoute = input.observation.routes.find((route) =>
    route.path.includes(notFoundProbePathMarker),
  );
  const observedRoutes = input.observation.routes.filter(
    (route) => route !== probeRoute,
  );
  const distinctContentByRoute = readRouteDistinctContent(observedRoutes);
  const errorState = readErrorStateRoutes({
    authWallRoutePaths: new Set(
      observedRoutes.filter(isAuthWall).map((route) => route.path),
    ),
    distinctContentByRoute,
    pageErrors: input.observation.pageErrors,
    ...(probeRoute === undefined ? {} : { probeRoute }),
    routes: observedRoutes,
  });
  for (const path of errorState.suppressedRoutePaths) {
    distinctContentByRoute.set(path, []);
  }
  const stuckLoadingRoutes = new Set(
    observedRoutes
      .filter((route) => route.loadingOverlay === true)
      .map((route) => route.path),
  );
  const routes: Array<Record<string, unknown>> = [];
  const loginOrAuthWalls: string[] = [];
  const emptyDataTablesByRoute = new Map<
    string,
    { columnHeaders: number; skeletonRows: number }
  >();
  const populatedTableRoutes = new Set<string>();
  for (const route of observedRoutes) {
    routes.push({
      buttons: route.buttons,
      ...(route.featureIds === undefined
        ? {}
        : { featureIds: route.featureIds }),
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
      text: route.text,
      title: route.title,
    });
    if (isAuthWall(route)) {
      loginOrAuthWalls.push(route.path);
    }
    if ((route.emptyDataTables?.length ?? 0) > 0) {
      emptyDataTablesByRoute.set(route.path, {
        columnHeaders: route.emptyDataTables?.[0]?.columnHeaders ?? 0,
        skeletonRows: route.emptyDataTables?.[0]?.skeletonRows ?? 0,
      });
    }
    if ((route.populatedDataTables ?? 0) > 0) {
      populatedTableRoutes.add(route.path);
    }
  }
  const appMap = readAppMap({
    actionCatalogId,
    baseUrl: input.baseUrl,
    blockedNetworkAttempts: networkAttempts,
    consoleErrors: unique(input.observation.consoleErrors),
    discoveredRoutes: routes,
    id: appMapId,
    loginOrAuthWalls,
    networkAttempts,
    pageErrors: unique(input.observation.pageErrors),
  });
  const declaredProofResults = new Map(
    (input.observation.declaredProofs ?? []).map((proof) => [
      proof.featureId,
      proof,
    ]),
  );
  const actionCatalog = readActionCatalog({
    actions: [
      ...createActions(
        observedRoutes,
        input.featureInventory,
        explicitAuthenticationFeatureIds,
        distinctContentByRoute,
        errorState.suppressedRoutePaths,
      ),
      ...createDeclaredProofActions(
        input.featureInventory,
        declaredProofResults,
      ),
    ],
    appMapId,
    id: actionCatalogId,
  });
  const validationReport = createExplorationValidationReport({
    actionCatalog,
    appMap,
    declaredProofResults,
    distinctContentByRoute,
    emptyDataTablesByRoute,
    errorEvidenceByRoute: errorState.evidenceByRoute,
    explicitAuthenticationFeatureIds,
    featureInventory: input.featureInventory,
    networkAttempts,
    populatedTableRoutes,
    stuckLoadingRoutes,
    unreachableRoutes: input.observation.unreachableRoutes ?? [],
  });

  return {
    actionCatalog,
    appMap,
    kind: "artifacts",
    observation: input.observation,
    validationReport,
  };
}

function createRepairableExplorationFailure(input: {
  appStatus: AgentHarnessSubmittedCodeAppStatus | undefined;
  baseUrl: string;
  observation: BrowserExplorationProtocol;
}): Extract<SubmittedAppExplorationResult, { kind: "repairable-failure" }> {
  const networkAttempts = readObservedNetworkAttempts(input.observation);
  const appExited = input.appStatus?.running === false;
  const diagnostics = createAppStatusDiagnostics(input.appStatus);
  return explorationFailure({
    baseUrl: input.baseUrl,
    classification: appExited
      ? "app route crashes"
      : "app route not discoverable",
    consoleErrors: unique(input.observation.consoleErrors),
    diagnostics,
    hints: appExited
      ? [
          "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration.",
        ]
      : [
          "Repair the prepared app start command, base URL, route crash, or initial app state, then rerun browser exploration.",
        ],
    networkAttempts,
    observation: input.observation,
    pageErrors: unique(input.observation.pageErrors),
    summary: appExited
      ? `The prepared app exited${input.appStatus?.exitCode === undefined ? "" : ` with code ${input.appStatus.exitCode}`} while Playwright was exploring it${diagnostics.output ? `: ${diagnostics.output}` : "."}`
      : `Playwright completed exploration but did not discover a browser route to ground Flow Planning.${
          input.observation.fatalError === undefined
            ? ""
            : ` Explorer error: ${input.observation.fatalError}`
        }${(input.observation.unreachableRoutes ?? [])
          .slice(0, 3)
          .map((route) => ` Unreachable ${route.url}: ${route.error}`)
          .join(" |")}`,
  });
}

function createAppStatusDiagnostics(
  appStatus?: AgentHarnessSubmittedCodeAppStatus,
): {
  output: string;
  stderrExcerpts: string[];
  stdoutExcerpts: string[];
} {
  // One server-side render error with its cause and stack runs 1-2KB; a
  // shorter tail truncates the error name away and leaves only frame noise.
  const stderrExcerpt = redactSecretText(appStatus?.stderr.slice(-2000) ?? "");
  const stdoutExcerpt = redactSecretText(appStatus?.stdout.slice(-2000) ?? "");
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
    return await workspace.readSubmittedCodeAppStatus();
  } catch {
    return undefined;
  }
}

/**
 * Splits harvested route evidence into shared navigation chrome and
 * route-distinct content, keyed by route path. Chrome is the union of every
 * route's primaryNavigation strings plus — only when at least four routes
 * exist — any string repeated on more than half the routes. Headings are
 * excluded only by repetition, never by nav membership: a page title matching
 * its nav label is normal content, while a string repeated on most routes is
 * site chrome wherever it appears. Buttons, inputs, and links never count as
 * content: controls exist identically in hollow and healthy apps, so they
 * cannot evidence rendered data. Strings made only of a route's empty-table
 * header words are excluded the same way: a zero-row table renders its
 * column headers — individually and as the combined header-row name — in a
 * skeleton app exactly as in a healthy one.
 */
export function readRouteDistinctContent(
  routes: ReadonlyArray<{
    emptyDataTables?: Array<{ columnHeaders: number; headerTexts?: string[] }>;
    headings: string[];
    path: string;
    primaryNavigation?: string[];
    text: string[];
  }>,
): Map<string, string[]> {
  const trimmed = (values: string[]) =>
    values.map((value) => value.trim()).filter((value) => value.length > 0);
  // Repetition is counted per shell, not per explored path: query and
  // fragment variants of one pathname are one page whose persistent UI is
  // the product (single-shell tools prepare /?flow=… entry routes —
  // excalidraw, cyberchef 2026-08-07). "#/…" stays a distinct page: hash
  // routing is real routing.
  const routeShells = new Map<string, Set<string>>();
  for (const route of routes) {
    const shell = routeShellKey(route.path);
    const values = routeShells.get(shell) ?? new Set<string>();
    for (const value of trimmed([...route.headings, ...route.text])) {
      values.add(value);
    }
    routeShells.set(shell, values);
  }
  // A single-shell app has no cross-page navigation to discount: its
  // nav-role markup is the product (cyberchef's operations sidebar,
  // 2026-08-08), so nav-matched text stays distinct — but ranked last, so
  // genuine page content still leads assert selection. Multi-shell apps
  // keep the full nav exclusion. The zero-row-table and assert-matching
  // gates still guard hollowness downstream.
  const singleShell = routeShells.size === 1;
  const navChrome = new Set(
    routes.flatMap((route) => trimmed(route.primaryNavigation ?? [])),
  );
  const occurrences = new Map<string, number>();
  for (const values of routeShells.values()) {
    for (const value of values) {
      occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
    }
  }
  const repeatedChrome = new Set(
    routeShells.size < 4
      ? []
      : [...occurrences]
          .filter(([, count]) => count > routeShells.size / 2)
          .map(([value]) => value),
  );
  const tokens = (value: string) =>
    value.toLowerCase().split(/\s+/).filter(Boolean);
  return new Map(
    routes.map((route) => {
      const headerTokens = new Set(
        (route.emptyDataTables ?? []).flatMap((table) =>
          (table.headerTexts ?? []).flatMap(tokens),
        ),
      );
      // Case-insensitive token comparison bridges the accessible-name vs
      // innerText gap (text-transform styling affects only the latter).
      const isEmptyTableStructure = (value: string) =>
        headerTokens.size > 0 &&
        tokens(value).every((token) => headerTokens.has(token));
      const routeText = trimmed(route.text).filter(
        (value) => !repeatedChrome.has(value) && !isEmptyTableStructure(value),
      );
      return [
        route.path,
        unique([
          ...trimmed(route.headings).filter(
            (value) =>
              !repeatedChrome.has(value) && !isEmptyTableStructure(value),
          ),
          ...routeText.filter((value) => !navChrome.has(value)),
          ...(singleShell
            ? routeText.filter((value) => navChrome.has(value))
            : []),
        ]),
      ];
    }),
  );
}

/**
 * The synthetic path the explorer visits before real routes to learn what
 * this app renders for a URL that cannot exist. The harvested page is kept
 * out of the AppMap; its content is only the app's not-found signature.
 */
const notFoundProbePathMarker = "__makeademo-404-probe__";

/**
 * Identifies routes whose harvested evidence describes failure rather than
 * product behavior, so grounding and assert selection never build on it
 * (outline's demo asserted its own error boundary, 2026-08-08). Two
 * framework-agnostic signals: a route rendering nothing beyond the 404
 * probe's content is a not-found page wearing a valid URL, and a route with
 * a route-specific uncaught page error is a crash surface. Guards: the
 * probe is uninformative when it matches the app's root route (apps that
 * render home for unknown URLs), and an error message repeated on more
 * than half of ≥4 routes is ambient noise, not a route defect. Returns the
 * suppressed route paths plus per-route evidence strings (alerts, page
 * errors, the not-found verdict) for repair steering.
 */
function readErrorStateRoutes(input: {
  authWallRoutePaths: ReadonlySet<string>;
  distinctContentByRoute: ReadonlyMap<string, string[]>;
  pageErrors: string[];
  probeRoute?: {
    headings: string[];
    path: string;
    primaryNavigation?: string[];
    text: string[];
  };
  routes: ReadonlyArray<{
    alerts?: string[];
    documentStatus?: number;
    headings: string[];
    path: string;
    primaryNavigation?: string[];
    text: string[];
    textLocatorEvidence?: Array<ObservedLocatorEvidence | null>;
    textSample?: string;
  }>;
}): {
  evidenceByRoute: Map<string, string[]>;
  suppressedRoutePaths: Set<string>;
} {
  const evidenceByRoute = new Map<string, string[]>();
  const suppressedRoutePaths = new Set<string>();
  const addEvidence = (path: string, values: string[]) => {
    if (values.length === 0) return;
    evidenceByRoute.set(path, [
      ...(evidenceByRoute.get(path) ?? []),
      ...values,
    ]);
  };
  for (const route of input.routes) {
    addEvidence(route.path, unique(route.alerts ?? []));
    // A 4xx/5xx main-document response is a runtime fault no matter how
    // plausible the rendered shell looks — except a 401/403 that renders a
    // login wall, which is product surface the auth-wall verdict owns.
    if (
      route.documentStatus !== undefined &&
      route.documentStatus >= 400 &&
      !(
        (route.documentStatus === 401 || route.documentStatus === 403) &&
        input.authWallRoutePaths.has(route.path)
      )
    ) {
      suppressedRoutePaths.add(route.path);
      addEvidence(route.path, [
        `HTTP ${route.documentStatus} document response — a runtime fault, not a wording fault`,
      ]);
    }
    // A bare error body carries its own diagnosis: the sample exists only
    // when the selector harvest saw nothing, and it suppresses only when it
    // is error-shaped and no verified content contradicts it.
    const verifiedTextCount =
      route.textLocatorEvidence === undefined
        ? route.text.length
        : route.text.filter((_, index) =>
            Boolean(route.textLocatorEvidence?.[index]),
          ).length;
    if (
      route.textSample !== undefined &&
      route.headings.length === 0 &&
      verifiedTextCount === 0 &&
      readStderrErrorSignal(route.textSample) !== undefined
    ) {
      suppressedRoutePaths.add(route.path);
      addEvidence(route.path, [
        `bare error body: ${route.textSample.slice(0, 200)}`,
      ]);
    }
  }

  const shellCount = new Set(
    input.routes.map((route) => routeShellKey(route.path)),
  ).size;
  const errorShells = new Map<string, Set<string>>();
  const parsedErrors: Array<{ message: string; shell: string }> = [];
  for (const pageError of input.pageErrors) {
    const separator = pageError.indexOf(": ");
    if (separator === -1 || !pageError.startsWith("http")) continue;
    const message = pageError.slice(separator + 2);
    let shell: string;
    try {
      const url = new URL(pageError.slice(0, separator));
      shell = routeShellKey(url.pathname + url.search + url.hash);
    } catch {
      continue;
    }
    parsedErrors.push({ message, shell });
    const shells = errorShells.get(message) ?? new Set<string>();
    shells.add(shell);
    errorShells.set(message, shells);
  }
  const ambient = (message: string) =>
    shellCount >= 4 && (errorShells.get(message)?.size ?? 0) > shellCount / 2;
  for (const route of input.routes) {
    const shell = routeShellKey(route.path);
    const routeErrors = unique(
      parsedErrors
        .filter((error) => error.shell === shell && !ambient(error.message))
        .map((error) => error.message),
    );
    if (routeErrors.length === 0) continue;
    suppressedRoutePaths.add(route.path);
    addEvidence(
      route.path,
      routeErrors.map((message) => `uncaught page error: ${message}`),
    );
  }

  if (input.probeRoute !== undefined) {
    const probeDistinct = new Set(
      readRouteDistinctContent([...input.routes, input.probeRoute]).get(
        input.probeRoute.path,
      ) ?? [],
    );
    const rootRoute = input.routes.find(
      (route) => routeShellKey(route.path) === "/",
    );
    const rootDistinct = new Set(
      rootRoute === undefined
        ? []
        : (input.distinctContentByRoute.get(rootRoute.path) ?? []),
    );
    const probeMatchesRoot =
      rootRoute !== undefined &&
      probeDistinct.size === rootDistinct.size &&
      [...probeDistinct].every((value) => rootDistinct.has(value));
    if (probeDistinct.size > 0 && !probeMatchesRoot) {
      for (const route of input.routes) {
        const distinct = input.distinctContentByRoute.get(route.path) ?? [];
        if (
          distinct.length === 0 ||
          !distinct.every((value) => probeDistinct.has(value))
        ) {
          continue;
        }
        suppressedRoutePaths.add(route.path);
        addEvidence(route.path, [
          "renders the app's not-found page (its content matches what an unknown URL shows)",
        ]);
      }
    }
  }

  return { evidenceByRoute, suppressedRoutePaths };
}

// One shell per pathname: the query is state, and a fragment is state unless
// it begins with "#/" (hash routing), in which case the hashed path — minus
// its own query — is part of the page identity.
function routeShellKey(path: string): string {
  const hashIndex = path.indexOf("#");
  const hash = hashIndex === -1 ? "" : path.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const pathname = beforeHash.split("?")[0] ?? beforeHash;
  return hash.startsWith("#/")
    ? `${pathname}${hash.split("?")[0] ?? hash}`
    : pathname;
}

function createActions(
  routes: ObservedRoute[],
  featureInventory: PreparedDemoFeature[],
  explicitAuthenticationFeatureIds: ReadonlySet<string>,
  distinctContentByRoute: ReadonlyMap<string, string[]>,
  errorStateRoutePaths: ReadonlySet<string> = new Set(),
) {
  const actions: Array<Record<string, unknown>> = [];
  // Every assert leaves a record so the per-feature floor below can re-tag
  // one without reparsing the built actions. floorFeatureIds is the set of
  // features the floor may add on that assert's route: the route's own tags,
  // except on auth walls, whose explicit-only tagging must hold.
  const assertRecords: Array<{
    evidenceText: string;
    featureIds: string[];
    floorFeatureIds: readonly string[];
  }> = [];
  routes.forEach((fullRoute, routeIndex) => {
    // A crashed or not-found page's controls are not product surface: the
    // 2026-08-08 outline demo clicked its error boundary's "Reload" button
    // as the feature interaction. Navigation stays observable; everything
    // else on an error-state route is off the catalog.
    const route = errorStateRoutePaths.has(fullRoute.path)
      ? {
          ...fullRoute,
          buttons: [],
          headings: [],
          inputLocators: [],
          inputs: [],
          interactions: [],
          scrollTargets: [],
          text: [],
        }
      : fullRoute;
    const matchFeatureIds = (evidence: string) =>
      matchActionFeatureIds(
        route,
        evidence,
        featureInventory,
        explicitAuthenticationFeatureIds,
      );
    const floorFeatureIds = isAuthWall(route) ? [] : (route.featureIds ?? []);
    const recordAssert = (evidenceText: string, featureIds: string[]) => {
      assertRecords.push({ evidenceText, featureIds, floorFeatureIds });
      return featureIds;
    };
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
        featureIds: recordAssert(heading, matchFeatureIds(heading)),
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
    // Text asserts are emitted on every route, headings or not: a page
    // title grounds nothing about the data beneath it, and the harvested
    // strings a feature actually needs — metrics, row text, pane labels —
    // must be assertable wherever they rendered.
    {
      const verifiedTexts = route.text
        .map((text, index) => ({ index, text }))
        .filter(
          ({ index, text }) =>
            text.length > 0 &&
            (route.textLocatorEvidence === undefined ||
              Boolean(route.textLocatorEvidence[index])),
        );
      // Route-distinct text first, in the distinct list's own order: the
      // list already ranks genuine content ahead of nav-matched text on
      // single-shell apps, and chrome-only asserts are ungroundable for
      // data features, so downstream planning needs content candidates
      // ahead of navigation labels.
      const distinctRank = new Map(
        (distinctContentByRoute.get(route.path) ?? []).map(
          (value, index) => [value, index] as const,
        ),
      );
      const textCandidates = [
        ...verifiedTexts
          .filter(({ text }) => distinctRank.has(text.trim()))
          .sort(
            (a, b) =>
              (distinctRank.get(a.text.trim()) ?? 0) -
              (distinctRank.get(b.text.trim()) ?? 0),
          ),
        ...verifiedTexts.filter(({ text }) => !distinctRank.has(text.trim())),
      ].slice(0, 3);
      // The shared slots can all go to strings matching no feature while
      // the texts that could token-match one sit past the cap. Preparation
      // cannot influence which texts become asserts, so each feature tagged
      // to the route gets at least one verified text whose tokens match it.
      for (const feature of featureInventory) {
        if (!(route.featureIds ?? []).includes(feature.id)) continue;
        const featureTokens = featureSemanticTokens(feature);
        const matchesFeature = (candidate: { text: string }) =>
          semanticTokens(candidate.text).some((token) =>
            featureTokens.includes(token),
          );
        if (textCandidates.some(matchesFeature)) continue;
        const extra = verifiedTexts.find(
          (candidate) =>
            !textCandidates.includes(candidate) && matchesFeature(candidate),
        );
        if (extra !== undefined) {
          textCandidates.push(extra);
        }
      }
      textCandidates.forEach(
        ({ index: textIndex, text: visibleText }, order) => {
          const id =
            order === 0
              ? `assert-visible-text-${routeIndex + 1}`
              : `assert-visible-text-${routeIndex + 1}-${order + 1}`;
          actions.push({
            confidence: 0.85,
            evidence: `Playwright observed visible text on ${route.path}`,
            expectedResult: `${visibleText} remains visible`,
            featureIds: recordAssert(visibleText, matchFeatureIds(visibleText)),
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
        },
      );
      // The control fallback exists so a route is never assert-free; it
      // only fires when neither headings nor text produced an assert.
      if (route.headings.length === 0 && textCandidates.length === 0) {
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
            featureIds: recordAssert(
              visibleButton,
              matchFeatureIds(visibleButton),
            ),
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
        ...(interaction.stateTransition === undefined
          ? {}
          : { stateTransition: interaction.stateTransition }),
      });
      (interaction.revealedTexts ?? []).forEach(
        (revealedText, revealedIndex) => {
          if (!revealedText.locatorEvidence) return;
          const assertId = `assert-revealed-${routeIndex + 1}-${index + 1}-${revealedIndex + 1}`;
          actions.push({
            confidence: 0.95,
            evidence: `Playwright observed "${revealedText.value}" appear after exercising ${interaction.name} on ${route.path}`,
            expectedResult: `${revealedText.value} becomes visible after ${interaction.name}`,
            featureIds: recordAssert(
              revealedText.value,
              matchFeatureIds(`${interaction.name} ${revealedText.value}`),
            ),
            id: assertId,
            kind: "assert",
            ...createLocatorCandidateFields(
              assertId,
              revealedText.locatorEvidence,
            ),
            preferredLocator: { strategy: "text", value: revealedText.value },
            revealedBy: id,
            risks: [],
            route: route.path,
          });
        },
      );
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

  // The assert floor: winner-take-all tagging can leave a route-tagged
  // feature with zero asserts even though a shared string's tokens overlap
  // its wording — the run then fails on a scoring artifact, not missing
  // evidence. Any feature still assertless after tagging keeps at least
  // one: its best wording-matched assert gains the feature's id alongside
  // the winners. Features nowhere route-tagged stay untouched, so redirect
  // and tagging misses keep their honest route-shared verdicts.
  for (const feature of featureInventory) {
    if (
      assertRecords.some((record) => record.featureIds.includes(feature.id))
    ) {
      continue;
    }
    const featureTokens = featureSemanticTokens(feature);
    let best:
      | { record: (typeof assertRecords)[number]; score: number }
      | undefined;
    for (const record of assertRecords) {
      if (!record.floorFeatureIds.includes(feature.id)) continue;
      const score = semanticTokens(record.evidenceText).filter((token) =>
        featureTokens.includes(token),
      ).length;
      if (score > 0 && (best === undefined || score > best.score)) {
        best = { record, score };
      }
    }
    if (best !== undefined) {
      best.record.featureIds.push(feature.id);
    }
  }

  return actions;
}

/**
 * Passed declared proofs become first-class catalog actions: the same typed
 * outcome Script Generation and Capture consume, so the assertion language
 * is one across all three stages. A state-transition proof is an exercised
 * click carrying its transition; the other kinds are asserts.
 */
function createDeclaredProofActions(
  featureInventory: PreparedDemoFeature[],
  declaredProofResults: ReadonlyMap<string, DeclaredProofResult>,
): Array<Record<string, unknown>> {
  return featureInventory.flatMap((feature): Array<Record<string, unknown>> => {
    const proof = feature.expectedProof;
    const proofResult =
      proof === undefined ? undefined : declaredProofResults.get(feature.id);
    if (
      proof === undefined ||
      proofResult === undefined ||
      !proofResult.passed
    ) {
      return [];
    }
    const id = `declared-proof-${feature.id}`;
    const route = feature.entryPaths[0] ?? "/";
    if (proof.kind === "state-transition") {
      return [
        {
          confidence: 1,
          evidence: `Declared proof executed: ${proofResult.detail}`,
          exercised: true,
          expectedResult: proofResult.detail,
          featureIds: [feature.id],
          id,
          kind: "click",
          preferredLocator: {
            name: proof.locator,
            strategy: "role",
            value: "button",
          },
          risks: [],
          route,
          stateTransition: {
            control: proof.locator,
            from: proof.from,
            to: proof.to,
          },
        },
      ];
    }
    return [
      {
        confidence: 1,
        evidence: `Declared proof executed: ${proofResult.detail}`,
        expectedResult:
          proof.kind === "visible-text"
            ? `${proof.text} remains visible`
            : `${proof.name} remains visible`,
        featureIds: [feature.id],
        id,
        kind: "assert",
        ...createLocatorCandidateFields(id, proofResult.locatorEvidence),
        preferredLocator:
          proof.kind === "visible-text"
            ? { strategy: "text", value: proof.text }
            : { name: proof.name, strategy: "role", value: "button" },
        risks: [],
        route,
      },
    ];
  });
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
      score: featureSemanticTokens(feature).filter((token) =>
        actionTokens.includes(token),
      ).length,
    }));
  const bestScore = Math.max(0, ...matches.map(({ score }) => score));
  return bestScore === 0
    ? []
    : matches.filter(({ score }) => score === bestScore).map(({ id }) => id);
}

/** The one token recipe for matching browser evidence against a feature. */
function featureSemanticTokens(feature: PreparedDemoFeature): string[] {
  return semanticTokens(
    `${feature.id} ${feature.label} ${feature.requestedFeature ?? ""} ${feature.description}`,
  );
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

type CatalogAction = ActionCatalog["actions"][number];

function readActionsByFeatureId(
  actionCatalog: ActionCatalog,
): Map<string, CatalogAction[]> {
  const actionsByFeatureId = new Map<string, CatalogAction[]>();
  for (const action of actionCatalog.actions) {
    for (const featureId of action.featureIds ?? []) {
      const tagged = actionsByFeatureId.get(featureId);
      if (tagged === undefined) {
        actionsByFeatureId.set(featureId, [action]);
      } else {
        tagged.push(action);
      }
    }
  }
  return actionsByFeatureId;
}

/**
 * Routes whose page renders route-distinct content. Interaction-revealed
 * text is a route's content rendered on demand: for tool-shaped UIs it is
 * the only content the route can ever show, so a route carrying a revealed
 * assert is content-bearing for grounding and must never be classified
 * hollow.
 */
function readContentRoutePaths(
  distinctContentByRoute: ReadonlyMap<string, string[]>,
  actionCatalog: ActionCatalog,
): Set<string> {
  const contentRoutePaths = new Set(
    [...distinctContentByRoute]
      .filter(([, content]) => content.length > 0)
      .map(([path]) => path),
  );
  for (const action of actionCatalog.actions) {
    if (action.revealedBy !== undefined) {
      contentRoutePaths.add(action.route);
    }
  }
  return contentRoutePaths;
}

/** Features blocked by an auth wall the maker never asked to film. */
function readAuthWallFeatureIds(
  appMap: AppMap,
  featureInventory: PreparedDemoFeature[],
  explicitAuthenticationFeatureIds: ReadonlySet<string>,
): Set<string> {
  const inventoryIds = new Set(featureInventory.map(({ id }) => id));
  const authWallRoutes = new Set(appMap.loginOrAuthWalls);
  return new Set(
    appMap.discoveredRoutes
      .filter((route) => authWallRoutes.has(route.path))
      .flatMap((route) =>
        (route.featureIds ?? []).filter(
          (featureId) =>
            inventoryIds.has(featureId) &&
            !explicitAuthenticationFeatureIds.has(featureId),
        ),
      ),
  );
}

/**
 * Grounds every prepared feature into one structured verdict (N106). This is
 * the single grounding computation: the failure classifier and its steering
 * prose derive from these enums, the validation report persists them, and
 * the verify-features probe returns them — so what repair reads, what
 * fingerprints hash, and what the gate enforced can never drift apart.
 * Diagnosis precedence mirrors physical causality: an auth wall or an entry
 * route that never loaded outranks content diagnoses, a stuck loading
 * overlay outranks table and wording diagnoses, and wording is blamed only
 * once the route demonstrably rendered content.
 */
function readFeatureVerdicts(input: {
  actionCatalog: ActionCatalog;
  actionsByFeatureId: ReadonlyMap<string, CatalogAction[]>;
  authWallFeatureIds: ReadonlySet<string>;
  contentRoutePaths: ReadonlySet<string>;
  declaredProofResults: ReadonlyMap<string, DeclaredProofResult>;
  distinctContentByRoute: ReadonlyMap<string, string[]>;
  emptyDataTablesByRoute: ReadonlyMap<
    string,
    { columnHeaders: number; skeletonRows: number }
  >;
  errorEvidenceByRoute: ReadonlyMap<string, string[]>;
  featureInventory: PreparedDemoFeature[];
  populatedTableRoutes: ReadonlySet<string>;
  stuckLoadingRoutes: ReadonlySet<string>;
  unreachableRoutes: UnreachableRoute[];
}): FeatureVerdict[] {
  // A zero-row data table is the feature's data surface rendering empty:
  // for a requested feature it vetoes the route's other distinct strings
  // (summary cards, tab labels), which render from separate queries in
  // hollow and healthy apps alike. A populated table on the same route
  // lifts the veto — the data surface demonstrably renders rows — and
  // non-requested features keep the plain content rule so the default demo
  // can still select around such routes.
  const demonstrableRoute = (feature: PreparedDemoFeature, route: string) =>
    input.contentRoutePaths.has(route) &&
    (feature.requestedFeature === undefined ||
      !input.emptyDataTablesByRoute.has(route) ||
      input.populatedTableRoutes.has(route));
  const failed = (
    feature: PreparedDemoFeature,
    failedBecause: NonNullable<FeatureVerdict["failedBecause"]>,
    detail: string,
    evidence: string[],
  ): FeatureVerdict => ({
    detail,
    ...(evidence.length === 0 ? {} : { evidence: evidence.slice(0, 6) }),
    failedBecause,
    featureId: feature.id,
    verdict: "failed",
  });
  return input.featureInventory.map((feature) => {
    if (input.authWallFeatureIds.has(feature.id)) {
      return failed(
        feature,
        "auth-wall",
        "entry routes redirected to authentication the maker did not request footage of",
        feature.entryPaths,
      );
    }
    // A declared proof's executed verdict subsumes the wording bridge
    // (N107): "undo/redo" must pass its declared transition, not ride a
    // nearby heading. An absent result is missing evidence, not failed
    // evidence — the wording chain below still applies.
    const proofResult =
      feature.expectedProof === undefined
        ? undefined
        : input.declaredProofResults.get(feature.id);
    if (proofResult !== undefined) {
      if (proofResult.passed) {
        return {
          detail: proofResult.detail,
          evidence: [`declared-proof-${feature.id}`],
          featureId: feature.id,
          groundedBy: "declared-proof",
          verdict: "grounded",
        } satisfies FeatureVerdict;
      }
      return failed(
        feature,
        "declared-proof-failed",
        proofResult.detail,
        feature.entryPaths,
      );
    }
    const tagged = input.actionsByFeatureId.get(feature.id) ?? [];
    const exercisedActions = tagged.filter(
      (action) => action.exercised === true,
    );
    const matchingAsserts = tagged.filter(
      (action) =>
        action.kind === "assert" &&
        assertEvidenceMatchesFeature(action, feature),
    );
    // A browser-exercised interaction proves the feature. Without one,
    // verified assert evidence counts only when its visible text matches
    // the feature, so read-only pages can ground while a wrong entry route
    // that merely renders unrelated content cannot. Either way the feature
    // needs a tagged route with route-distinct content: exercising a search
    // box on a page that renders nothing demonstrates nothing.
    if (
      (exercisedActions.length > 0 || matchingAsserts.length > 0) &&
      tagged.some((action) => demonstrableRoute(feature, action.route))
    ) {
      // A recorded control transition is the strongest exercised evidence:
      // wording-free, so steering must never send it to wording alignment.
      const transitionAction = exercisedActions.find(
        (action) => action.stateTransition !== undefined,
      );
      const [decisiveAssert] = matchingAsserts;
      const decisive =
        exercisedActions.length > 0 ? exercisedActions : matchingAsserts;
      const transition = transitionAction?.stateTransition;
      return {
        detail:
          transition !== undefined
            ? transition.control === transition.from
              ? `${transition.from} → ${transition.to}`
              : `${transition.control}: ${transition.from} → ${transition.to}`
            : exercisedActions.length > 0
              ? (exercisedActions[0]?.expectedResult ??
                "exercised in the browser")
              : decisiveAssert === undefined
                ? "matched verified assert evidence"
                : `matched on-screen text ${JSON.stringify(
                    readAssertEvidenceText(decisiveAssert),
                  )}`,
        evidence: unique(
          (transitionAction === undefined
            ? decisive
            : [transitionAction, ...decisive]
          ).map(({ id }) => id),
        ).slice(0, 4),
        featureId: feature.id,
        groundedBy:
          transitionAction !== undefined
            ? "state-transition"
            : exercisedActions.length > 0
              ? "interaction"
              : "assert",
        verdict: "grounded",
      } satisfies FeatureVerdict;
    }
    const unreachable = input.unreachableRoutes.filter((route) =>
      (route.featureIds ?? []).includes(feature.id),
    );
    if (unreachable.length > 0) {
      return failed(
        feature,
        "app-unreachable",
        unreachable
          .slice(0, 2)
          .map((route) => `${route.url}: ${route.error}`)
          .join(" | "),
        unreachable.map(({ url }) => url),
      );
    }
    const taggedRoutes = unique(tagged.map((action) => action.route));
    const routes = taggedRoutes.length > 0 ? taggedRoutes : feature.entryPaths;
    const stuckRoutes = routes.filter((route) =>
      input.stuckLoadingRoutes.has(route),
    );
    if (stuckRoutes.length > 0) {
      return failed(
        feature,
        "no-assert-candidates",
        "routes stayed behind a full-page loading overlay for the entire exploration",
        stuckRoutes,
      );
    }
    const contentRoutes = routes.filter((route) =>
      input.contentRoutePaths.has(route),
    );
    const vetoTable = contentRoutes
      .map((route) => input.emptyDataTablesByRoute.get(route))
      .find((table) => table !== undefined);
    if (
      (exercisedActions.length > 0 || matchingAsserts.length > 0) &&
      contentRoutes.length > 0 &&
      vetoTable !== undefined
    ) {
      return failed(
        feature,
        "skeleton-rows",
        vetoTable.skeletonRows > 0
          ? `${vetoTable.skeletonRows} textless skeleton rows mounted under ${vetoTable.columnHeaders} column headers — the data query never resolved`
          : `a zero-row data table rendered ${vetoTable.columnHeaders} column headers and no data rows`,
        contentRoutes,
      );
    }
    if (contentRoutes.length > 0) {
      const featureTokens = featureSemanticTokens(feature);
      let best:
        | { action: CatalogAction; score: number; text: string }
        | undefined;
      for (const action of input.actionCatalog.actions) {
        if (action.kind !== "assert" || !routes.includes(action.route)) {
          continue;
        }
        const text = readAssertEvidenceText(action);
        const score = semanticTokens(text).filter((token) =>
          featureTokens.includes(token),
        ).length;
        if (score > 0 && (best === undefined || score > best.score)) {
          best = { action, score, text };
        }
      }
      if (best !== undefined) {
        const winners = (best.action.featureIds ?? []).filter(
          (featureId) => featureId !== feature.id,
        );
        return failed(
          feature,
          "route-shared-with-winners",
          winners.length > 0
            ? `best on-screen match ${JSON.stringify(best.text)} (score ${best.score}) was awarded to ${winners.join(", ")}`
            : `best on-screen match ${JSON.stringify(best.text)} (score ${best.score}) was observed on a route not tagged to this feature`,
          [best.action.id],
        );
      }
      const shownContent = unique(
        contentRoutes.flatMap(
          (route) => input.distinctContentByRoute.get(route) ?? [],
        ),
      ).slice(0, 4);
      return failed(
        feature,
        "token-mismatch",
        `no harvested text shares a semantic token with the feature wording (best score 0); on-screen content: ${shownContent.join(", ")}`,
        shownContent,
      );
    }
    const errorEvidence = unique(
      routes.flatMap((route) => input.errorEvidenceByRoute.get(route) ?? []),
    ).slice(0, 6);
    if (errorEvidence.length > 0) {
      return failed(
        feature,
        "error-state-route",
        errorEvidence.join(" | "),
        routes,
      );
    }
    return failed(
      feature,
      "no-assert-candidates",
      "routes rendered only globally-repeated navigation chrome — no route-distinct headings, text, or data",
      routes,
    );
  });
}

function createExplorationValidationReport(input: {
  actionCatalog: ActionCatalog;
  appMap: AppMap;
  declaredProofResults?: ReadonlyMap<string, DeclaredProofResult>;
  distinctContentByRoute: ReadonlyMap<string, string[]>;
  emptyDataTablesByRoute?: ReadonlyMap<
    string,
    { columnHeaders: number; skeletonRows: number }
  >;
  errorEvidenceByRoute?: ReadonlyMap<string, string[]>;
  explicitAuthenticationFeatureIds: ReadonlySet<string>;
  featureInventory: PreparedDemoFeature[];
  networkAttempts: NetworkAttempt[];
  populatedTableRoutes?: ReadonlySet<string>;
  stuckLoadingRoutes?: ReadonlySet<string>;
  unreachableRoutes: UnreachableRoute[];
}): ValidationReport {
  const actionsByFeatureId = readActionsByFeatureId(input.actionCatalog);
  const contentRoutePaths = readContentRoutePaths(
    input.distinctContentByRoute,
    input.actionCatalog,
  );
  const featureVerdicts = readFeatureVerdicts({
    actionCatalog: input.actionCatalog,
    actionsByFeatureId,
    declaredProofResults: input.declaredProofResults ?? new Map(),
    authWallFeatureIds: readAuthWallFeatureIds(
      input.appMap,
      input.featureInventory,
      input.explicitAuthenticationFeatureIds,
    ),
    contentRoutePaths,
    distinctContentByRoute: input.distinctContentByRoute,
    emptyDataTablesByRoute: input.emptyDataTablesByRoute ?? new Map(),
    errorEvidenceByRoute: input.errorEvidenceByRoute ?? new Map(),
    featureInventory: input.featureInventory,
    populatedTableRoutes: input.populatedTableRoutes ?? new Set(),
    stuckLoadingRoutes: input.stuckLoadingRoutes ?? new Set(),
    unreachableRoutes: input.unreachableRoutes,
  });
  const groundingFailure = readExplorationFailure({
    actionCatalog: input.actionCatalog,
    actionsByFeatureId,
    appMap: input.appMap,
    contentRoutePaths,
    distinctContentByRoute: input.distinctContentByRoute,
    emptyDataTablesByRoute: input.emptyDataTablesByRoute ?? new Map(),
    featureInventory: input.featureInventory,
    featureVerdicts,
    stuckLoadingRoutes: input.stuckLoadingRoutes ?? new Set(),
    unreachableRoutes: input.unreachableRoutes,
  });
  // Load-breaking runtime evidence outranks grounding counts: a route that
  // crashes before rendering cannot ground anything, and only the dependency
  // repair path can fix it.
  const missingModule =
    groundingFailure === undefined
      ? undefined
      : readMissingModule(input.appMap.pageErrors);
  const failure =
    missingModule === undefined
      ? groundingFailure
      : {
          classification: "missing dependency",
          message: `App routes crash before rendering: Module not found: Can't resolve '${missingModule}'. Install or declare the missing package for the selected app; feature grounding cannot proceed until routes render.`,
        };
  const actionableConsoleErrors = input.appMap.consoleErrors.filter(
    isActionableBrowserConsoleError,
  );
  const routeScreenshots = input.appMap.discoveredRoutes.flatMap(
    (route) => route.screenshots,
  );
  return readValidationReport({
    artifactReferences: [
      "/workspace/.makeademo/app-map.json",
      "/workspace/.makeademo/action-catalog.json",
      ...input.appMap.discoveredRoutes.flatMap((route) =>
        route.snapshotPath === undefined ? [] : [route.snapshotPath],
      ),
      ...routeScreenshots,
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
    ...(failure?.failingFeatureIds === undefined ||
    failure.failingFeatureIds.length === 0
      ? {}
      : { failingFeatureIds: unique(failure.failingFeatureIds).sort() }),
    ...(featureVerdicts.length === 0 ? {} : { featureVerdicts }),
    logsSummary:
      failure?.message ??
      `Playwright explored ${input.appMap.discoveredRoutes.length} route(s) in the submitted-code sandbox.`,
    networkAttempts: input.networkAttempts,
    pageErrors: input.appMap.pageErrors,
    retryCount: 0,
    screenshots: routeScreenshots,
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
 * Per-feature diagnoses are read from the verdict ledger, so the prose
 * steering and the persisted enums can never disagree.
 */
function readExplorationFailure(input: {
  actionCatalog: ActionCatalog;
  actionsByFeatureId: ReadonlyMap<string, CatalogAction[]>;
  appMap: AppMap;
  contentRoutePaths: ReadonlySet<string>;
  distinctContentByRoute: ReadonlyMap<string, string[]>;
  emptyDataTablesByRoute: ReadonlyMap<
    string,
    { columnHeaders: number; skeletonRows: number }
  >;
  featureInventory: PreparedDemoFeature[];
  featureVerdicts: FeatureVerdict[];
  stuckLoadingRoutes: ReadonlySet<string>;
  unreachableRoutes: UnreachableRoute[];
}):
  | { classification: string; failingFeatureIds?: string[]; message: string }
  | undefined {
  const {
    actionCatalog,
    actionsByFeatureId,
    appMap,
    contentRoutePaths,
    distinctContentByRoute,
    emptyDataTablesByRoute,
    featureInventory,
    featureVerdicts,
    stuckLoadingRoutes,
    unreachableRoutes,
  } = input;
  const verdictByFeatureId = new Map(
    featureVerdicts.map((verdict) => [verdict.featureId, verdict]),
  );
  const unreachableFailure = (features: PreparedDemoFeature[]) => {
    const featureIds = new Set(features.map(({ id }) => id));
    const unreachable = unreachableRoutes.filter((route) =>
      (route.featureIds ?? []).some((featureId) => featureIds.has(featureId)),
    );
    if (unreachable.length === 0) return undefined;
    const unreachableFeatureIds = unique(
      unreachable.flatMap((route) =>
        (route.featureIds ?? []).filter((featureId) =>
          featureIds.has(featureId),
        ),
      ),
    );
    return {
      classification: "app route not discoverable",
      failingFeatureIds: unreachableFeatureIds,
      message: `Feature entry routes failed to load: ${unreachable
        .slice(0, 2)
        .map((route) => `${route.url}: ${route.error}`)
        .join(" | ")}.`,
    };
  };
  // Same-origin 404s alongside chrome-only routes are browser evidence that
  // the serving arrangement, not the data, is wrong: an SPA served at a base
  // path it does not expect resolves its own links and session endpoints to
  // 404 (directus, 2026-08-09). Steering only — dev servers also 404 benign
  // probes, so this never gates.
  const sameOrigin404Count = [
    ...appMap.pageErrors.filter((error) => /\b404\b/.test(error)),
    ...appMap.consoleErrors.filter((error) =>
      /failed resource http:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)\S* \(HTTP 404\)/.test(
        error,
      ),
    ),
  ].length;
  const wrongBaseSteering =
    sameOrigin404Count === 0
      ? ""
      : ` ${sameOrigin404Count} same-origin request(s) returned 404 during exploration — when the app's own links or session endpoints 404, the app is likely served at a base path or API base it does not expect; align the prepared serving arrangement (base path, API base URL) with how the app builds its own URLs before touching fixtures.`;
  const chromeOnlyExplanation = (tail: string) =>
    `rendered only globally-repeated navigation chrome — no route-distinct headings, text, or data${tail}${wrongBaseSteering}`;
  const emptyTableEvidence = (
    routePaths: readonly string[],
    feature?: PreparedDemoFeature,
  ) => {
    const emptyTable = routePaths
      .map((route) => emptyDataTablesByRoute.get(route))
      .find((table) => table !== undefined);
    if (emptyTable === undefined) {
      return "";
    }
    // Rows that mounted with no cell text are a loading state whose query
    // never resolved (midday, 2026-08-09) — a diagnosis the browser CAN
    // make, unlike the empty-result/zero-height ambiguity below. The
    // declared data seam turns the steering from a search into an address.
    if (emptyTable.skeletonRows > 0) {
      const seam = feature?.dataSeams?.[0];
      const seamSteering =
        seam === undefined
          ? "Return the fixture directly, in code, from the exact function the UI calls for this data — do not gate on database or transport availability."
          : `The declared data seam is ${seam.functionName} in ${seam.path}, backed by ${seam.fixtureModule} — the fixture never reaches the UI through it. Return the fixture in code from ${seam.functionName}; do not gate on database or transport availability.`;
      return ` A data table (${emptyTable.columnHeaders} column headers) mounted ${emptyTable.skeletonRows} textless skeleton rows on these routes: the data query never resolved, so the table is stuck in its loading state. ${seamSteering}`;
    }
    // Observation, not diagnosis: this gate cannot tell an empty query
    // result from a virtualized body that measured zero height (midday,
    // 2026-08-07 matrix), so it names both causes instead of asserting one.
    return ` An empty data table (${emptyTable.columnHeaders} column headers, zero data rows) rendered on these routes. Two causes produce this: the data query resolved empty (fixture shape or default filters exclude the fixture rows), or a virtualized table body measured zero height and rendered no rows despite data being present — identify which before repairing, and prefer fixture and data-path fixes over changing product components.`;
  };
  const authBarrierFeatures = featureInventory.filter(
    (feature) =>
      verdictByFeatureId.get(feature.id)?.failedBecause === "auth-wall",
  );
  if (authBarrierFeatures.length > 0) {
    const blockedFeatures = authBarrierFeatures.map(
      (feature) => feature.requestedFeature ?? feature.label,
    );
    return {
      classification: "feature auth barrier",
      failingFeatureIds: authBarrierFeatures.map(({ id }) => id),
      message: `Prepared feature routes redirected to authentication for: ${blockedFeatures.join(", ")}. Seed an authenticated demo session through the repo's demo gate so these routes render signed in, or reselect featureInventory entries onto routes outside authentication.`,
    };
  }
  // Routes that serve their document shell but yield only structural actions
  // (no asserts, clicks, or fills anywhere) mean the prepared runtime renders
  // nothing — a rendering defect, not a feature-selection problem. Unreachable
  // routes carry sharper evidence, so they keep their own classification.
  if (
    unreachableRoutes.length === 0 &&
    appMap.discoveredRoutes.length > 0 &&
    actionCatalog.actions.every(
      (action) => action.kind === "navigate" || action.kind === "scroll",
    )
  ) {
    return {
      classification: "empty/unmeaningful app state",
      message: `Explored ${appMap.discoveredRoutes.length} route(s) that served their document shell but rendered no visible content — no headings, text, links, or controls appeared within the content wait. The prepared runtime's data fixtures or demo gating are blocking rendering; repair the prepared app so its routes render their content.`,
    };
  }
  // When no route anywhere renders route-distinct content, grounding failures
  // are a data-rendering defect, not a feature-selection problem: exercised
  // controls and chrome asserts exist identically in hollow and healthy apps.
  const hollowFailure = (features: PreparedDemoFeature[]) => {
    if (contentRoutePaths.size > 0) {
      return undefined;
    }
    const affectedRoutes = [
      ...new Set(features.flatMap((feature) => feature.entryPaths)),
    ];
    return {
      classification: "empty/unmeaningful app state",
      failingFeatureIds: features.map(({ id }) => id),
      message: `Explored ${appMap.discoveredRoutes.length} route(s) but every route ${chromeOnlyExplanation(
        ` appeared within the content wait. Feature entry routes affected: ${affectedRoutes
          .slice(0, 4)
          .join(
            ", ",
          )}. The prepared runtime's data fixtures or demo gating are not rendering content; repair the prepared app's data path.${emptyTableEvidence(
          affectedRoutes,
        )}`,
      )}`,
    };
  };
  const groundedFeatureIds = new Set(
    featureVerdicts
      .filter(({ verdict }) => verdict === "grounded")
      .map(({ featureId }) => featureId),
  );
  // Features forced onto identical tagged evidence — exactly one assert and
  // one interaction each, all shared — can never both satisfy the FlowSpec
  // uniqueness rule. That is a feature-inventory defect flow planning cannot
  // repair, so it must fail here, where preparation repair can merge or
  // reselect the features.
  const forcedEvidenceKey = (featureId: string): string | undefined => {
    const tagged = actionsByFeatureId.get(featureId) ?? [];
    const asserts = unique(
      tagged.filter((action) => action.kind === "assert").map(({ id }) => id),
    );
    const interactions = unique(
      tagged.filter((action) => action.kind !== "assert").map(({ id }) => id),
    );
    return asserts.length === 1 && interactions.length === 1
      ? `${asserts[0]}|${interactions[0]}`
      : undefined;
  };
  const collisionGroups = [
    ...[...groundedFeatureIds]
      .reduce((groups, featureId) => {
        const key = forcedEvidenceKey(featureId);
        if (key !== undefined) {
          groups.set(key, [...(groups.get(key) ?? []), featureId]);
        }
        return groups;
      }, new Map<string, string[]>())
      .values(),
  ].filter((group) => group.length > 1);
  const indistinguishableMessage = (group: string[]) =>
    `Browser evidence cannot distinguish prepared features ${group.join(
      " and ",
    )}: each is forced onto the same tagged assert and interaction, so FlowSpec uniqueness is unsatisfiable. Merge these features or reselect distinct entry routes and evidence in the featureInventory.`;
  const missingRequestedFeatures = featureInventory.filter(
    (feature) =>
      feature.requestedFeature !== undefined &&
      !groundedFeatureIds.has(feature.id),
  );
  const requestedIds = new Set(
    featureInventory
      .filter((feature) => feature.requestedFeature !== undefined)
      .map(({ id }) => id),
  );
  const requestedCollision = collisionGroups.find(
    (group) => group.filter((id) => requestedIds.has(id)).length > 1,
  );
  if (requestedCollision !== undefined) {
    return {
      classification: "requested feature not observable",
      failingFeatureIds: requestedCollision,
      message: indistinguishableMessage(requestedCollision),
    };
  }
  // One sentence per ungrounded feature, keyed off its ledger enum: naming
  // what the feature's routes actually showed turns "no evidence" into
  // actionable steering, and deriving the branch from the persisted enum
  // guarantees the prose can never contradict the ledger.
  const describeUngroundedFeature = (
    feature: PreparedDemoFeature,
  ): { sentence: string; verdict: FeatureVerdict | undefined } => {
    const verdict = verdictByFeatureId.get(feature.id);
    const tagged = actionsByFeatureId.get(feature.id) ?? [];
    const taggedRoutes = unique(tagged.map((action) => action.route));
    const routes = taggedRoutes.length > 0 ? taggedRoutes : feature.entryPaths;
    const featureName =
      feature.requestedFeature === undefined
        ? `Prepared feature "${feature.label}"`
        : `Requested feature "${feature.requestedFeature}"`;
    if (
      routes.length === 0 ||
      verdict === undefined ||
      verdict.verdict === "grounded"
    ) {
      return { sentence: "", verdict };
    }
    const routeList = routes.slice(0, 4).join(", ");
    if (verdict.failedBecause === "no-assert-candidates") {
      const stuckRoutes = routes.filter((route) =>
        stuckLoadingRoutes.has(route),
      );
      // A route that never left its loading overlay cannot evidence
      // anything: text behind the overlay is not exercisable, so wording
      // and fixture steering would send every repair round the wrong way
      // (cyberchef burned five on wording alignment, 2026-08-08).
      if (stuckRoutes.length > 0) {
        return {
          sentence: ` ${featureName} is tagged to routes ${stuckRoutes
            .slice(0, 4)
            .join(
              ", ",
            )}, which stayed behind a full-page loading overlay for the entire exploration — the app never finished initializing in the demo runtime, so no interaction or assert could be exercised. Repair the prepared app's startup path (look for silently pending requests, workers that never come up, or gated initialization that never completes); featureInventory wording cannot help.`,
          verdict,
        };
      }
    }
    // A failed declared proof already names the exact observed gap; the
    // repair either fixes the app state so the declared outcome is real or
    // corrects the declaration — wording alignment is never the answer.
    if (verdict.failedBecause === "declared-proof-failed") {
      return {
        sentence: ` ${featureName} failed its declared proof on routes ${routeList}: ${verdict.detail ?? "the declared outcome was not observed"}. Fix the prepared app state so the declared outcome really happens, or correct the expectedProof declaration to what the feature actually shows.`,
        verdict,
      };
    }
    const contentRoutes = routes.filter((route) =>
      contentRoutePaths.has(route),
    );
    const shownContent = unique(
      contentRoutes.flatMap((route) => distinctContentByRoute.get(route) ?? []),
    ).slice(0, 4);
    // Matching evidence on a content-bearing route means the only blocker
    // was the zero-row veto: steer the repair at the fixture shape, not at
    // wording or the whole data path.
    if (verdict.failedBecause === "skeleton-rows") {
      return {
        sentence: ` ${featureName} is tagged to routes ${routeList}, which rendered distinct content (${shownContent.join(", ")}) but a zero-row data table as the feature's data surface — an empty table cannot demonstrate the feature.${emptyTableEvidence(
          contentRoutes,
          feature,
        )}`,
        verdict,
      };
    }
    // The route rendered matching text, but evidence scoring awarded every
    // matching assert elsewhere: wording alignment cannot fix a zero-sum
    // split — only an unclaimed entry route or a feature merge can.
    if (verdict.failedBecause === "route-shared-with-winners") {
      return {
        sentence: ` ${featureName} is tagged to routes ${routeList}, whose ${verdict.detail ?? "best-matching on-screen text was awarded to another feature sharing the route"} — give this feature an entry route no other feature claims, or merge it with the winning feature in the featureInventory.`,
        verdict,
      };
    }
    // A content-bearing route means rendering is fine and the lexical
    // evidence match failed: without naming what the route showed, the
    // repair agent is steered at the data path it cannot improve.
    if (verdict.failedBecause === "token-mismatch") {
      return {
        sentence: ` ${featureName} is tagged to routes ${routeList}, which rendered distinct content (${shownContent.join(", ")}) — but no exercised interaction or visible-text assert matched the feature's wording; align the featureInventory wording with the on-screen labels or point entryPaths at the feature's own UI.`,
        verdict,
      };
    }
    // Error-state evidence names the actual breakage (toast text, the
    // uncaught exception, the not-found verdict); with it, the repair
    // agent fixes the contract instead of guessing at wording.
    return {
      sentence: ` ${featureName} routes ${routeList} ${chromeOnlyExplanation(
        `; repair the prepared app's data path for these routes.${emptyTableEvidence(
          routes,
          feature,
        )}`,
      )}${
        verdict.failedBecause === "error-state-route" &&
        verdict.detail !== undefined
          ? ` Error-state evidence on these routes: ${verdict.detail}. The runtime is broken on these routes; featureInventory wording cannot help.`
          : ""
      }`,
      verdict,
    };
  };
  if (missingRequestedFeatures.length > 0) {
    const unreachable = unreachableFailure(missingRequestedFeatures);
    if (unreachable !== undefined) {
      return unreachable;
    }
    const featureEvidence = missingRequestedFeatures.map(
      describeUngroundedFeature,
    );
    const routeEvidence = featureEvidence
      .map(({ sentence }) => sentence)
      .join("");
    const requestedFeatureNames = missingRequestedFeatures
      .map((feature) => feature.requestedFeature as string)
      .join(", ");
    const missingRequestedIds = missingRequestedFeatures.map(({ id }) => id);
    return (
      hollowFailure(missingRequestedFeatures) ??
      (featureEvidence.every(
        ({ verdict }) => verdict?.failedBecause === "skeleton-rows",
      )
        ? {
            classification: "empty/unmeaningful app state",
            failingFeatureIds: missingRequestedIds,
            message: `Every requested feature's data surface rendered as a zero-row table: ${requestedFeatureNames}.${routeEvidence}`,
          }
        : featureEvidence.every(
              ({ verdict }) => verdict?.failedBecause === "error-state-route",
            )
          ? {
              // Every missing feature failed on an error-state route: the
              // app is broken, not mis-worded — steer at the runtime/data
              // contract with the error evidence.
              classification: "empty/unmeaningful app state",
              failingFeatureIds: missingRequestedIds,
              message: `Every requested feature's routes rendered error states instead of content: ${requestedFeatureNames}.${routeEvidence}`,
            }
          : {
              classification: "requested feature not observable",
              failingFeatureIds: missingRequestedIds,
              message: `App Exploration found no browser evidence for requested features: ${requestedFeatureNames}.${routeEvidence}`,
            })
    );
  }
  // Exploration grounds a feature on exercised evidence alone, but flow
  // planning demands a tagged interaction AND a tagged visible assertion per
  // selected feature. A grounded feature missing either kind makes flow
  // planning structurally unsatisfiable from its first attempt, so the gap
  // must fail here, where preparation repair can render assertable content
  // or reselect the feature. With maker-requested features, every requested
  // feature is forced into the plan; without them, planning must select
  // min(3, |inventory|), so that many features must carry complete evidence
  // (conduit's agent-selected comment feature had zero tagged asserts,
  // 2026-08-07).
  const requestedFeaturesExist = featureInventory.some(
    (feature) => feature.requestedFeature !== undefined,
  );
  const flowEvidenceGapEntries = featureInventory
    .map((feature) => {
      if (
        !groundedFeatureIds.has(feature.id) ||
        (requestedFeaturesExist && feature.requestedFeature === undefined)
      ) {
        return undefined;
      }
      const tagged = actionsByFeatureId.get(feature.id) ?? [];
      const missing = [
        ...(tagged.some((action) => action.kind !== "assert")
          ? []
          : ["an interaction"]),
        ...(tagged.some((action) => action.kind === "assert")
          ? []
          : ["a visible-text assert"]),
      ];
      if (missing.length === 0) {
        return undefined;
      }
      // Content-bearing tagged routes mean the gap is a wording mismatch,
      // not a rendering defect: naming the shown labels steers the repair
      // at featureInventory wording instead of at a healthy data path.
      const shownLabels = unique(
        unique(tagged.map((action) => action.route))
          .filter((route) => contentRoutePaths.has(route))
          .flatMap((route) => distinctContentByRoute.get(route) ?? []),
      ).slice(0, 4);
      return {
        featureId: feature.id,
        gap: `"${feature.requestedFeature ?? feature.label}" lacks ${missing.join(" and ")}${
          shownLabels.length === 0
            ? ""
            : ` (its routes rendered distinct content: ${shownLabels.join(
                ", ",
              )} — align the featureInventory wording with these on-screen labels)`
        }`,
      };
    })
    .filter((entry) => entry !== undefined);
  const flowEvidenceGaps = flowEvidenceGapEntries.map(({ gap }) => gap);
  if (requestedFeaturesExist && flowEvidenceGaps.length > 0) {
    return {
      classification: "requested feature not observable",
      failingFeatureIds: flowEvidenceGapEntries.map(
        ({ featureId }) => featureId,
      ),
      message: `Flow planning must pair a tagged interaction with a tagged visible-text assert for every requested feature, but the ActionCatalog cannot satisfy that: ${flowEvidenceGaps.join(
        "; ",
      )}. Prepare these features' routes to render visible text that names the feature's data or UI, or reselect featureInventory entries onto routes that already do.`,
    };
  }
  if (!requestedFeaturesExist) {
    // Grounding shortfalls fall through to the richer unreachable/hollow
    // handling below; this rung fires only when enough features ground but
    // too few of them are plannable.
    const groundedCount = featureInventory.filter((feature) =>
      groundedFeatureIds.has(feature.id),
    ).length;
    const plannableCount = groundedCount - flowEvidenceGaps.length;
    const requiredCount = Math.min(3, featureInventory.length);
    if (groundedCount >= requiredCount && plannableCount < requiredCount) {
      return {
        classification: "prepared feature not observable",
        failingFeatureIds: flowEvidenceGapEntries.map(
          ({ featureId }) => featureId,
        ),
        message: `Flow planning must select ${requiredCount} prepared feature(s), pairing each with a tagged interaction and a tagged visible-text assert, but only ${plannableCount} qualify: ${flowEvidenceGaps.join(
          "; ",
        )}. Prepare these features' routes to render visible text that names the feature's data or UI, or reselect featureInventory entries onto routes that already do.`,
      };
    }
  }
  if (
    !featureInventory.some((feature) => feature.requestedFeature !== undefined)
  ) {
    const ungroundedFeatures = featureInventory.filter(
      (feature) => !groundedFeatureIds.has(feature.id),
    );
    const indistinguishableExtras = collisionGroups.reduce(
      (count, group) => count + group.length - 1,
      0,
    );
    const observedPreparedFeatureCount =
      featureInventory.length -
      ungroundedFeatures.length -
      indistinguishableExtras;
    const requiredPreparedFeatureCount = Math.min(3, featureInventory.length);
    if (observedPreparedFeatureCount < requiredPreparedFeatureCount) {
      if (
        collisionGroups.length > 0 &&
        featureInventory.length - ungroundedFeatures.length >=
          requiredPreparedFeatureCount
      ) {
        return {
          classification: "prepared feature not observable",
          failingFeatureIds: collisionGroups[0] ?? [],
          message: indistinguishableMessage(collisionGroups[0] ?? []),
        };
      }
      const unreachable = unreachableFailure(ungroundedFeatures);
      if (unreachable !== undefined) {
        return unreachable;
      }
      // Wording-alignment and route-claim steering extend to default-demo
      // features (N106): a generic "reselect" hint alone leaves the repair
      // agent guessing which feature's wording missed. Other enums keep the
      // reselect steering — their sentences would point at data-path repairs
      // that reselection is meant to avoid.
      const steerableSentences = ungroundedFeatures
        .filter((feature) => {
          const failedBecause = verdictByFeatureId.get(
            feature.id,
          )?.failedBecause;
          return (
            failedBecause === "token-mismatch" ||
            failedBecause === "route-shared-with-winners"
          );
        })
        .slice(0, 4)
        .map((feature) => describeUngroundedFeature(feature).sentence)
        .join("");
      return (
        hollowFailure(ungroundedFeatures) ?? {
          classification: "prepared feature not observable",
          failingFeatureIds: ungroundedFeatures.map(({ id }) => id),
          message: `App Exploration observed ${observedPreparedFeatureCount} prepared features but needs ${requiredPreparedFeatureCount} to plan the default demo.${formatGroundedRoutes(actionCatalog, contentRoutePaths)}${steerableSentences}`,
        }
      );
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

/** The visible text an assert proves: locator value for text asserts, accessible name otherwise. */
function readAssertEvidenceText(action: CatalogAction): string {
  const locator = action.preferredLocator;
  return (locator.strategy === "text" ? locator.value : locator.name) ?? "";
}

function assertEvidenceMatchesFeature(
  action: CatalogAction,
  feature: PreparedDemoFeature,
): boolean {
  const featureTokens = featureSemanticTokens(feature);
  return semanticTokens(readAssertEvidenceText(action)).some((token) =>
    featureTokens.includes(token),
  );
}

/**
 * Lists routes whose catalog carries exercised or assert evidence and whose
 * page renders route-distinct content — the routes a preparation repair can
 * reselect features onto with confidence. A chrome-only route with evidence
 * is not a reselection target: its asserts prove nothing renders there.
 * The steering deliberately offers only reselection: rewriting product UI to
 * make features observable is a fidelity violation.
 */
function formatGroundedRoutes(
  actionCatalog: ActionCatalog,
  contentRoutePaths: ReadonlySet<string>,
): string {
  const routes = [
    ...new Set(
      actionCatalog.actions
        .filter(
          (action) =>
            (action.exercised === true || action.kind === "assert") &&
            contentRoutePaths.has(action.route),
        )
        .map((action) => action.route),
    ),
  ];
  if (routes.length === 0) return "";
  return ` Browser evidence was grounded on: ${routes.slice(0, 6).join(", ")}. Reselect featureInventory entries onto these routes (update entryPaths and sourcePaths).`;
}

function readMissingModule(pageErrors: string[]): string | undefined {
  for (const error of pageErrors) {
    const match =
      /(?:module not found|can't resolve|cannot find module)[^'"`]*['"`]([^'"`\s]+)['"`]/i.exec(
        error,
      );
    if (match?.[1] !== undefined) return match[1];
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
  // A password + identity pair is a login form regardless of copy; an
  // auth-looking path alone is not — marketing pages reuse those slugs, so
  // the path must be corroborated by a credential input or provider button.
  return (
    (hasPassword && hasIdentity) ||
    (hasAuthPath &&
      (hasPassword || hasIdentity || hasIdentityProviderAction)) ||
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
    const result = await workspace.executeSubmittedCode(
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
  return explorationFailure({
    baseUrl: input.baseUrl,
    classification: appExited ? "app route crashes" : "runtime crash",
    diagnostics,
    hints: [
      appExited
        ? "Repair the app crash or reduce its runtime resource usage, then rerun browser exploration."
        : "Repair the prepared app runtime so the browser explorer can load it, then rerun browser exploration.",
    ],
    summary: `Browser exploration exited with code ${input.result.exitCode} without emitting its result protocol${excerpt ? `: ${excerpt}` : "."}`,
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function createExplorerScript(
  baseUrl: string,
  featureInventory: PreparedDemoFeature[],
  externalResourceManifest?: ExternalResourceManifest,
  scope: "feature-entries" | "full" = "full",
): string {
  const featureEntryTargets = createFeatureEntryTargets(
    baseUrl,
    featureInventory,
  );
  return `
import { chromium } from "@playwright/test";
import { createHash as makeADemoCreateHash } from "node:crypto";
import { mkdir, readFile as makeADemoReadReplayFile, writeFile } from "node:fs/promises";

const baseUrl = ${JSON.stringify(baseUrl)};
const baseOrigin = new URL(baseUrl).origin;
const crawlScope = ${JSON.stringify(scope)};
const featureEntryTargets = ${JSON.stringify(featureEntryTargets)};
const declaredProofTargets = ${JSON.stringify(createDeclaredProofTargets(baseUrl, featureInventory))};
const outputDirectory = ${JSON.stringify(explorerDirectory)};
const deadlineAtMs = Date.now() + ${Math.floor(explorationCommandTimeoutMs * 0.7)};
const result = { blockedNetworkAttempts: [], consoleErrors: [], declaredProofs: [], pageErrors: [], routes: [], unreachableRoutes: [] };
const isAppUnavailableError = (error) => /(?:ERR_CONNECTION_(?:CLOSED|REFUSED|RESET)|Target page, context or browser has been closed)/i.test(
  error instanceof Error ? error.message : String(error),
);
const normalizeCrawlUrl = ${normalizeCrawlUrl.toString()};
const semanticTokens = ${semanticTokens.toString()};
const featureControlTokenGroups = ${JSON.stringify(
    featureInventory.map((feature) => featureSemanticTokens(feature)),
  )};
// Within the 16-control budget, controls whose accessible names share a
// semantic token with any prepared feature outrank purely positional picks:
// on control-dense tools the page's 17th button is often the feature's own,
// and it must reach both the catalog and the click loop's exercise window.
const prioritizeFeatureControls = (buttons) => {
  const matchesFeature = (name) => {
    const tokens = semanticTokens(name);
    return featureControlTokenGroups.some((group) => tokens.some((token) => group.includes(token)));
  };
  return [...buttons.filter(matchesFeature), ...buttons.filter((name) => !matchesFeature(name))].slice(0, 16);
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block", timezoneId: "UTC", viewport: { width: 1440, height: 900 } });
  ${createBrowserRuntimeNetworkPolicySource({
    ...(externalResourceManifest === undefined
      ? {}
      : { manifest: externalResourceManifest }),
    mode: "exploration",
  })}
  const page = await context.newPage();
  const waitForQuietDom = async (settleMs, maxMs) => {
    try {
      await page.evaluate(([settle, max]) => new Promise((resolve) => {
        let timer;
        let observer;
        const finish = () => { if (observer) observer.disconnect(); resolve(undefined); };
        observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, settle); });
        observer.observe(document.documentElement, { attributes: true, characterData: true, childList: true, subtree: true });
        timer = setTimeout(finish, settle);
        setTimeout(finish, max);
      }), [settleMs, maxMs]);
    } catch {}
  };
  const hasCoveringLoadingOverlay = () => {
    const viewportArea = window.innerWidth * window.innerHeight;
    if (viewportArea === 0) return false;
    const candidates = document.querySelectorAll("[class*='load' i], [id*='load' i], [class*='spinner' i], [id*='spinner' i], [class*='splash' i], [role='progressbar'], [aria-busy='true']");
    return Array.from(candidates).some((element) => {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const box = element.getBoundingClientRect();
      return (box.width * box.height) / viewportArea >= 0.6;
    });
  };
  const readAriaRootName = (snapshot) => {
    const firstLine = snapshot.split("\\n", 1)[0] || "";
    const match = /^-\\s+[a-zA-Z]+(?:\\s+("(?:[^"\\\\]|\\\\.)*"))?/.exec(firstLine);
    if (!match || !match[1]) return "";
    try { return JSON.parse(match[1]); } catch { return ""; }
  };
  const createVerifiedRoleLocatorEvidence = async ({ candidateNames, role, route, targetHref }) => {
    const queries = candidateNames.filter(Boolean).flatMap((name) => [{ exact: true, name }, { exact: false, name }]);
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
      alerts: read("[role=alert], [role=status], [role=alertdialog], [aria-live]:not([aria-live=off])"),
      // Control names and disabled states are behavioral evidence (N105): a
      // toggle that renames itself or a Save that enables Undo produces no
      // heading, text, or URL delta, yet is the interaction's whole proof.
      controls: Array.from(document.querySelectorAll("button, [role=button]")).filter(visible).slice(0, 40).map((element) => ({
        disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
        name: clean(element.innerText || element.getAttribute("aria-label")),
      })).filter((control) => control.name),
      dialogs: read("[role=dialog], dialog[open]"),
      headings: read("h1, h2, h3, [role=heading]"),
      rowCount: Array.from(document.querySelectorAll("table tbody tr, [role=row]")).filter(visible).length,
      text: read("main p, main li, article p, [role=main] p, [role=status], [role=alert]"),
      title: document.title,
      url: location.href,
    };
  });
  // The strongest wording-free delta between two visible states: a control
  // leaving its disabled state, or one control name replacing another (a
  // self-renaming toggle). Independent of describeVisibleOutcome so the
  // transition is recorded even when a text delta names the outcome.
  const readStateTransition = (before, after) => {
    const enabledControl = after.controls.find((control) => !control.disabled &&
      before.controls.some((entry) => entry.name === control.name && entry.disabled));
    if (enabledControl) return { control: enabledControl.name, from: "disabled", to: "enabled" };
    const beforeNames = new Set(before.controls.map((control) => control.name));
    const afterNames = new Set(after.controls.map((control) => control.name));
    const appeared = after.controls.find((control) => !beforeNames.has(control.name));
    const vanished = before.controls.find((control) => !afterNames.has(control.name));
    if (appeared && vanished) return { control: vanished.name, from: vanished.name, to: appeared.name };
    return undefined;
  };
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
    const transition = readStateTransition(before, after);
    if (transition) {
      return transition.from === "disabled"
        ? transition.control + " [disabled] → [enabled]"
        : transition.from + " became " + transition.to;
    }
    if (after.rowCount !== before.rowCount) {
      return "visible data rows changed from " + before.rowCount + " to " + after.rowCount;
    }
    return undefined;
  };
  // Text that appears only after an interaction is that interaction's proof:
  // tool-shaped UIs render results, not pages, so the static harvest can
  // never catalog an assert for them. Each candidate is verified in the
  // revealed state — exactly the state the demo script asserts in after
  // replaying the interaction. Alert/status copy stays quarantined.
  const harvestRevealedTexts = async (before, after, route) => {
    if (after.url !== before.url) return [];
    const alreadyVisible = new Set([...before.headings, ...before.dialogs, ...before.text]);
    const candidates = [...new Set([...after.headings, ...after.dialogs, ...after.text])]
      .filter((value) => value.length >= 3 && !alreadyVisible.has(value) && !after.alerts.includes(value))
      .slice(0, 4);
    const revealed = [];
    for (const value of candidates) {
      const locatorEvidence = await createVerifiedDirectLocatorEvidence({
        locator: { exact: true, strategy: "text", value },
        route,
      });
      if (locatorEvidence) revealed.push({ locatorEvidence, value });
    }
    return revealed;
  };
  const pushBounded = (list, value) => {
    if (list.length < 50) list.push(value);
  };
  // One entry per error class: repeated dev-server noise (HMR websocket
  // retries whose only difference is a ?id= token) can otherwise fill the
  // whole bounded evidence channel. Query strings and long hex runs are the
  // volatile parts; everything else distinguishes real error classes.
  const seenConsoleErrorClasses = new Set();
  const consoleErrorClass = (text) =>
    text.replace(/\\?[^\\s'"()]*/g, "").replace(/[0-9a-f]{8,}/gi, "#");
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const errorClass = consoleErrorClass(message.text());
    if (seenConsoleErrorClasses.has(errorClass)) return;
    seenConsoleErrorClasses.add(errorClass);
    pushBounded(result.consoleErrors, page.url() + ": " + message.text());
  });
  page.on("pageerror", (error) => pushBounded(result.pageErrors, page.url() + ": " + error.message));
  // Chrome's "Failed to load resource" console message omits the resource
  // URL, so record request-level failures with the path the repair agent
  // actually needs. Guard blocks are already blockedNetworkAttempts and
  // ERR_ABORTED is routine dev-server churn.
  const seenFailedResources = new Set();
  const recordFailedResource = (url, detail) => {
    if (url.startsWith("data:") || seenFailedResources.has(url)) return;
    seenFailedResources.add(url);
    pushBounded(result.consoleErrors, page.url() + ": failed resource " + url + " (" + detail + ")");
  };
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "request failed";
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(failure)) return;
    recordFailedResource(request.url(), failure);
  });
  let staleModule504 = false;
  // Status of the last main-document response. Hash navigations return no
  // response and keep the prior value: every hash route rides that document.
  let lastDocumentStatus;
  page.on("response", (response) => {
    if (response.status() >= 400) recordFailedResource(response.url(), "HTTP " + response.status());
    if (response.status() === 504 && response.request().resourceType() === "script") staleModule504 = true;
  });
  const remainingMs = () => Math.max(0, deadlineAtMs - Date.now());
  const gotoRouteOnce = async (url) => {
    // Dev servers compile each route on first hit; give the initial load a
    // cold-start budget and absorb one transient failure (mid-recompile
    // reloads surface as ERR_ABORTED) before treating the route as broken.
    // Every long wait is clamped to the remaining deadline so in-flight
    // work always finalizes inside the exploration command budget.
    const gotoTimeoutMs = () => Math.min(60000, Math.max(1000, remainingMs()));
    let response;
    try {
      response = await page.goto(url, { timeout: gotoTimeoutMs(), waitUntil: "domcontentloaded" });
    } catch (error) {
      if (isAppUnavailableError(error) || remainingMs() < 1000) throw error;
      response = await page.goto(url, { timeout: gotoTimeoutMs(), waitUntil: "domcontentloaded" });
    }
    if (response) lastDocumentStatus = response.status();
    await page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 10000 }).catch(() => {});
    if (remainingMs() > 0) {
      // Dev servers compile and stream first-hit routes behind a DOM-quiet
      // skeleton; observing that shell yields empty evidence. Wait for the
      // first meaningful content — a no-op on pages that render immediately.
      await page.waitForFunction(() => {
        const hasBox = (element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const semantic = document.querySelectorAll("a[href], button, [role=button], input, textarea, select, h1, h2, h3, [role=heading], table, [role=grid]");
        if (Array.from(semantic).some(hasBox)) return true;
        return ((document.body && document.body.innerText) || "").trim().length >= 40;
      }, undefined, { timeout: Math.min(15000, Math.max(1, remainingMs())) }).catch(() => {});
    }
    // Data that lands just after first paint (slow query, lazy chunk) would
    // otherwise be harvested mid-fetch. Polling apps never go idle, so the
    // window is capped and a timeout is not an error.
    await page.waitForLoadState("networkidle", { timeout: Math.min(3000, Math.max(1, remainingMs())) }).catch(() => {});
    await waitForQuietDom(300, 2500);
    // A full-viewport loading indicator means the page is not ready no
    // matter how quiet the DOM is (cyberchef, 2026-08-08): wait it out
    // within a bounded budget; the verdict is recorded at harvest time.
    const overlayDeadlineAtMs = Date.now() + Math.min(15000, Math.max(1, remainingMs()));
    while (await page.evaluate(hasCoveringLoadingOverlay).catch(() => false)) {
      if (Date.now() >= overlayDeadlineAtMs) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  const gotoRoute = async (url) => {
    staleModule504 = false;
    await gotoRouteOnce(url);
    // A dev server answering a module fetch with HTTP 504 is re-optimizing
    // its dependency bundle (Vite reports "Outdated Optimize Dep"); the page
    // rendered its shell without that module, so one reload fetches the
    // fresh bundle and the harvest sees the real route.
    if (staleModule504 && remainingMs() > 1000) {
      staleModule504 = false;
      await gotoRouteOnce(url);
    }
  };
  const harvestPage = () => {
        const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
        };
        // Toast/banner copy is failure narration, not product content: it is
        // harvested into its own field and quarantined from every content
        // and control harvest (outline grounded features on its own error
        // toasts, 2026-08-08).
        const alertContainerSelector = "[role=alert], [role=status], [role=alertdialog], [aria-live]:not([aria-live=off])";
        const inAlert = (element) => element.closest(alertContainerSelector) !== null;
        const texts = (selector, limit = 40) => Array.from(document.querySelectorAll(selector)).filter(visible).filter((element) => !inAlert(element)).map((element) => clean(element.innerText || element.getAttribute("aria-label"))).filter(Boolean).slice(0, limit);
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
            : [{
                controlKind: tag === "select" ? "select" : "fill",
                inAuthForm: element.closest("form")?.querySelector("input[type=password]") != null,
                inputType: clean(element.getAttribute("type")).toLowerCase(),
                locator,
                name,
              }];
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
        const dataTables = Array.from(document.querySelectorAll("table, [role=table], [role=grid]")).filter(visible).map((table) => {
          const headerCells = Array.from(table.querySelectorAll("th, [role=columnheader]")).filter(visible);
          const bodyRows = headerCells.length === 0 ? [] : Array.from(table.querySelectorAll("tbody tr, [role=row]")).filter((row) =>
            row.querySelector("th, [role=columnheader]") == null);
          const populatedRows = bodyRows.filter((row) => clean(row.innerText) !== "");
          // Rows that mounted with no text are loading skeletons: a query
          // stuck pending, not an empty result (midday, 2026-08-09).
          return { headerCells, populatedRows, skeletonRows: bodyRows.length - populatedRows.length };
        }).filter(({ headerCells }) => headerCells.length > 0);
        const emptyDataTables = dataTables.filter(({ populatedRows }) => populatedRows.length === 0)
          .map(({ headerCells, skeletonRows }) => ({ columnHeaders: headerCells.length, headerTexts: headerCells.map((cell) => clean(cell.innerText)).filter(Boolean).slice(0, 24), ...(skeletonRows > 0 ? { skeletonRows } : {}) }))
          .slice(0, 4);
        const populatedTables = dataTables.filter(({ populatedRows }) => populatedRows.length > 0);
        // Table rows are the canonical data surface of an admin or ledger
        // page, but cell text sits outside every paragraph/list selector, so
        // the first rows are harvested into route text directly. The leading
        // non-empty cell usually names the row's entity, which makes it both
        // honest content evidence and a verifiable assert target.
        const dataTableRowTexts = [...new Set(populatedTables.flatMap(({ populatedRows }) => populatedRows.slice(0, 3).map((row) => {
          const cellTexts = Array.from(row.querySelectorAll("td, [role=cell], [role=gridcell]")).filter(visible).map((cell) => clean(cell.innerText)).filter(Boolean);
          return cellTexts[0] || clean(row.innerText);
        })))].filter((value) => value.length >= 2 && value.length <= 80).slice(0, 9);
        const paragraphTexts = Array.from(document.querySelectorAll("main p, main li, article p, [role=main] p")).filter(visible).filter((element) => !inAlert(element)).map((element) => clean(element.innerText)).filter(Boolean).slice(0, 80);
        return {
          alerts: Array.from(document.querySelectorAll(alertContainerSelector)).filter(visible).map((element) => clean(element.innerText)).filter(Boolean).slice(0, 12),
          buttons: texts("button, [role=button]", 48),
          emptyDataTables,
          forms: Array.from(document.querySelectorAll("form")).filter(visible).map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.id || "form")).slice(0, 20),
          headings: texts("h1, h2, h3, [role=heading]"),
          inputLocators,
          inputs,
          links,
          populatedDataTables: populatedTables.length,
          primaryNavigation: texts("nav a, [role=navigation] a"),
          scrollTargets,
          text: [...paragraphTexts, ...dataTableRowTexts.filter((value) => !paragraphTexts.includes(value))],
          title: document.title || clean(document.querySelector("h1")?.textContent) || location.pathname,
        };
  };
  const queue = [
    ...featureEntryTargets,
    { featureIds: [], requestedPath: new URL(baseUrl).pathname, url: new URL(baseUrl).toString() },
  ];
  const seen = new Set();
  const harvestedOnEarlierRoutes = new Set();
  const maxRoutes = crawlScope === "feature-entries"
    ? featureEntryTargets.length + 1
    : Math.min(30, featureEntryTargets.length + 9);
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
      const observed = await page.evaluate(harvestPage);
      observed.buttons = prioritizeFeatureControls(observed.buttons);
      if (lastDocumentStatus !== undefined && lastDocumentStatus >= 400) {
        observed.documentStatus = lastDocumentStatus;
      }
      // A page whose selector harvest saw nothing may still be painting a
      // bare error body; a bounded innerText sample lets the backend read
      // the exception text that no heading or paragraph selector reaches.
      if (observed.headings.length === 0 && observed.text.length === 0) {
        const bodySample = await page.evaluate(() => ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 400)).catch(() => "");
        if (bodySample) observed.textSample = bodySample;
      }
      observed.loadingOverlay = await page.evaluate(hasCoveringLoadingOverlay).catch(() => false);
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
      // The accessibility tree is the canonical assert-candidate source: its
      // accessible names are exactly the name-space Playwright locators
      // resolve, and it reaches content the paragraph/list selectors never
      // will — bare-div metrics, unlabeled pane titles, open shadow roots.
      // It runs on every route; strings repeated from previously-visited
      // routes are site chrome (icon ligatures, skip links, rail labels)
      // and stay out so chrome cannot crowd the candidate budget. Each
      // candidate is verified as a unique visible text locator below.
      try {
        const aria = typeof page.locator("body").ariaSnapshot === "function" ? await page.locator("body").ariaSnapshot() : "";
        // A zero-row table's column headers reach the aria tree as header
        // cells and as the combined header-row name; both are table
        // structure, not rendered data, and must not enter route text.
        const emptyTableHeaderTokens = new Set((observed.emptyDataTables ?? []).flatMap((table) => (table.headerTexts ?? []).flatMap((text) => text.toLowerCase().split(/\\s+/).filter(Boolean))));
        const isEmptyTableStructure = (candidate) =>
          emptyTableHeaderTokens.size > 0 && candidate.toLowerCase().split(/\\s+/).filter(Boolean).every((token) => emptyTableHeaderTokens.has(token));
        // The aria tree pierces open shadow roots (error overlays,
        // web-component apps), and their content often arrives as one long
        // text run — accept it and truncate instead of dropping it.
        const cleanAriaText = (raw) => {
          const trimmed = raw.trim();
          const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
            ? trimmed.slice(1, -1).replaceAll('\\\\"', '"')
            : trimmed;
          return unquoted.slice(0, 120).trim();
        };
        const ariaTextCandidates = [...new Set([
          ...[...aria.matchAll(/-\\s+[a-z]+ "([^"\\n]{3,80})"/g)].map((match) => match[1]),
          ...[...aria.matchAll(/-\\s+text: (\\S[^\\n]{2,399})$/gm)].map((match) => cleanAriaText(match[1])),
        ])].filter((candidate) => !observed.text.includes(candidate) && !observed.headings.includes(candidate) && !harvestedOnEarlierRoutes.has(candidate) && !isEmptyTableStructure(candidate) && !(observed.alerts || []).some((alert) => alert.includes(candidate))).slice(0, 24);
        observed.text.push(...ariaTextCandidates);
      } catch {}
      for (const value of [...observed.headings, ...observed.text]) {
        if (value) harvestedOnEarlierRoutes.add(value);
      }
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
      // Exercising a route that is still behind its loading overlay yields
      // junk evidence: clicks are intercepted by the overlay and every
      // re-navigation re-pays the overlay wait. The stuck verdict itself is
      // the route's evidence.
      for (let index = 0; observed.loadingOverlay !== true && index < Math.min(observed.buttons.length, 8); index += 1) {
        if (Date.now() >= deadlineAtMs) break;
        const name = observed.buttons[index];
        const locatorEvidence = observed.buttonLocatorEvidence[index];
        if (!name || !locatorEvidence || /\\b(?:buy|checkout|delete|destroy|disconnect|log ?in|log ?out|pay|purchase|register|remove|revoke|sign ?in|sign ?out|sign ?up)\\b/i.test(name)) continue;
        try {
          await gotoRoute(routeUrl);
          const exactLocator = page.getByRole("button", { name, exact: true });
          const interactionLocator = await exactLocator.count() === 1 ? exactLocator : page.getByRole("button", { name, exact: false });
          // A disabled control cannot be exercised: clicking it burns the
          // full click timeout to observe nothing. Its name stays harvested
          // as evidence; another control's click may enable it (N105).
          if (await interactionLocator.count() !== 1 || !(await interactionLocator.isVisible()) || !(await interactionLocator.isEnabled().catch(() => false))) continue;
          const before = await readVisibleState();
          await interactionLocator.click({ timeout: 4000 });
          await waitForQuietDom(250, 1500);
          const after = await readVisibleState();
          const outcome = describeVisibleOutcome(before, after);
          if (!outcome) continue;
          const stateTransition = readStateTransition(before, after);
          if (after.url !== before.url) {
            const landed = new URL(after.url);
            if (crawlScope === "full" && landed.origin === baseOrigin && !seen.has(normalizeCrawlUrl(landed.href))) {
              queue.push({
                featureIds: [],
                requestedPath: landed.pathname + landed.search + landed.hash,
                url: landed.href,
              });
            }
          }
          const revealedTexts = await harvestRevealedTexts(before, after, path);
          observed.interactions.push({
            kind: "click",
            locator: { name, strategy: "role", value: "button" },
            locatorEvidence,
            name,
            outcome,
            ...(stateTransition ? { stateTransition } : {}),
            ...(revealedTexts.length > 0 ? { revealedTexts } : {}),
          });
        } catch (error) {
          if (isAppUnavailableError(error)) throw error;
        }
      }
      for (const input of observed.loadingOverlay === true ? [] : observed.inputLocators.slice(0, 6)) {
        if (Date.now() >= deadlineAtMs) break;
        if (!input.locatorEvidence || ["button", "checkbox", "file", "hidden", "password", "radio", "submit"].includes(input.inputType) || input.inAuthForm) continue;
        try {
          await gotoRoute(routeUrl);
          const interactionLocator = createInteractionLocator(input.locator);
          if (await interactionLocator.count() !== 1 || !(await interactionLocator.isVisible())) continue;
          const before = await readVisibleState();
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
                : "MakeADemo sample";
            await interactionLocator.fill(value);
            if (await interactionLocator.inputValue() !== value) continue;
            outcome = input.name + " contained the observed demo value";
          }
          await waitForQuietDom(250, 1500);
          const after = await readVisibleState();
          const stateTransition = readStateTransition(before, after);
          const revealedTexts = await harvestRevealedTexts(before, after, path);
          observed.interactions.push({
            kind: input.controlKind,
            locator: input.locator,
            locatorEvidence: input.locatorEvidence,
            name: input.name,
            outcome,
            ...(stateTransition ? { stateTransition } : {}),
            ...(revealedTexts.length > 0 ? { revealedTexts } : {}),
          });
        } catch (error) {
          if (isAppUnavailableError(error)) throw error;
        }
      }
      await gotoRoute(routeUrl);
      // Downstream validation replays every action from a fresh navigation,
      // so evidence gathered in interaction-mutated page state must be
      // re-proven here or dropped; emitting it would fail deterministically.
      const resolveStoredLocator = (locator) => locator.strategy === "role"
        ? page.getByRole(locator.role, { exact: locator.exact === true, name: locator.name })
        : locator.strategy === "label"
          ? page.getByLabel(locator.value, { exact: locator.exact === true })
          : locator.strategy === "placeholder"
            ? page.getByPlaceholder(locator.value, { exact: locator.exact === true })
            : locator.strategy === "text"
              ? page.getByText(locator.value, { exact: locator.exact === true })
              : page.locator(locator.value);
      const freshInteractions = [];
      for (const interaction of observed.interactions) {
        try {
          const freshExact = page.getByRole("button", { name: interaction.name, exact: true });
          const freshLocator = interaction.kind === "click"
            ? (await freshExact.count() === 1 ? freshExact : page.getByRole("button", { name: interaction.name, exact: false }))
            : createInteractionLocator(interaction.locator);
          if (await freshLocator.count() === 1 && await freshLocator.isVisible()) {
            freshInteractions.push(interaction);
            continue;
          }
          // Zero matches on the fresh-state name lookup is not proof the
          // control is gone: the stored evidence locator was verified once
          // on this route, so re-prove through it before dropping the
          // interaction (N105).
          const storedLocator = interaction.locatorEvidence?.locator;
          if (storedLocator) {
            const fallbackLocator = resolveStoredLocator(storedLocator);
            if (await fallbackLocator.count() === 1 && await fallbackLocator.isVisible()) {
              freshInteractions.push(interaction);
            }
          }
        } catch (error) {
          if (isAppUnavailableError(error)) throw error;
        }
      }
      observed.interactions = freshInteractions;
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
        if (crawlScope !== "full") break;
        const linkTarget = new URL(link.href, baseUrl);
        if (link.sameOrigin && linkTarget.origin === baseOrigin && !seen.has(normalizeCrawlUrl(linkTarget.toString()))) {
          queue.push({
            featureIds: [],
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
  // N105 stability rider: a feature entry route about to be reported
  // content-free earns one fresh navigation and re-harvest before that
  // verdict stands. First paints lose races the rest of the crawl has since
  // settled (cold compiles, slow first queries, one-off hydration stalls),
  // and a flaky miss should cost seconds, not a repair round. Only richer
  // fresh harvests replace the observation, so a confirmed miss stays a
  // miss; interactions are not re-exercised.
  const reharvestThinFeatureRoute = async (route) => {
    await gotoRoute(new URL(route.requestedPath || route.path, baseUrl).toString());
    const fresh = await page.evaluate(harvestPage);
    if (fresh.headings.length + fresh.text.length <= route.headings.length + route.text.length) return;
    fresh.buttons = prioritizeFeatureControls(fresh.buttons);
    const overlayStuck = await page.evaluate(hasCoveringLoadingOverlay).catch(() => false);
    route.headings = fresh.headings;
    route.text = fresh.text;
    route.buttons = fresh.buttons;
    route.alerts = fresh.alerts;
    route.emptyDataTables = fresh.emptyDataTables;
    route.populatedDataTables = fresh.populatedDataTables;
    route.headingLocatorEvidence = await Promise.all(route.headings.map((heading) =>
      createVerifiedRoleLocatorEvidence({ candidateNames: [heading], role: "heading", route: route.path })));
    route.buttonLocatorEvidence = await Promise.all(route.buttons.map((button) =>
      createVerifiedRoleLocatorEvidence({ candidateNames: [button], role: "button", route: route.path })));
    route.textLocatorEvidence = await Promise.all(route.text.map((text) =>
      createVerifiedDirectLocatorEvidence({ locator: { exact: true, strategy: "text", value: text }, route: route.path })));
    if (overlayStuck) { route.loadingOverlay = true; } else { delete route.loadingOverlay; }
    if (lastDocumentStatus !== undefined && lastDocumentStatus >= 400) { route.documentStatus = lastDocumentStatus; } else { delete route.documentStatus; }
    delete route.textSample;
    for (const value of [...route.headings, ...route.text]) {
      if (value) harvestedOnEarlierRoutes.add(value);
    }
    if (route.screenshot) await page.screenshot({ fullPage: true, path: route.screenshot }).catch(() => {});
    if (route.snapshot) {
      const freshAria = typeof page.locator("body").ariaSnapshot === "function" ? await page.locator("body").ariaSnapshot() : await page.locator("body").innerText();
      await writeFile(route.snapshot, freshAria).catch(() => {});
    }
  };
  for (const route of result.routes) {
    if (Date.now() >= deadlineAtMs) break;
    if (!(route.featureIds || []).length) continue;
    const verifiedTextCount = route.text.filter((value, index) => value && (!route.textLocatorEvidence || Boolean(route.textLocatorEvidence[index]))).length;
    if ((route.headings.length > 0 || verifiedTextCount > 0) && route.loadingOverlay !== true) continue;
    try {
      await reharvestThinFeatureRoute(route);
    } catch (error) {
      if (isAppUnavailableError(error)) break;
    }
  }
  // N107: declared proofs execute on fresh navigations after the crawl.
  // Each feature's typed obligation is checked from clean state — the crawl
  // above may have already exercised and mutated these routes — and the
  // verdict, not nearby wording, becomes the feature's grounding evidence.
  for (const target of declaredProofTargets) {
    if (Date.now() >= deadlineAtMs) break;
    try {
      await gotoRoute(target.url);
      const proof = target.proof;
      if (proof.kind === "visible-text") {
        const locator = page.getByText(proof.text, { exact: true });
        const count = await locator.count();
        const visible = count > 0 && await locator.first().isVisible().catch(() => false);
        const locatorEvidence = count === 1 && visible
          ? await createVerifiedDirectLocatorEvidence({ locator: { exact: true, strategy: "text", value: proof.text }, route: target.path })
          : undefined;
        result.declaredProofs.push({
          detail: visible
            ? JSON.stringify(proof.text) + " is visible on " + target.path
            : JSON.stringify(proof.text) + " was not found on " + target.path,
          featureId: target.featureId,
          ...(locatorEvidence ? { locatorEvidence } : {}),
          passed: visible,
        });
      } else if (proof.kind === "element-appears") {
        const candidates = [
          page.getByRole("button", { exact: true, name: proof.name }),
          page.getByRole("link", { exact: true, name: proof.name }),
          page.getByRole("heading", { exact: true, name: proof.name }),
          page.getByLabel(proof.name, { exact: true }),
          page.getByText(proof.name, { exact: true }),
        ];
        let visible = false;
        for (const candidate of candidates) {
          if (await candidate.count().catch(() => 0) > 0 && await candidate.first().isVisible().catch(() => false)) { visible = true; break; }
        }
        result.declaredProofs.push({
          detail: visible
            ? "a visible element named " + JSON.stringify(proof.name) + " appeared on " + target.path
            : "no visible element with accessible name " + JSON.stringify(proof.name) + " on " + target.path,
          featureId: target.featureId,
          passed: visible,
        });
      } else {
        const exact = page.getByRole("button", { exact: true, name: proof.locator });
        const control = (await exact.count()) === 1 ? exact : page.getByRole("button", { exact: false, name: proof.locator });
        const matches = await control.count();
        if (matches !== 1) {
          result.declaredProofs.push({
            detail: "control " + JSON.stringify(proof.locator) + " matched " + matches + " elements on " + target.path + "; the proof needs exactly one",
            featureId: target.featureId,
            passed: false,
          });
          continue;
        }
        const enabledBefore = await control.isEnabled().catch(() => false);
        const nameBefore = ((await control.innerText().catch(() => "")) || "").trim();
        const fromIsState = /^(?:enabled|disabled)$/i.test(proof.from);
        const fromHolds = fromIsState
          ? /^enabled$/i.test(proof.from) === enabledBefore
          : nameBefore === "" || nameBefore === proof.from;
        if (!fromHolds || !enabledBefore) {
          result.declaredProofs.push({
            detail: "control " + JSON.stringify(proof.locator) + " read " + JSON.stringify(nameBefore || (enabledBefore ? "enabled" : "disabled")) + " before the click; declared from " + JSON.stringify(proof.from) + (enabledBefore ? "" : " — a disabled control cannot be clicked; seed state so it starts enabled"),
            featureId: target.featureId,
            passed: false,
          });
          continue;
        }
        await control.click({ timeout: 4000 });
        await waitForQuietDom(250, 1500);
        const reachedTo = /^disabled$/i.test(proof.to)
          ? await control.isDisabled().catch(() => false)
          : /^enabled$/i.test(proof.to)
            ? await control.isEnabled().catch(() => false)
            : (await page.getByRole("button", { exact: true, name: proof.to }).count().catch(() => 0)) > 0;
        result.declaredProofs.push({
          detail: reachedTo
            ? JSON.stringify(proof.locator) + ": " + proof.from + " → " + proof.to + " observed on " + target.path
            : "control " + JSON.stringify(proof.locator) + " did not reach " + JSON.stringify(proof.to) + " after the click on " + target.path,
          featureId: target.featureId,
          passed: reachedTo,
        });
      }
    } catch (error) {
      if (isAppUnavailableError(error)) break;
    }
  }
  // Learn the app's not-found signature: what renders for a URL that cannot
  // exist. Recorded as a marker route the backend strips from the AppMap;
  // dropped when the app redirects the probe onto a real route (such apps
  // never show a 404 page, so the probe teaches nothing). Skipped past the
  // deadline and on overlay-stuck apps, where the probe would pay the full
  // overlay wait to harvest a page that renders nothing.
  if (Date.now() < deadlineAtMs && !result.routes.some((route) => route.loadingOverlay === true)) try {
    const probeMarker = ${JSON.stringify(notFoundProbePathMarker)};
    const probeUrl = featureEntryTargets.some((target) => target.url.includes("#/"))
      ? new URL("#/" + probeMarker, baseUrl).toString()
      : new URL("/" + probeMarker, baseUrl).toString();
    await gotoRoute(probeUrl);
    if (page.url().includes(probeMarker)) {
      const probeObserved = await page.evaluate(harvestPage);
      probeObserved.buttons = prioritizeFeatureControls(probeObserved.buttons);
      result.routes.push({
        alerts: [],
        buttons: [],
        forms: [],
        headings: probeObserved.headings,
        inputs: [],
        links: [],
        path: "/" + probeMarker,
        primaryNavigation: probeObserved.primaryNavigation,
        screenshot: "",
        snapshot: "",
        text: probeObserved.text,
        title: probeObserved.title,
      });
    }
  } catch {}
} catch (error) {
  result.fatalError = error instanceof Error ? error.message : String(error);
} finally {
  if (browser) await browser.close().catch(() => {});
}
await writeFile(outputDirectory + "/exploration.json", JSON.stringify(result)).catch(() => {});
process.stdout.write("\\n[makeademo:exploration] " + JSON.stringify(result) + "\\n");
`;
}

/**
 * One executable proof target per proof-declaring feature: its first entry
 * path resolved against the app origin. Placeholder routes and off-origin
 * paths are dropped the same way entry targets drop them.
 */
function createDeclaredProofTargets(
  baseUrl: string,
  featureInventory: PreparedDemoFeature[],
): Array<{
  featureId: string;
  path: string;
  proof: NonNullable<PreparedDemoFeature["expectedProof"]>;
  url: string;
}> {
  const baseOrigin = new URL(baseUrl).origin;
  return featureInventory.flatMap((feature) => {
    const proof = feature.expectedProof;
    const entryPath = feature.entryPaths[0];
    if (proof === undefined || entryPath === undefined) return [];
    if (findRoutePlaceholder(entryPath) !== undefined) return [];
    const url = new URL(entryPath, baseUrl);
    if (url.origin !== baseOrigin) return [];
    return [
      { featureId: feature.id, path: entryPath, proof, url: url.toString() },
    ];
  });
}

function createFeatureEntryTargets(
  baseUrl: string,
  featureInventory: PreparedDemoFeature[],
): Array<{ featureIds: string[]; requestedPath: string; url: string }> {
  const targets = new Map<
    string,
    { featureIds: Set<string>; requestedPath: string; url: string }
  >();
  const baseOrigin = new URL(baseUrl).origin;
  for (const feature of featureInventory) {
    for (const entryPath of feature.entryPaths) {
      // A router pattern navigated verbatim is a guaranteed 404; the
      // manifest gate rejects these, and any that slip through legacy
      // artifacts are dropped here rather than explored (outline,
      // 2026-08-08 — /collection/:collectionSlug opened the demo).
      if (findRoutePlaceholder(entryPath) !== undefined) continue;
      const url = new URL(entryPath, baseUrl);
      // Agent-authored entry paths must stay inside the prepared app; an
      // absolute URL to another origin is never a valid crawl target.
      if (url.origin !== baseOrigin) continue;
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

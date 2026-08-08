import {
  type BrowserLocator,
  assertLocalAppPath,
  readBrowserLocator,
} from "../../pipeline/06-footage-capture/browser-action-plan";
import {
  assertRecord,
  childPath,
  readBoolean,
  readNonEmptyString,
} from "../../shared/artifact-storage/persisted-record-readers";

export const DEMO_SCRIPT_OUTPUT_PATH = "/workspace/.makeademo/demo-script.json";
export const browserRuntimeScriptNames = [
  "dev",
  "start",
  "preview",
  "serve",
  "develop",
] as const;
export type BrowserRuntimeScriptName =
  (typeof browserRuntimeScriptNames)[number];

export type PackageManager = "bun" | "npm" | "pnpm" | "unknown" | "yarn";
type HarnessStageStatus =
  | "failed"
  | "passed"
  | "pending"
  | "running"
  | "skipped";

export type RepoWorkspacePackage = {
  dir: string;
  /** Directory where dependencies for this package must be installed. */
  installDir?: string;
  /** Whether a declared workspace root owns this package. */
  isWorkspace?: boolean;
  name?: string;
  /** Package manager selected from the owning lockfile or package metadata. */
  packageManager?: PackageManager;
  ports: number[];
  scripts: Record<string, string>;
  /** Known internal workspaces required by metadata or source imports. */
  workspaceDependencies?: string[];
};

/** A package proven to expose a runnable browser surface from screened files. */
export type RepoBrowserRuntimeCandidate = RepoWorkspacePackage & {
  /** Screened package, configuration, and browser-entry files supporting this candidate. */
  evidencePaths: string[];
  /** Browser frameworks declared directly by this package. */
  frameworks: string[];
  /**
   * Evidence that this package is a showcase or test surface rather than the
   * product: "storybook" for story files/config, "e2e" for test-runner deps.
   */
  roleHints?: string[];
};

/** Durable, source-backed identity of the browser application a run must keep. */
export type RuntimeTargetSelection = {
  /** Screened files that support selecting this application. */
  evidencePaths: string[];
  reason: string;
  role: "admin" | "docs" | "marketing" | "product" | "showcase" | "unknown";
  source: "explicit" | "model" | "single-candidate";
  targetId: string;
};

export type NetworkAttempt = {
  direction: "inbound" | "outbound";
  hasCredentials?: boolean;
  host: string;
  method?: string;
  phase: "browser" | "dependency-install" | "runtime";
  resourceType?: string;
  route?: string;
  url?: string;
};

export type RepoProfile = {
  repoUrl: string;
  commitSha?: string;
  rootDir: string;
  packageManager: PackageManager;
  lockfiles: string[];
  workspaces: {
    isMonorepo: boolean;
    packageDirectories: string[];
  };
  workspacePackages?: RepoWorkspacePackage[];
  browserRuntimeCandidates?: RepoBrowserRuntimeCandidate[];
  detectedFrameworks: string[];
  packageScripts: Record<string, string>;
  rootPackageName?: string;
  candidateAppDirs: string[];
  candidateInstallCommands: string[];
  candidateBuildCommands: string[];
  candidateStartCommands: string[];
  candidatePorts: number[];
  envExamples: string[];
  requiredEnvHints: string[];
  authHints: string[];
  externalServiceHints: string[];
  dockerHints: string[];
  securityWarnings: string[];
  unsupportedReasons: string[];
  confidence: {
    assumptions: string[];
    overall: number;
  };
};

export type RunPlan = {
  appDir: string;
  runtime: "bun" | "deno" | "node" | "unknown";
  installCommand: string;
  buildCommand?: string;
  startCommand: string;
  env: Record<string, string>;
  expectedLocalUrl: string;
  allowedPorts: number[];
  localServices: string[];
  assumptions: string[];
  riskFlags: string[];
  validationExpectations: string[];
  targetSelection?: RuntimeTargetSelection;
  /**
   * Submitted-code Node line resolved from the screened repository's pins
   * (N78). Attached by the backend after synthesis — never by the agent —
   * and executed as a /usr/local swap before any repo command runs.
   */
  nodeLine?: {
    line: number;
    provenance: string[];
    satisfied: boolean;
  };
};

export type PreparedDemoFeature = {
  authStrategy: "bypass" | "demo-identity" | "none";
  description: string;
  entryPaths: string[];
  fixtureNotes: string[];
  id: string;
  label: string;
  requestedFeature?: string;
  sourcePaths: string[];
};

type ProductContext = {
  evidencePaths: string[];
  featureInventory: PreparedDemoFeature[];
  name: string;
  summary: string;
};

export type PreparationManifest = {
  id: string;
  appDir: string;
  installCommandUsed: string;
  buildCommandUsed?: string;
  startCommandUsed: string;
  baseUrl: string;
  ports: number[];
  envUsed: Record<string, string>;
  localDemoModeChanges: string[];
  mocksAndFixturesAdded: string[];
  /** Describes secret-free authentication state active before browser exploration. */
  authBypassOrDemoIdentity?: string;
  blockedExternalServicesReplaced: string[];
  requiredLocalOnlyAssumptions: string[];
  knownLimitations: string[];
  appExplorationHints: string[];
  productContext: ProductContext;
  scriptGenerationContext: string[];
  cleanupAndReproInstructions: string[];
};

/**
 * A validator's verdict and the evidence it owes the repair agent. Failed
 * reports must satisfy the repair-evidence contract
 * (docs/agents/repair-evidence-contract.md): executed commands verbatim,
 * bounded and deduped evidence channels, observations separated from
 * diagnoses, all currently-known violations per attempt, and no
 * infrastructure errors — those are the harness's to retry or surface.
 */
export type ValidationReport = {
  status: "failed" | "passed";
  stage: string;
  attemptedCommand?: string;
  exitCode?: number;
  logsSummary: string;
  stdoutExcerpts: string[];
  stderrExcerpts: string[];
  urlChecked?: string;
  browserObservations: string[];
  consoleErrors: string[];
  pageErrors: string[];
  networkAttempts: NetworkAttempt[];
  blockedNetworkAttempts: NetworkAttempt[];
  screenshots: string[];
  failureClassification?: string;
  suggestedRepairHints: string[];
  retryCount: number;
  artifactReferences: string[];
  runtimeProbe?: RuntimeProbeDiagnostics;
};

export type RuntimeProbeDiagnostics = {
  attempts: RuntimeProbeAttempt[];
  targetUrl: string;
  finalUrl?: string;
  httpStatus?: number;
};

export type RuntimeProbeAttempt = {
  attempt: number;
  detail?: string;
  durationMs: number;
  exitCode: number;
  outcome:
    | "connection-refused"
    | "http-error"
    | "probe-error"
    | "render-timeout"
    | "responded"
    | "runtime-exited";
  startedAt: string;
  process?: RuntimeProcessObservation;
};

type RuntimeProcessObservation = {
  running: boolean;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  startedAt?: string;
  terminationReason?: "controlled-stop" | "exited" | "signaled" | "unknown";
};

type AppMapRoute = {
  path: string;
  featureIds?: string[];
  requestedPath?: string;
  title?: string;
  headings: string[];
  text: string[];
  primaryNavigation?: string[];
  buttons: string[];
  links: string[];
  forms: string[];
  inputs: string[];
  screenshots: string[];
  snapshotPath?: string;
};

export type AppMap = {
  id: string;
  baseUrl: string;
  discoveredRoutes: AppMapRoute[];
  loginOrAuthWalls: string[];
  consoleErrors: string[];
  pageErrors: string[];
  networkAttempts?: NetworkAttempt[];
  blockedNetworkAttempts: NetworkAttempt[];
  actionCatalogId?: string;
};

type LocatorStrategy =
  | "css"
  | "label"
  | "placeholder"
  | "role"
  | "test-id"
  | "text"
  | "xpath";

type ActionCatalogAction = {
  id: string;
  /** True only when browser exploration executed the action and observed its result. */
  exercised?: true;
  featureIds?: string[];
  route: string;
  kind:
    | "assert"
    | "click"
    | "fill"
    | "navigate"
    | "scroll"
    | "select"
    | "upload"
    | "wait";
  preferredLocator: {
    strategy: LocatorStrategy;
    value: string;
    name?: string;
    reason?: string;
  };
  locatorCandidates?: VerifiedLocatorCandidate[];
  preferredLocatorCandidateId?: string;
  fallbackLocator?: string;
  evidence: string;
  expectedResult: string;
  confidence: number;
  risks: string[];
  scrollPosition?: "bottom" | "top";
};

export type VerifiedLocatorCandidate = {
  id: string;
  locator: BrowserLocator;
  observedAccessibleName?: string;
  verification: {
    matchCount: 1;
    route: string;
    targetHref?: string;
    visible: true;
  };
};

export type ActionCatalog = {
  id: string;
  appMapId: string;
  actions: ActionCatalogAction[];
};

export type FlowSpecFeature = {
  expectedVisibleAssertions: string[];
  featureId: string;
  label: string;
  referencedActionIds: string[];
  referencedAppMapRoutePaths: string[];
  requestedFeature?: string;
  requiredAppState: string[];
  selectionReason: string;
  steps: string[];
};

export type FlowSpec = {
  features: FlowSpecFeature[];
  id: string;
  repairConstraints: string[];
  version: 2;
};

export type DemoScriptContract = {
  captureSdkVersion: string;
  contractVersion: string;
  examples: unknown[];
  jsonSchema: Record<string, unknown>;
  outputPath: typeof DEMO_SCRIPT_OUTPUT_PATH;
  requiredJsonShape: string[];
  allowedCaptureSdkActions: string[];
  requiredMetadata: string[];
  baseUrlBinding: string;
  requiredAssertions: string[];
  timingConventions: string[];
  forbiddenFields: string[];
  forbiddenApis: string[];
  forbiddenExternalUrls: boolean;
  browserContextOwnership: string;
  networkRestrictions: string[];
};

export type ScriptCandidate = {
  outputPath: typeof DEMO_SCRIPT_OUTPUT_PATH;
  scriptJsonContent: unknown;
  contractVersion: string;
  captureSdkVersion: string;
  browserActionCompilerVersion: string;
  bunRuntimeVersion: string;
  playwrightRuntimeVersion: string;
  sourceFlowSpecId: string;
  sourceAppMapId: string;
  sourcePreparationManifestId: string;
  conformanceResult: ValidationReport;
  assumptions: string[];
  unsupportedPieces: string[];
  validationArtifacts: string[];
};

export type PipelineRunManifest = {
  runId: string;
  repoUrl: string;
  commitSha?: string;
  daytonaSandboxIds: {
    agent?: string;
    submittedCode?: string;
  };
  opencodeSessionIds: string[];
  stageTimings: Array<{
    stage: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
  }>;
  stageStatuses: Record<string, HarnessStageStatus>;
  networkStateTransitions: Array<{
    at: string;
    state:
      | "dependency-install-closed"
      | "dependency-install-open"
      | "runtime-locked";
  }>;
  artifactPaths: Record<string, string>;
  finalStatus: "failed" | "passed" | "unsupported";
  unsupportedOrFailureReason?: string;
};

export function readRunPlan(value: unknown): RunPlan {
  const record = assertRecord(value, "RunPlan");
  const runPlan: RunPlan = {
    allowedPorts: readPortArray(record, "allowedPorts"),
    appDir: readRepoRelativePath(record, "appDir"),
    assumptions: readStringArray(record, "assumptions"),
    ...optionalKey(record, "buildCommand", readNonEmptyString),
    env: readStringRecord(record, "env"),
    expectedLocalUrl: readLocalHttpUrl(record, "expectedLocalUrl"),
    installCommand: readNonEmptyString(record, "installCommand"),
    localServices: readStringArray(record, "localServices"),
    ...readOptionalNodeLine(record.nodeLine),
    riskFlags: readStringArray(record, "riskFlags"),
    runtime: readEnum(record, "runtime", ["bun", "deno", "node", "unknown"]),
    startCommand: readNonEmptyString(record, "startCommand"),
    ...readOptionalRuntimeTargetSelection(record.targetSelection),
    validationExpectations: readStringArray(record, "validationExpectations"),
  };
  if (
    runPlan.targetSelection !== undefined &&
    runPlan.targetSelection.targetId !== runPlan.appDir
  ) {
    throw new Error("RunPlan.targetSelection.targetId must match appDir");
  }
  return runPlan;
}

// The backend attaches the resolved submitted-code Node line after run-plan
// synthesis; reads must preserve it so repair rounds and run-dir forensics
// see the same decision the swap executed.
function readOptionalNodeLine(value: unknown): Pick<RunPlan, "nodeLine"> {
  if (value === undefined) return {};
  const record = assertRecord(value, "RunPlan.nodeLine");
  if (
    typeof record.line !== "number" ||
    typeof record.satisfied !== "boolean"
  ) {
    throw new Error(
      "RunPlan.nodeLine must carry a numeric line and satisfied flag",
    );
  }
  return {
    nodeLine: {
      line: record.line,
      provenance: readStringArray(record, "provenance", "RunPlan.nodeLine"),
      satisfied: record.satisfied,
    },
  };
}

function readOptionalRuntimeTargetSelection(
  value: unknown,
): Pick<RunPlan, "targetSelection"> {
  if (value === undefined) return {};
  const record = assertRecord(value, "RunPlan.targetSelection");
  return {
    targetSelection: {
      evidencePaths: readRepoPathArray(
        record,
        "evidencePaths",
        "RunPlan.targetSelection",
      ),
      reason: readNonEmptyString(record, "reason", "RunPlan.targetSelection"),
      role: readEnum(
        record,
        "role",
        ["admin", "docs", "marketing", "product", "showcase", "unknown"],
        "RunPlan.targetSelection",
      ),
      source: readEnum(
        record,
        "source",
        ["explicit", "model", "single-candidate"],
        "RunPlan.targetSelection",
      ),
      targetId: readRepoRelativePath(record, "targetId"),
    },
  };
}

export function readPreparationManifest(value: unknown): PreparationManifest {
  const record = assertRecord(value, "PreparationManifest");
  assertValidPreparationManifestFields(record);
  return {
    appDir: readRepoRelativePath(record, "appDir"),
    appExplorationHints: readStringArray(record, "appExplorationHints"),
    ...optionalKey(record, "authBypassOrDemoIdentity", readNonEmptyString),
    baseUrl: readLocalHttpUrl(record, "baseUrl"),
    blockedExternalServicesReplaced: readStringArray(
      record,
      "blockedExternalServicesReplaced",
    ),
    ...optionalKey(record, "buildCommandUsed", readNonEmptyString),
    cleanupAndReproInstructions: readStringArray(
      record,
      "cleanupAndReproInstructions",
    ),
    envUsed: readStringRecord(record, "envUsed"),
    id: readNonEmptyString(record, "id"),
    installCommandUsed: readNonEmptyString(record, "installCommandUsed"),
    knownLimitations: readStringArray(record, "knownLimitations"),
    localDemoModeChanges: readStringArray(record, "localDemoModeChanges"),
    mocksAndFixturesAdded: readStringArray(record, "mocksAndFixturesAdded"),
    ports: readPortArray(record, "ports"),
    requiredLocalOnlyAssumptions: readStringArray(
      record,
      "requiredLocalOnlyAssumptions",
    ),
    productContext: readProductContext(record.productContext),
    scriptGenerationContext: readStringArray(record, "scriptGenerationContext"),
    startCommandUsed: readNonEmptyString(record, "startCommandUsed"),
  };
}

function assertValidPreparationManifestFields(
  record: Record<string, unknown>,
): void {
  const validations: Array<() => unknown> = [
    () => readNonEmptyString(record, "id"),
    () => readRepoRelativePath(record, "appDir"),
    () => readNonEmptyString(record, "installCommandUsed"),
    ...(record.buildCommandUsed === undefined
      ? []
      : [() => readNonEmptyString(record, "buildCommandUsed")]),
    () => readNonEmptyString(record, "startCommandUsed"),
    () => readLocalHttpUrl(record, "baseUrl"),
    () => readPortArray(record, "ports"),
    () => readStringRecord(record, "envUsed"),
    () => readStringArray(record, "localDemoModeChanges"),
    () => readStringArray(record, "mocksAndFixturesAdded"),
    ...(record.authBypassOrDemoIdentity === undefined
      ? []
      : [() => readNonEmptyString(record, "authBypassOrDemoIdentity")]),
    () => readStringArray(record, "blockedExternalServicesReplaced"),
    () => readStringArray(record, "requiredLocalOnlyAssumptions"),
    () => readStringArray(record, "knownLimitations"),
    () => readStringArray(record, "appExplorationHints"),
    () => readProductContext(record.productContext),
    () => readStringArray(record, "scriptGenerationContext"),
    () => readStringArray(record, "cleanupAndReproInstructions"),
  ];
  const errors: string[] = [];
  for (const validate of validations) {
    try {
      validate();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `PreparationManifest validation failed: ${errors.join("; ")}`,
    );
  }
}

function readProductContext(value: unknown): ProductContext {
  const path = "productContext";
  const record = assertRecord(value, path);
  const errors: string[] = [];
  const evidencePaths = captureValidationError(errors, () =>
    readRepoPathArray(record, "evidencePaths", path),
  );
  const featureInventory = readPreparedDemoFeatures(
    record.featureInventory,
    errors,
  );
  const name = captureValidationError(errors, () =>
    readNonEmptyString(record, "name", path),
  );
  const summary = captureValidationError(errors, () =>
    readNonEmptyString(record, "summary", path),
  );
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  if (
    evidencePaths === undefined ||
    featureInventory === undefined ||
    name === undefined ||
    summary === undefined
  ) {
    throw new Error("productContext validation did not produce parsed values");
  }
  return { evidencePaths, featureInventory, name, summary };
}

function readPreparedDemoFeatures(
  value: unknown,
  errors: string[],
): PreparedDemoFeature[] | undefined {
  const path = "productContext.featureInventory";
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  const features = value.flatMap((entry, index) => {
    const feature = readPreparedDemoFeature(entry, index, errors);
    return feature === undefined ? [] : [feature];
  });
  const featureIds = new Set(features.map((feature) => feature.id));
  if (featureIds.size !== features.length) {
    errors.push(`${path} ids must be unique`);
  }
  return features;
}

function readPreparedDemoFeature(
  value: unknown,
  index: number,
  errors: string[],
): PreparedDemoFeature | undefined {
  const path = `productContext.featureInventory[${index}]`;
  const errorCount = errors.length;
  const feature = captureValidationError(errors, () =>
    assertRecord(value, path),
  );
  if (feature === undefined) {
    return undefined;
  }
  const id = captureValidationError(errors, () =>
    readNonEmptyString(feature, "id", path),
  );
  if (id !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    errors.push(`${path}.id must be a safe identifier`);
  }
  const authStrategy = captureValidationError(errors, () =>
    readEnum(
      feature,
      "authStrategy",
      ["bypass", "demo-identity", "none"],
      path,
    ),
  );
  const description = captureValidationError(errors, () =>
    readNonEmptyString(feature, "description", path),
  );
  const entryPaths = captureValidationError(errors, () =>
    readLocalAppPathArray(feature, "entryPaths", path),
  );
  const fixtureNotes = captureValidationError(errors, () =>
    readStringArray(feature, "fixtureNotes", path),
  );
  const label = captureValidationError(errors, () =>
    readNonEmptyString(feature, "label", path),
  );
  const requestedFeature =
    feature.requestedFeature === undefined
      ? undefined
      : captureValidationError(errors, () =>
          readNonEmptyString(feature, "requestedFeature", path),
        );
  const sourcePaths = captureValidationError(errors, () =>
    readRepoPathArray(feature, "sourcePaths", path),
  );
  if (
    errors.length > errorCount ||
    id === undefined ||
    authStrategy === undefined ||
    description === undefined ||
    entryPaths === undefined ||
    fixtureNotes === undefined ||
    label === undefined ||
    sourcePaths === undefined
  ) {
    return undefined;
  }
  return {
    authStrategy,
    description,
    entryPaths,
    fixtureNotes,
    id,
    label,
    ...(requestedFeature === undefined ? {} : { requestedFeature }),
    sourcePaths,
  };
}

function captureValidationError<T>(
  errors: string[],
  validate: () => T,
): T | undefined {
  try {
    return validate();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function readRepoPathArray(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
): string[] {
  const path = `${parentPath}.${key}`;
  return readArray(record[key], path, (entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty string`);
    }
    const segments = entry.split(/[\\/]/);
    if (
      entry !== entry.trim() ||
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(entry) ||
      entry.includes("\0") ||
      segments.includes("..")
    ) {
      throw new Error(
        `${path}[${index}] must be a relative path within /workspace/repo`,
      );
    }
    return entry;
  });
}

function readLocalAppPathArray(
  record: Record<string, unknown>,
  key: string,
  parentPath: string,
): string[] {
  const path = `${parentPath}.${key}`;
  return readArray(record[key], path, (entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${path}[${index}] must be a local app path`);
    }
    assertLocalAppPath(entry, `${path}[${index}]`);
    return entry;
  });
}

export function readValidationReport(value: unknown): ValidationReport {
  const record = assertRecord(value, "ValidationReport");
  return {
    artifactReferences: readStringArray(record, "artifactReferences"),
    ...optionalKey(record, "attemptedCommand", readNonEmptyString),
    blockedNetworkAttempts: readNetworkAttempts(
      record,
      "blockedNetworkAttempts",
    ),
    browserObservations: readStringArray(record, "browserObservations"),
    consoleErrors: readStringArray(record, "consoleErrors"),
    ...optionalKey(record, "exitCode", readNonNegativeNumber),
    ...optionalKey(record, "failureClassification", readNonEmptyString),
    logsSummary: readNonEmptyString(record, "logsSummary"),
    networkAttempts: readNetworkAttempts(record, "networkAttempts"),
    pageErrors: readStringArray(record, "pageErrors"),
    retryCount: readNonNegativeInteger(record, "retryCount"),
    ...(record.runtimeProbe === undefined
      ? {}
      : { runtimeProbe: readRuntimeProbe(record.runtimeProbe) }),
    screenshots: readStringArray(record, "screenshots"),
    stage: readNonEmptyString(record, "stage"),
    status: readEnum(record, "status", ["failed", "passed"]),
    stderrExcerpts: readStringArray(record, "stderrExcerpts"),
    stdoutExcerpts: readStringArray(record, "stdoutExcerpts"),
    suggestedRepairHints: readStringArray(record, "suggestedRepairHints"),
    ...optionalKey(record, "urlChecked", readLocalHttpUrl),
  };
}

function readRuntimeProbe(value: unknown): RuntimeProbeDiagnostics {
  const path = "runtimeProbe";
  const record = assertRecord(value, path);
  return {
    attempts: readArray(record.attempts, `${path}.attempts`, (entry, index) => {
      const attemptPath = `${path}.attempts[${index}]`;
      const attempt = assertRecord(entry, attemptPath);
      return {
        attempt: readNonNegativeInteger(attempt, "attempt", attemptPath),
        ...(attempt.detail === undefined
          ? {}
          : { detail: readNonEmptyString(attempt, "detail", attemptPath) }),
        durationMs: readNonNegativeNumber(attempt, "durationMs", attemptPath),
        exitCode: readNonNegativeInteger(attempt, "exitCode", attemptPath),
        outcome: readEnum(
          attempt,
          "outcome",
          [
            "connection-refused",
            "http-error",
            "probe-error",
            "render-timeout",
            "responded",
            "runtime-exited",
          ],
          attemptPath,
        ),
        startedAt: readIsoDateString(attempt, "startedAt", attemptPath),
        ...(attempt.process === undefined
          ? {}
          : {
              process: readRuntimeProcessObservation(
                attempt.process,
                `${attemptPath}.process`,
              ),
            }),
      };
    }),
    ...(record.finalUrl === undefined
      ? {}
      : { finalUrl: readLocalHttpUrl(record, "finalUrl", path) }),
    ...(record.httpStatus === undefined
      ? {}
      : {
          httpStatus: readNonNegativeInteger(record, "httpStatus", path),
        }),
    targetUrl: readLocalHttpUrl(record, "targetUrl", path),
  };
}

function readRuntimeProcessObservation(
  value: unknown,
  path: string,
): RuntimeProcessObservation {
  const record = assertRecord(value, path);
  return {
    running: readBoolean(record, "running", path),
    ...(record.endedAt === undefined
      ? {}
      : { endedAt: readIsoDateString(record, "endedAt", path) }),
    ...(record.exitCode === undefined
      ? {}
      : { exitCode: readNonNegativeInteger(record, "exitCode", path) }),
    ...(record.signal === undefined
      ? {}
      : { signal: readNonEmptyString(record, "signal", path) }),
    ...(record.startedAt === undefined
      ? {}
      : { startedAt: readIsoDateString(record, "startedAt", path) }),
    ...(record.terminationReason === undefined
      ? {}
      : {
          terminationReason: readEnum(
            record,
            "terminationReason",
            ["controlled-stop", "exited", "signaled", "unknown"],
            path,
          ),
        }),
  };
}

export function readAppMap(value: unknown): AppMap {
  const record = assertRecord(value, "AppMap");
  return {
    ...optionalKey(record, "actionCatalogId", readNonEmptyString),
    baseUrl: readLocalHttpUrl(record, "baseUrl"),
    blockedNetworkAttempts: readNetworkAttempts(
      record,
      "blockedNetworkAttempts",
    ),
    consoleErrors: readStringArray(record, "consoleErrors"),
    discoveredRoutes: readRoutes(record.discoveredRoutes),
    id: readNonEmptyString(record, "id"),
    loginOrAuthWalls: readStringArray(record, "loginOrAuthWalls"),
    ...(record.networkAttempts === undefined
      ? {}
      : { networkAttempts: readNetworkAttempts(record, "networkAttempts") }),
    pageErrors: readStringArray(record, "pageErrors"),
  };
}

export function readActionCatalog(value: unknown): ActionCatalog {
  const record = assertRecord(value, "ActionCatalog");
  const actions = readArray(record.actions, "actions", readAction);
  if (actions.length === 0) {
    throw new Error("actions must be a non-empty array");
  }
  return {
    actions,
    appMapId: readNonEmptyString(record, "appMapId"),
    id: readNonEmptyString(record, "id"),
  };
}

export function readFlowSpec(value: unknown): FlowSpec {
  const record = assertRecord(value, "FlowSpec");
  if (record.version !== 2) {
    throw new Error("FlowSpec.version must be 2");
  }
  const features = readArray(record.features, "features", readFlowSpecFeature);
  if (features.length === 0) {
    throw new Error("features must be a non-empty array");
  }
  const featureIds = new Set(features.map((feature) => feature.featureId));
  if (featureIds.size !== features.length) {
    throw new Error("features featureId values must be unique");
  }
  return {
    features,
    id: readNonEmptyString(record, "id"),
    repairConstraints: readStringArray(record, "repairConstraints"),
    version: 2,
  };
}

function readFlowSpecFeature(value: unknown, index: number): FlowSpecFeature {
  const path = `features[${index}]`;
  const record = assertRecord(value, path);
  const featureId = readNonEmptyString(record, "featureId", path);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(featureId)) {
    throw new Error(`${path}.featureId must be a safe identifier`);
  }
  const steps = readStringArray(record, "steps", path);
  const routes = readStringArray(record, "referencedAppMapRoutePaths", path);
  const actions = readStringArray(record, "referencedActionIds", path);
  const assertions = readStringArray(record, "expectedVisibleAssertions", path);
  if (
    steps.length === 0 ||
    routes.length === 0 ||
    actions.length === 0 ||
    assertions.length === 0
  ) {
    throw new Error(
      `${path} must contain non-empty steps, routes, actions, and visible assertions`,
    );
  }
  return {
    expectedVisibleAssertions: assertions,
    featureId,
    label: readNonEmptyString(record, "label", path),
    referencedActionIds: actions,
    referencedAppMapRoutePaths: routes,
    ...(record.requestedFeature === undefined
      ? {}
      : {
          requestedFeature: readNonEmptyString(
            record,
            "requestedFeature",
            path,
          ),
        }),
    requiredAppState: readStringArray(record, "requiredAppState", path),
    selectionReason: readNonEmptyString(record, "selectionReason", path),
    steps,
  };
}

export function readScriptCandidate(value: unknown): ScriptCandidate {
  const record = assertRecord(value, "ScriptCandidate");
  return {
    assumptions: readStringArray(record, "assumptions"),
    browserActionCompilerVersion: readNonEmptyString(
      record,
      "browserActionCompilerVersion",
    ),
    bunRuntimeVersion: readNonEmptyString(record, "bunRuntimeVersion"),
    captureSdkVersion: readNonEmptyString(record, "captureSdkVersion"),
    conformanceResult: readValidationReport(record.conformanceResult),
    contractVersion: readNonEmptyString(record, "contractVersion"),
    outputPath: readDemoScriptOutputPath(record, "outputPath"),
    playwrightRuntimeVersion: readNonEmptyString(
      record,
      "playwrightRuntimeVersion",
    ),
    scriptJsonContent: record.scriptJsonContent,
    sourceAppMapId: readNonEmptyString(record, "sourceAppMapId"),
    sourceFlowSpecId: readNonEmptyString(record, "sourceFlowSpecId"),
    sourcePreparationManifestId: readNonEmptyString(
      record,
      "sourcePreparationManifestId",
    ),
    unsupportedPieces: readStringArray(record, "unsupportedPieces"),
    validationArtifacts: readStringArray(record, "validationArtifacts"),
  };
}

export function readPipelineRunManifest(value: unknown): PipelineRunManifest {
  const record = assertRecord(value, "PipelineRunManifest");
  return {
    artifactPaths: readStringRecord(record, "artifactPaths"),
    ...optionalKey(record, "commitSha", readNonEmptyString),
    daytonaSandboxIds: readDaytonaSandboxIds(record.daytonaSandboxIds),
    finalStatus: readEnum(record, "finalStatus", [
      "failed",
      "passed",
      "unsupported",
    ]),
    networkStateTransitions: readNetworkStateTransitions(
      record.networkStateTransitions,
    ),
    opencodeSessionIds: readStringArray(record, "opencodeSessionIds"),
    repoUrl: readNonEmptyString(record, "repoUrl"),
    runId: readNonEmptyString(record, "runId"),
    stageStatuses: readStageStatuses(record.stageStatuses),
    stageTimings: readStageTimings(record.stageTimings),
    ...optionalKey(record, "unsupportedOrFailureReason", readNonEmptyString),
  };
}

function readRoutes(value: unknown): AppMapRoute[] {
  const routes = readArray(value, "discoveredRoutes", (route, index) => {
    const path = `discoveredRoutes[${index}]`;
    const record = assertRecord(route, path);
    return {
      buttons: readStringArray(record, "buttons", path),
      ...(record.featureIds === undefined
        ? {}
        : { featureIds: readStringArray(record, "featureIds", path) }),
      forms: readStringArray(record, "forms", path),
      headings: readStringArray(record, "headings", path),
      inputs: readStringArray(record, "inputs", path),
      links: readStringArray(record, "links", path),
      path: readLocalRoute(record, "path", path),
      ...(record.primaryNavigation === undefined
        ? {}
        : {
            primaryNavigation: readStringArray(
              record,
              "primaryNavigation",
              path,
            ),
          }),
      ...(record.requestedPath === undefined
        ? {}
        : {
            requestedPath: readNonEmptyString(record, "requestedPath", path),
          }),
      screenshots: readStringArray(record, "screenshots", path),
      ...(record.snapshotPath === undefined
        ? {}
        : { snapshotPath: readNonEmptyString(record, "snapshotPath", path) }),
      text: readStringArray(record, "text", path),
      ...(record.title === undefined
        ? {}
        : { title: readNonEmptyString(record, "title", path) }),
    };
  });
  if (routes.length === 0) {
    throw new Error("discoveredRoutes must be a non-empty array");
  }
  return routes;
}

function readAction(value: unknown, index: number): ActionCatalogAction {
  const path = `actions[${index}]`;
  const record = assertRecord(value, path);
  const locatorCandidates =
    record.locatorCandidates === undefined
      ? undefined
      : readLocatorCandidates(record.locatorCandidates, path);
  const preferredLocatorCandidateId =
    record.preferredLocatorCandidateId === undefined
      ? undefined
      : readNonEmptyString(record, "preferredLocatorCandidateId", path);
  const exercised =
    record.exercised === undefined
      ? undefined
      : readBoolean(record, "exercised", path);
  if (exercised === false) {
    throw new Error(`${path}.exercised must be true when provided`);
  }
  const kind = readEnum(
    record,
    "kind",
    [
      "assert",
      "click",
      "fill",
      "navigate",
      "scroll",
      "select",
      "upload",
      "wait",
    ],
    path,
  );
  if (
    exercised === true &&
    !["click", "fill", "select", "upload"].includes(kind)
  ) {
    throw new Error(`${path}.exercised is only valid for feature interactions`);
  }
  if (
    locatorCandidates !== undefined &&
    preferredLocatorCandidateId === undefined
  ) {
    throw new Error(
      `${path}.preferredLocatorCandidateId is required with locatorCandidates`,
    );
  }
  if (
    preferredLocatorCandidateId !== undefined &&
    !locatorCandidates?.some(
      (candidate) => candidate.id === preferredLocatorCandidateId,
    )
  ) {
    throw new Error(
      `${path}.preferredLocatorCandidateId must reference locatorCandidates`,
    );
  }
  return {
    confidence: readConfidenceNumber(record, "confidence", path),
    evidence: readNonEmptyString(record, "evidence", path),
    ...(exercised === undefined ? {} : { exercised: true as const }),
    expectedResult: readNonEmptyString(record, "expectedResult", path),
    ...(record.fallbackLocator === undefined
      ? {}
      : {
          fallbackLocator: readNonEmptyString(record, "fallbackLocator", path),
        }),
    ...(record.featureIds === undefined
      ? {}
      : { featureIds: readStringArray(record, "featureIds", path) }),
    id: readNonEmptyString(record, "id", path),
    kind,
    ...(locatorCandidates === undefined ? {} : { locatorCandidates }),
    preferredLocator: readPreferredLocator(record.preferredLocator, path),
    ...(preferredLocatorCandidateId === undefined
      ? {}
      : { preferredLocatorCandidateId }),
    risks: readStringArray(record, "risks", path),
    route: readLocalRoute(record, "route", path),
    ...(record.scrollPosition === undefined
      ? {}
      : {
          scrollPosition: readEnum(
            record,
            "scrollPosition",
            ["bottom", "top"],
            path,
          ),
        }),
  };
}

function readLocatorCandidates(
  value: unknown,
  parentPath: string,
): VerifiedLocatorCandidate[] {
  const candidates = readArray(
    value,
    `${parentPath}.locatorCandidates`,
    (entry, index) => {
      const path = `${parentPath}.locatorCandidates[${index}]`;
      const record = assertRecord(entry, path);
      const verificationPath = `${path}.verification`;
      const verification = assertRecord(record.verification, verificationPath);
      const matchCount = readNonNegativeNumber(
        verification,
        "matchCount",
        verificationPath,
      );
      if (matchCount !== 1) {
        throw new Error(`${verificationPath}.matchCount must be 1`);
      }
      const visible = readBoolean(verification, "visible", verificationPath);
      if (!visible) {
        throw new Error(`${verificationPath}.visible must be true`);
      }
      return {
        id: readNonEmptyString(record, "id", path),
        locator: readBrowserLocator(record.locator, `${path}.locator`),
        ...(record.observedAccessibleName === undefined
          ? {}
          : {
              observedAccessibleName: readNonEmptyString(
                record,
                "observedAccessibleName",
                path,
              ),
            }),
        verification: {
          matchCount: 1 as const,
          route: readLocalRoute(verification, "route", verificationPath),
          ...(verification.targetHref === undefined
            ? {}
            : {
                targetHref: readNonEmptyString(
                  verification,
                  "targetHref",
                  verificationPath,
                ),
              }),
          visible: true as const,
        },
      };
    },
  );
  if (candidates.length === 0) {
    throw new Error(`${parentPath}.locatorCandidates must be non-empty`);
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== candidates.length) {
    throw new Error(`${parentPath}.locatorCandidates ids must be unique`);
  }
  return candidates;
}

function readPreferredLocator(
  value: unknown,
  parentPath: string,
): ActionCatalogAction["preferredLocator"] {
  const path = `${parentPath}.preferredLocator`;
  const record = assertRecord(value, path);
  const strategy = readEnum(
    record,
    "strategy",
    ["css", "label", "placeholder", "role", "test-id", "text", "xpath"],
    path,
  );
  if (
    (strategy === "css" || strategy === "xpath") &&
    record.reason === undefined
  ) {
    throw new Error(
      `${path}.reason must explain why non-semantic locators are necessary`,
    );
  }
  return {
    ...(record.name === undefined
      ? {}
      : { name: readNonEmptyString(record, "name", path) }),
    ...(record.reason === undefined
      ? {}
      : { reason: readNonEmptyString(record, "reason", path) }),
    strategy,
    value: readNonEmptyString(record, "value", path),
  };
}

function readNetworkAttempts(
  record: Record<string, unknown>,
  key: string,
): NetworkAttempt[] {
  return readArray(record[key], key, (value, index) => {
    const path = `${key}[${index}]`;
    const attempt = assertRecord(value, path);
    return {
      direction: readEnum(attempt, "direction", ["inbound", "outbound"], path),
      ...(attempt.hasCredentials === undefined
        ? {}
        : {
            hasCredentials: readBoolean(attempt, "hasCredentials", path),
          }),
      host: readNonEmptyString(attempt, "host", path),
      ...(attempt.method === undefined
        ? {}
        : { method: readNonEmptyString(attempt, "method", path) }),
      phase: readEnum(
        attempt,
        "phase",
        ["browser", "dependency-install", "runtime"],
        path,
      ),
      ...(attempt.resourceType === undefined
        ? {}
        : {
            resourceType: readNonEmptyString(attempt, "resourceType", path),
          }),
      ...(attempt.route === undefined
        ? {}
        : { route: readNonEmptyString(attempt, "route", path) }),
      ...(attempt.url === undefined
        ? {}
        : { url: readNonEmptyString(attempt, "url", path) }),
    };
  });
}

function readDaytonaSandboxIds(
  value: unknown,
): PipelineRunManifest["daytonaSandboxIds"] {
  const record = assertRecord(value, "daytonaSandboxIds");
  return {
    ...optionalKey(record, "agent", readNonEmptyString),
    ...optionalKey(record, "submittedCode", readNonEmptyString),
  };
}

function readNetworkStateTransitions(
  value: unknown,
): PipelineRunManifest["networkStateTransitions"] {
  return readArray(value, "networkStateTransitions", (entry, index) => {
    const path = `networkStateTransitions[${index}]`;
    const record = assertRecord(entry, path);
    return {
      at: readIsoDateString(record, "at", path),
      state: readEnum(
        record,
        "state",
        [
          "dependency-install-closed",
          "dependency-install-open",
          "runtime-locked",
        ],
        path,
      ),
    };
  });
}

function readStageTimings(value: unknown): PipelineRunManifest["stageTimings"] {
  return readArray(value, "stageTimings", (entry, index) => {
    const path = `stageTimings[${index}]`;
    const record = assertRecord(entry, path);
    return {
      ...(record.durationMs === undefined
        ? {}
        : { durationMs: readNonNegativeNumber(record, "durationMs", path) }),
      ...(record.finishedAt === undefined
        ? {}
        : { finishedAt: readIsoDateString(record, "finishedAt", path) }),
      stage: readNonEmptyString(record, "stage", path),
      startedAt: readIsoDateString(record, "startedAt", path),
    };
  });
}

function readStageStatuses(value: unknown): Record<string, HarnessStageStatus> {
  const record = assertRecord(value, "stageStatuses");
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      readEnumValue(
        entry,
        ["failed", "passed", "pending", "running", "skipped"],
        `stageStatuses.${key}`,
      ),
    ]),
  );
}

function readArray<T>(
  value: unknown,
  path: string,
  readItem: (value: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value.map(readItem);
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string[] {
  const path = childPath(parentPath, key);
  return readArray(record[key], path, (item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${path}[${index}] must be a string`);
    }
    return item;
  });
}

function readStringRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const path = key;
  const value = assertRecord(record[key], path);
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => {
      if (typeof entryValue !== "string") {
        throw new Error(`${path}.${entryKey} must be a string`);
      }
      return [entryKey, entryValue];
    }),
  );
}

/**
 * Reads an observed app route. Routes become synthesized navigation, so they
 * must resolve back to the app's own origin; a bare string would let an
 * off-origin or authority-bearing value reach the compiled capture script.
 */
function readLocalRoute(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string {
  const path = childPath(parentPath, key);
  const route = readNonEmptyString(record, key, parentPath);
  assertLocalAppPath(route, path, "route");
  return route;
}

function readRepoRelativePath(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = readNonEmptyString(record, key);
  const segments = value.split(/[\\/]/);
  if (
    value !== value.trim() ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\0") ||
    segments.includes("..")
  ) {
    throw new Error(`${key} must be a relative path within /workspace/repo`);
  }
  return value;
}

function readLocalHttpUrl(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string {
  const value = readNonEmptyString(record, key, parentPath);
  const path = childPath(parentPath, key);
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      ["0.0.0.0", "127.0.0.1", "localhost"].includes(url.hostname)
    ) {
      return value;
    }
  } catch {
    // Use the shared validation error below.
  }
  throw new Error(`${path} must be a local http URL`);
}

function readPortArray(record: Record<string, unknown>, key: string): number[] {
  return readArray(record[key], key, (item, index) => {
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 1 ||
      item > 65_535
    ) {
      throw new Error(`${key}[${index}] must be a valid port`);
    }
    return item;
  });
}

function readEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowedValues: T,
  parentPath?: string,
): T[number] {
  const path = childPath(parentPath, key);
  return readEnumValue(record[key], allowedValues, path);
}

function readEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  path: string,
): T[number] {
  if (
    typeof value !== "string" ||
    !allowedValues.includes(value as T[number])
  ) {
    throw new Error(`${path} must be one of: ${allowedValues.join(", ")}`);
  }
  return value as T[number];
}

function readConfidenceNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): number {
  const value = readNonNegativeNumber(record, key, parentPath);
  if (value > 1) {
    const path = childPath(parentPath, key);
    throw new Error(`${path} must be between 0 and 1`);
  }
  return value;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): number {
  const path = childPath(parentPath, key);
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): number {
  const value = readNonNegativeNumber(record, key, parentPath);
  if (!Number.isInteger(value)) {
    const path = childPath(parentPath, key);
    throw new Error(`${path} must be an integer`);
  }
  return value;
}

function readDemoScriptOutputPath(
  record: Record<string, unknown>,
  key: string,
): typeof DEMO_SCRIPT_OUTPUT_PATH {
  const value = readNonEmptyString(record, key);
  if (value !== DEMO_SCRIPT_OUTPUT_PATH) {
    throw new Error(`${key} must be ${DEMO_SCRIPT_OUTPUT_PATH}`);
  }
  return DEMO_SCRIPT_OUTPUT_PATH;
}

function readIsoDateString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string {
  const value = readNonEmptyString(record, key, parentPath);
  const path = childPath(parentPath, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
  return value;
}

function optionalKey<K extends string, V>(
  record: Record<string, unknown>,
  key: K,
  read: (record: Record<string, unknown>, key: K) => V,
): Partial<Record<K, V>> {
  return record[key] === undefined
    ? {}
    : ({ [key]: read(record, key) } as Partial<Record<K, V>>);
}

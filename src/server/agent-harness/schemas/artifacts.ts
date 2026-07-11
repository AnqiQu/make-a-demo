import {
  type BrowserLocator,
  readBrowserLocator,
} from "../../pipeline/06-footage-capture/browser-action-plan";

export const DEMO_SCRIPT_OUTPUT_PATH = "/workspace/.makeademo/demo-script.json";

type PackageManager = "bun" | "npm" | "pnpm" | "unknown" | "yarn";
type HarnessStageStatus =
  | "failed"
  | "passed"
  | "pending"
  | "running"
  | "skipped";

export type NetworkAttempt = {
  direction: "inbound" | "outbound";
  host: string;
  phase: "browser" | "dependency-install" | "runtime";
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
  detectedFrameworks: string[];
  packageScripts: Record<string, string>;
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
  createdFiles: string[];
  modifiedFiles: string[];
  mocksAndFixturesAdded: string[];
  authBypassOrDemoIdentity?: string;
  blockedExternalServicesReplaced: string[];
  requiredLocalOnlyAssumptions: string[];
  knownLimitations: string[];
  appExplorationHints: string[];
  scriptGenerationContext: string[];
  validationEvidence: string[];
  cleanupAndReproInstructions: string[];
};

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
};

type AppMapRoute = {
  path: string;
  title?: string;
  headings: string[];
  text: string[];
  primaryNavigation?: string[];
  buttons: string[];
  links: string[];
  forms: string[];
  inputs: string[];
  stableLocatorCandidates?: string[];
  screenshots: string[];
  snapshotPath?: string;
};

export type AppMap = {
  id: string;
  baseUrl: string;
  discoveredRoutes: AppMapRoute[];
  routeTitles: Record<string, string>;
  primaryNavigation: string[];
  buttons: string[];
  links: string[];
  forms: string[];
  inputs: string[];
  stableLocatorCandidates: string[];
  appStateAssumptions: string[];
  loginOrAuthWalls: string[];
  consoleErrors: string[];
  pageErrors: string[];
  networkAttempts?: NetworkAttempt[];
  blockedNetworkAttempts: NetworkAttempt[];
  screenshots?: string[];
  accessibilitySnapshots: string[];
  candidateFlows: string[];
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
  route: string;
  kind: "assert" | "click" | "fill" | "navigate" | "select" | "upload" | "wait";
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

export type FlowSpec = {
  id: string;
  objective: string;
  selectedFlowName: string;
  whySelected: string;
  userDemoBriefFeaturesCovered: string[];
  steps: string[];
  referencedAppMapRoutePaths: string[];
  referencedActionIds: string[];
  expectedVisibleAssertions: string[];
  requiredAppState: string[];
  skippedOrBlockedFlows: Array<{ flow: string; reason: string }>;
  locatorStrategyNotes: string[];
  repairConstraints: string[];
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
      | "runtime-locked"
      | "runtime-unlocked";
  }>;
  artifactPaths: Record<string, string>;
  finalStatus: "failed" | "passed" | "unsupported";
  unsupportedOrFailureReason?: string;
};

export function readRepoProfile(value: unknown): RepoProfile {
  const record = assertRecord(value, "RepoProfile");
  return {
    authHints: readStringArray(record, "authHints"),
    candidateAppDirs: readStringArray(record, "candidateAppDirs"),
    candidateBuildCommands: readStringArray(record, "candidateBuildCommands"),
    candidateInstallCommands: readStringArray(
      record,
      "candidateInstallCommands",
    ),
    candidatePorts: readPortArray(record, "candidatePorts"),
    candidateStartCommands: readStringArray(record, "candidateStartCommands"),
    ...optionalString(record, "commitSha"),
    confidence: readConfidence(record.confidence),
    detectedFrameworks: readStringArray(record, "detectedFrameworks"),
    dockerHints: readStringArray(record, "dockerHints"),
    envExamples: readStringArray(record, "envExamples"),
    externalServiceHints: readStringArray(record, "externalServiceHints"),
    lockfiles: readStringArray(record, "lockfiles"),
    packageManager: readEnum(record, "packageManager", [
      "bun",
      "npm",
      "pnpm",
      "unknown",
      "yarn",
    ]),
    packageScripts: readStringRecord(record, "packageScripts"),
    repoUrl: readNonEmptyString(record, "repoUrl"),
    requiredEnvHints: readStringArray(record, "requiredEnvHints"),
    rootDir: readNonEmptyString(record, "rootDir"),
    securityWarnings: readStringArray(record, "securityWarnings"),
    unsupportedReasons: readStringArray(record, "unsupportedReasons"),
    workspaces: readWorkspaces(record.workspaces),
  };
}

export function readRunPlan(value: unknown): RunPlan {
  const record = assertRecord(value, "RunPlan");
  return {
    allowedPorts: readPortArray(record, "allowedPorts"),
    appDir: readRepoRelativePath(record, "appDir"),
    assumptions: readStringArray(record, "assumptions"),
    ...optionalStringKey(record, "buildCommand"),
    env: readStringRecord(record, "env"),
    expectedLocalUrl: readLocalHttpUrl(record, "expectedLocalUrl"),
    installCommand: readNonEmptyString(record, "installCommand"),
    localServices: readStringArray(record, "localServices"),
    riskFlags: readStringArray(record, "riskFlags"),
    runtime: readEnum(record, "runtime", ["bun", "deno", "node", "unknown"]),
    startCommand: readNonEmptyString(record, "startCommand"),
    validationExpectations: readStringArray(record, "validationExpectations"),
  };
}

export function readPreparationManifest(value: unknown): PreparationManifest {
  const record = assertRecord(value, "PreparationManifest");
  assertValidPreparationManifestFields(record);
  return {
    appDir: readRepoRelativePath(record, "appDir"),
    appExplorationHints: readStringArray(record, "appExplorationHints"),
    ...optionalStringKey(record, "authBypassOrDemoIdentity"),
    baseUrl: readLocalHttpUrl(record, "baseUrl"),
    blockedExternalServicesReplaced: readStringArray(
      record,
      "blockedExternalServicesReplaced",
    ),
    ...optionalStringKey(record, "buildCommandUsed"),
    cleanupAndReproInstructions: readStringArray(
      record,
      "cleanupAndReproInstructions",
    ),
    createdFiles: readStringArray(record, "createdFiles"),
    envUsed: readStringRecord(record, "envUsed"),
    id: readNonEmptyString(record, "id"),
    installCommandUsed: readNonEmptyString(record, "installCommandUsed"),
    knownLimitations: readStringArray(record, "knownLimitations"),
    localDemoModeChanges: readStringArray(record, "localDemoModeChanges"),
    mocksAndFixturesAdded: readStringArray(record, "mocksAndFixturesAdded"),
    modifiedFiles: readStringArray(record, "modifiedFiles"),
    ports: readPortArray(record, "ports"),
    requiredLocalOnlyAssumptions: readStringArray(
      record,
      "requiredLocalOnlyAssumptions",
    ),
    scriptGenerationContext: readStringArray(record, "scriptGenerationContext"),
    startCommandUsed: readNonEmptyString(record, "startCommandUsed"),
    validationEvidence: readStringArray(record, "validationEvidence"),
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
    () => readStringArray(record, "createdFiles"),
    () => readStringArray(record, "modifiedFiles"),
    () => readStringArray(record, "mocksAndFixturesAdded"),
    ...(record.authBypassOrDemoIdentity === undefined
      ? []
      : [() => readNonEmptyString(record, "authBypassOrDemoIdentity")]),
    () => readStringArray(record, "blockedExternalServicesReplaced"),
    () => readStringArray(record, "requiredLocalOnlyAssumptions"),
    () => readStringArray(record, "knownLimitations"),
    () => readStringArray(record, "appExplorationHints"),
    () => readStringArray(record, "scriptGenerationContext"),
    () => readStringArray(record, "validationEvidence"),
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

export function readValidationReport(value: unknown): ValidationReport {
  const record = assertRecord(value, "ValidationReport");
  return {
    artifactReferences: readStringArray(record, "artifactReferences"),
    ...optionalStringKey(record, "attemptedCommand"),
    blockedNetworkAttempts: readNetworkAttempts(
      record,
      "blockedNetworkAttempts",
    ),
    browserObservations: readStringArray(record, "browserObservations"),
    consoleErrors: readStringArray(record, "consoleErrors"),
    ...optionalNumberKey(record, "exitCode"),
    ...optionalStringKey(record, "failureClassification"),
    logsSummary: readNonEmptyString(record, "logsSummary"),
    networkAttempts: readNetworkAttempts(record, "networkAttempts"),
    pageErrors: readStringArray(record, "pageErrors"),
    retryCount: readNonNegativeInteger(record, "retryCount"),
    screenshots: readStringArray(record, "screenshots"),
    stage: readNonEmptyString(record, "stage"),
    status: readEnum(record, "status", ["failed", "passed"]),
    stderrExcerpts: readStringArray(record, "stderrExcerpts"),
    stdoutExcerpts: readStringArray(record, "stdoutExcerpts"),
    suggestedRepairHints: readStringArray(record, "suggestedRepairHints"),
    ...optionalLocalUrlKey(record, "urlChecked"),
  };
}

export function readAppMap(value: unknown): AppMap {
  const record = assertRecord(value, "AppMap");
  return {
    accessibilitySnapshots: readStringArray(record, "accessibilitySnapshots"),
    ...optionalStringKey(record, "actionCatalogId"),
    appStateAssumptions: readStringArray(record, "appStateAssumptions"),
    baseUrl: readLocalHttpUrl(record, "baseUrl"),
    blockedNetworkAttempts: readNetworkAttempts(
      record,
      "blockedNetworkAttempts",
    ),
    buttons: readStringArray(record, "buttons"),
    candidateFlows: readStringArray(record, "candidateFlows"),
    consoleErrors: readStringArray(record, "consoleErrors"),
    discoveredRoutes: readRoutes(record.discoveredRoutes),
    forms: readStringArray(record, "forms"),
    id: readNonEmptyString(record, "id"),
    inputs: readStringArray(record, "inputs"),
    links: readStringArray(record, "links"),
    loginOrAuthWalls: readStringArray(record, "loginOrAuthWalls"),
    ...(record.networkAttempts === undefined
      ? {}
      : { networkAttempts: readNetworkAttempts(record, "networkAttempts") }),
    pageErrors: readStringArray(record, "pageErrors"),
    primaryNavigation: readStringArray(record, "primaryNavigation"),
    routeTitles: readStringRecord(record, "routeTitles"),
    ...(record.screenshots === undefined
      ? {}
      : { screenshots: readStringArray(record, "screenshots") }),
    stableLocatorCandidates: readStringArray(record, "stableLocatorCandidates"),
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
  const steps = readStringArray(record, "steps");
  if (steps.length === 0) {
    throw new Error("steps must be a non-empty array");
  }
  return {
    expectedVisibleAssertions: readStringArray(
      record,
      "expectedVisibleAssertions",
    ),
    id: readNonEmptyString(record, "id"),
    locatorStrategyNotes: readStringArray(record, "locatorStrategyNotes"),
    objective: readNonEmptyString(record, "objective"),
    referencedActionIds: readStringArray(record, "referencedActionIds"),
    referencedAppMapRoutePaths: readStringArray(
      record,
      "referencedAppMapRoutePaths",
    ),
    repairConstraints: readStringArray(record, "repairConstraints"),
    requiredAppState: readStringArray(record, "requiredAppState"),
    selectedFlowName: readNonEmptyString(record, "selectedFlowName"),
    skippedOrBlockedFlows: readSkippedFlows(record.skippedOrBlockedFlows),
    steps,
    userDemoBriefFeaturesCovered: readStringArray(
      record,
      "userDemoBriefFeaturesCovered",
    ),
    whySelected: readNonEmptyString(record, "whySelected"),
  };
}

export function readDemoScriptContract(value: unknown): DemoScriptContract {
  const record = assertRecord(value, "DemoScriptContract");
  if (!Array.isArray(record.examples) || record.examples.length === 0) {
    throw new Error("examples must be a non-empty array");
  }
  return {
    allowedCaptureSdkActions: readStringArray(
      record,
      "allowedCaptureSdkActions",
    ),
    baseUrlBinding: readNonEmptyString(record, "baseUrlBinding"),
    browserContextOwnership: readNonEmptyString(
      record,
      "browserContextOwnership",
    ),
    captureSdkVersion: readNonEmptyString(record, "captureSdkVersion"),
    contractVersion: readNonEmptyString(record, "contractVersion"),
    examples: record.examples,
    forbiddenApis: readStringArray(record, "forbiddenApis"),
    forbiddenExternalUrls: readBoolean(record, "forbiddenExternalUrls"),
    forbiddenFields: readStringArray(record, "forbiddenFields"),
    jsonSchema: assertRecord(record.jsonSchema, "jsonSchema"),
    networkRestrictions: readStringArray(record, "networkRestrictions"),
    outputPath: readDemoScriptOutputPath(record, "outputPath"),
    requiredAssertions: readStringArray(record, "requiredAssertions"),
    requiredJsonShape: readStringArray(record, "requiredJsonShape"),
    requiredMetadata: readStringArray(record, "requiredMetadata"),
    timingConventions: readStringArray(record, "timingConventions"),
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
    ...optionalString(record, "commitSha"),
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
    ...optionalStringKey(record, "unsupportedOrFailureReason"),
  };
}

function readConfidence(value: unknown): RepoProfile["confidence"] {
  const record = assertRecord(value, "confidence");
  return {
    assumptions: readStringArray(record, "assumptions"),
    overall: readConfidenceNumber(record, "overall"),
  };
}

function readWorkspaces(value: unknown): RepoProfile["workspaces"] {
  const record = assertRecord(value, "workspaces");
  return {
    isMonorepo: readBoolean(record, "isMonorepo"),
    packageDirectories: readStringArray(record, "packageDirectories"),
  };
}

function readRoutes(value: unknown): AppMapRoute[] {
  const routes = readArray(value, "discoveredRoutes", (route, index) => {
    const path = `discoveredRoutes[${index}]`;
    const record = assertRecord(route, path);
    return {
      buttons: readStringArray(record, "buttons", path),
      forms: readStringArray(record, "forms", path),
      headings: readStringArray(record, "headings", path),
      inputs: readStringArray(record, "inputs", path),
      links: readStringArray(record, "links", path),
      path: readNonEmptyString(record, "path", path),
      ...(record.primaryNavigation === undefined
        ? {}
        : {
            primaryNavigation: readStringArray(
              record,
              "primaryNavigation",
              path,
            ),
          }),
      screenshots: readStringArray(record, "screenshots", path),
      ...(record.snapshotPath === undefined
        ? {}
        : { snapshotPath: readNonEmptyString(record, "snapshotPath", path) }),
      ...(record.stableLocatorCandidates === undefined
        ? {}
        : {
            stableLocatorCandidates: readStringArray(
              record,
              "stableLocatorCandidates",
              path,
            ),
          }),
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
    expectedResult: readNonEmptyString(record, "expectedResult", path),
    ...(record.fallbackLocator === undefined
      ? {}
      : {
          fallbackLocator: readNonEmptyString(record, "fallbackLocator", path),
        }),
    id: readNonEmptyString(record, "id", path),
    kind: readEnum(
      record,
      "kind",
      ["assert", "click", "fill", "navigate", "select", "upload", "wait"],
      path,
    ),
    ...(locatorCandidates === undefined ? {} : { locatorCandidates }),
    preferredLocator: readPreferredLocator(record.preferredLocator, path),
    ...(preferredLocatorCandidateId === undefined
      ? {}
      : { preferredLocatorCandidateId }),
    risks: readStringArray(record, "risks", path),
    route: readNonEmptyString(record, "route", path),
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
          route: readNonEmptyString(verification, "route", verificationPath),
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

function readSkippedFlows(value: unknown): FlowSpec["skippedOrBlockedFlows"] {
  return readArray(value, "skippedOrBlockedFlows", (entry, index) => {
    const path = `skippedOrBlockedFlows[${index}]`;
    const record = assertRecord(entry, path);
    return {
      flow: readNonEmptyString(record, "flow", path),
      reason: readNonEmptyString(record, "reason", path),
    };
  });
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
      host: readNonEmptyString(attempt, "host", path),
      phase: readEnum(
        attempt,
        "phase",
        ["browser", "dependency-install", "runtime"],
        path,
      ),
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
    ...optionalStringKey(record, "agent"),
    ...optionalStringKey(record, "submittedCode"),
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
          "runtime-unlocked",
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

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
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
  const path = parentPath ? `${parentPath}.${key}` : key;
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

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
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
  const path = parentPath ? `${parentPath}.${key}` : key;
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
  const path = parentPath ? `${parentPath}.${key}` : key;
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

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): boolean {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function readConfidenceNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): number {
  const value = readNonNegativeNumber(record, key, parentPath);
  if (value > 1) {
    const path = parentPath ? `${parentPath}.${key}` : key;
    throw new Error(`${path} must be between 0 and 1`);
  }
  return value;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): number {
  const path = parentPath ? `${parentPath}.${key}` : key;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = readNonNegativeNumber(record, key);
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
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
  const path = parentPath ? `${parentPath}.${key}` : key;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return record[key] === undefined
    ? {}
    : { [key]: readNonEmptyString(record, key) };
}

function optionalStringKey<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  return record[key] === undefined
    ? {}
    : ({ [key]: readNonEmptyString(record, key) } as Partial<
        Record<K, string>
      >);
}

function optionalNumberKey<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  return record[key] === undefined
    ? {}
    : ({ [key]: readNonNegativeNumber(record, key) } as Partial<
        Record<K, number>
      >);
}

function optionalLocalUrlKey<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  return record[key] === undefined
    ? {}
    : ({ [key]: readLocalHttpUrl(record, key) } as Partial<Record<K, string>>);
}

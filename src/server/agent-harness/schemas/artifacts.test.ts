import { describe, expect, it } from "vitest";
import {
  DEMO_SCRIPT_OUTPUT_PATH,
  readActionCatalog,
  readAppMap,
  readDemoScriptContract,
  readFlowSpec,
  readPipelineRunManifest,
  readPreparationManifest,
  readRepoProfile,
  readRunPlan,
  readScriptCandidate,
  readValidationReport,
} from "./artifacts";

describe("agent harness artifact schemas", () => {
  it("accepts the complete core artifact set used as durable stage handoffs", () => {
    const repoProfile = readRepoProfile(validRepoProfile());
    const runPlan = readRunPlan(validRunPlan());
    const preparationManifest = readPreparationManifest(
      validPreparationManifest(),
    );
    const validationReport = readValidationReport(validValidationReport());
    const appMap = readAppMap(validAppMap());
    const actionCatalog = readActionCatalog(validActionCatalog());
    const flowSpec = readFlowSpec(validFlowSpec());
    const contract = readDemoScriptContract(validDemoScriptContract());
    const scriptCandidate = readScriptCandidate(validScriptCandidate());
    const pipelineRunManifest = readPipelineRunManifest(
      validPipelineRunManifest(),
    );

    expect(repoProfile.repoUrl).toBe("https://github.com/example/app");
    expect(runPlan.expectedLocalUrl).toBe("http://127.0.0.1:3000");
    expect(preparationManifest.baseUrl).toBe("http://127.0.0.1:3000");
    expect(validationReport.stage).toBe("preparation-preflight");
    expect(validationReport.blockedNetworkAttempts[0]?.route).toBe(
      "http://127.0.0.1:3000/dashboard",
    );
    expect(appMap.discoveredRoutes[0]?.path).toBe("/");
    expect(actionCatalog.actions[0]?.kind).toBe("click");
    expect(flowSpec.referencedActionIds).toEqual(["open-dashboard"]);
    expect(contract.outputPath).toBe(DEMO_SCRIPT_OUTPUT_PATH);
    expect(scriptCandidate.sourceFlowSpecId).toBe("flow_001");
    expect(pipelineRunManifest.stageStatuses["script-writing"]).toBe("passed");
  });

  it("rejects artifacts that would break downstream validation boundaries", () => {
    expect(() =>
      readRunPlan({ ...validRunPlan(), expectedLocalUrl: "https://app.test" }),
    ).toThrow("expectedLocalUrl must be a local http URL");

    expect(() =>
      readPreparationManifest({
        ...validPreparationManifest(),
        baseUrl: "http://example.com",
      }),
    ).toThrow("baseUrl must be a local http URL");

    expect(() =>
      readPreparationManifest({
        ...validPreparationManifest(),
        appDir: "/workspace/repo",
      }),
    ).toThrow("appDir must be a relative path within /workspace/repo");

    expect(() =>
      readDemoScriptContract({
        ...validDemoScriptContract(),
        outputPath: "/tmp/demo-script.json",
      }),
    ).toThrow("outputPath must be /workspace/.makeademo/demo-script.json");

    expect(() =>
      readScriptCandidate({
        ...validScriptCandidate(),
        outputPath: "/workspace/demo-script.json",
      }),
    ).toThrow("outputPath must be /workspace/.makeademo/demo-script.json");

    expect(() => readFlowSpec({ ...validFlowSpec(), steps: [] })).toThrow(
      "steps must be a non-empty array",
    );
  });

  it("reports every invalid Preparation Manifest field in one pass", () => {
    expect(() =>
      readPreparationManifest({
        ...validPreparationManifest(),
        localDemoModeChanges: "enabled demo mode",
        scriptGenerationContext: { command: "npm run dev" },
      }),
    ).toThrow(
      "PreparationManifest validation failed: localDemoModeChanges must be an array; scriptGenerationContext must be an array",
    );
  });
});

function validRepoProfile() {
  return {
    authHints: ["clerk dependency"],
    candidateAppDirs: ["."],
    candidateBuildCommands: ["bun run build"],
    candidateInstallCommands: ["bun install --frozen-lockfile"],
    candidatePorts: [3000],
    candidateStartCommands: ["bun run dev --host 127.0.0.1 --port 3000"],
    commitSha: "abc123",
    confidence: { assumptions: ["Vite app"], overall: 0.83 },
    detectedFrameworks: ["vite", "react"],
    dockerHints: [],
    envExamples: [".env.example"],
    externalServiceHints: ["stripe"],
    lockfiles: ["bun.lock"],
    packageManager: "bun",
    packageScripts: { build: "vite build", dev: "vite" },
    repoUrl: "https://github.com/example/app",
    requiredEnvHints: ["DATABASE_URL"],
    rootDir: "/workspace",
    securityWarnings: ["postinstall script"],
    unsupportedReasons: [],
    workspaces: { isMonorepo: false, packageDirectories: [] },
  };
}

function validRunPlan() {
  return {
    allowedPorts: [3000],
    appDir: ".",
    assumptions: ["Vite serves on 3000"],
    buildCommand: "bun run build",
    env: { NODE_ENV: "development", VITE_MAKEADEMO_DEMO: "true" },
    expectedLocalUrl: "http://127.0.0.1:3000",
    installCommand: "bun install --frozen-lockfile",
    localServices: [],
    riskFlags: ["uses auth package"],
    runtime: "bun",
    startCommand: "bun run dev --host 127.0.0.1 --port 3000",
    validationExpectations: ["main heading visible"],
  };
}

function validPreparationManifest() {
  return {
    appDir: ".",
    appExplorationHints: ["Visit /dashboard"],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: ["stripe"],
    buildCommandUsed: "bun run build",
    cleanupAndReproInstructions: ["bun run dev --host 127.0.0.1 --port 3000"],
    createdFiles: ["makeademo.demo.ts"],
    envUsed: { NODE_ENV: "development", VITE_MAKEADEMO_DEMO: "true" },
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: ["payments are mocked"],
    localDemoModeChanges: ["seed dashboard data"],
    mocksAndFixturesAdded: ["stripe fixture"],
    modifiedFiles: ["src/demo.ts"],
    ports: [3000],
    requiredLocalOnlyAssumptions: ["no external APIs"],
    scriptGenerationContext: ["Demo dashboard onboarding"],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
    validationEvidence: ["preflight passed"],
  };
}

function validValidationReport() {
  return {
    artifactReferences: ["preparation-preflight.json"],
    attemptedCommand: "bun run dev --host 127.0.0.1 --port 3000",
    blockedNetworkAttempts: [
      {
        direction: "outbound",
        host: "api.example.com",
        phase: "runtime",
        route: "http://127.0.0.1:3000/dashboard",
      },
    ],
    browserObservations: ["Dashboard loaded"],
    consoleErrors: [],
    exitCode: 0,
    failureClassification: "none",
    logsSummary: "Preflight passed",
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: ["screenshots/base.png"],
    stage: "preparation-preflight",
    status: "passed",
    stderrExcerpts: [],
    stdoutExcerpts: ["ready"],
    suggestedRepairHints: [],
    urlChecked: "http://127.0.0.1:3000",
  };
}

function validAppMap() {
  return {
    accessibilitySnapshots: ["snapshots/root.yml"],
    actionCatalogId: "actions_001",
    appStateAssumptions: ["demo user is signed in"],
    baseUrl: "http://127.0.0.1:3000",
    blockedNetworkAttempts: [],
    buttons: ["Open dashboard"],
    candidateFlows: ["Open dashboard"],
    consoleErrors: [],
    discoveredRoutes: [
      {
        buttons: ["Open dashboard"],
        forms: [],
        headings: ["Welcome"],
        inputs: [],
        links: ["/dashboard"],
        path: "/",
        screenshots: ["screenshots/root.png"],
        snapshotPath: "snapshots/root.yml",
        text: ["Welcome"],
        title: "Home",
      },
    ],
    forms: [],
    id: "appmap_001",
    inputs: [],
    links: ["/dashboard"],
    loginOrAuthWalls: [],
    pageErrors: [],
    primaryNavigation: ["Dashboard"],
    routeTitles: { "/": "Home" },
    stableLocatorCandidates: ["role=button[name='Open dashboard']"],
  };
}

function validActionCatalog() {
  return {
    actions: [
      {
        confidence: 0.9,
        evidence: "button name in accessibility snapshot",
        expectedResult: "Dashboard route opens",
        fallbackLocator: "text=Open dashboard",
        id: "open-dashboard",
        kind: "click",
        preferredLocator: {
          name: "Open dashboard",
          strategy: "role",
          value: "button",
        },
        risks: [],
        route: "/",
      },
    ],
    appMapId: "appmap_001",
    id: "actions_001",
  };
}

function validFlowSpec() {
  return {
    expectedVisibleAssertions: ["Dashboard heading is visible"],
    id: "flow_001",
    objective: "Show dashboard onboarding",
    referencedActionIds: ["open-dashboard"],
    referencedAppMapRoutePaths: ["/", "/dashboard"],
    repairConstraints: ["Do not remove dashboard assertion"],
    requiredAppState: ["demo user"],
    selectedFlowName: "Dashboard onboarding",
    skippedOrBlockedFlows: [{ flow: "Billing", reason: "Stripe is mocked" }],
    steps: ["Open the dashboard", "Show the dashboard heading"],
    userDemoBriefFeaturesCovered: ["dashboard"],
    whySelected: "The route is visible and local",
    locatorStrategyNotes: ["Prefer role locators"],
  };
}

function validDemoScriptContract() {
  return {
    allowedCaptureSdkActions: ["setup", "scene", "page.goto", "locator.click"],
    baseUrlBinding: "Capture SDK context baseUrl",
    browserContextOwnership: "MakeADemo owns browser and context",
    contractVersion: "2026-07-08",
    forbiddenApis: ["fetch", "XMLHttpRequest", "WebSocket"],
    forbiddenExternalUrls: true,
    forbiddenFields: ["durationSeconds"],
    networkRestrictions: ["runtime network blocked"],
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    requiredAssertions: ["visible Playwright assertion per scene"],
    requiredJsonShape: ["scriptId", "demoPlaywrightScript", "scenes"],
    requiredMetadata: ["title", "format", "presentation"],
    timingConventions: ["bounded waits only"],
  };
}

function validScriptCandidate() {
  return {
    assumptions: ["dashboard available"],
    captureSdkVersion: "generated",
    conformanceResult: validValidationReport(),
    contractVersion: "2026-07-08",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    scriptJsonContent: { scriptId: "script_001" },
    sourceAppMapId: "appmap_001",
    sourceFlowSpecId: "flow_001",
    sourcePreparationManifestId: "prep_001",
    unsupportedPieces: [],
    validationArtifacts: ["static-contract-report.json"],
  };
}

function validPipelineRunManifest() {
  return {
    artifactPaths: {
      appMap: "/workspace/.makeademo/app-map.json",
      demoScript: DEMO_SCRIPT_OUTPUT_PATH,
      flowSpec: "/workspace/.makeademo/flow-spec.json",
      preparationManifest: "/workspace/.makeademo/preparation-manifest.json",
    },
    commitSha: "abc123",
    daytonaSandboxIds: {
      agent: "sandbox_agent",
      submittedCode: "sandbox_submitted",
    },
    finalStatus: "passed",
    networkStateTransitions: [
      {
        at: "2026-07-08T10:00:00.000Z",
        state: "dependency-install-open",
      },
      { at: "2026-07-08T10:01:00.000Z", state: "runtime-locked" },
    ],
    opencodeSessionIds: ["session_prepare"],
    repoUrl: "https://github.com/example/app",
    runId: "run_001",
    stageStatuses: {
      "script-writing": "passed",
    },
    stageTimings: [
      {
        durationMs: 1000,
        finishedAt: "2026-07-08T10:00:01.000Z",
        stage: "repo-profile",
        startedAt: "2026-07-08T10:00:00.000Z",
      },
    ],
  };
}

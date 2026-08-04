import { describe, expect, it } from "vitest";
import {
  DEMO_SCRIPT_OUTPUT_PATH,
  readActionCatalog,
  readAppMap,
  readFlowSpec,
  readPipelineRunManifest,
  readPreparationManifest,
  readRunPlan,
  readScriptCandidate,
  readValidationReport,
} from "./artifacts";

describe("agent harness artifact schemas", () => {
  it("accepts the complete core artifact set used as durable stage handoffs", () => {
    const runPlan = readRunPlan(validRunPlan());
    const preparationManifest = readPreparationManifest(
      validPreparationManifest(),
    );
    const validationReport = readValidationReport(validValidationReport());
    const appMap = readAppMap(validAppMap());
    const actionCatalog = readActionCatalog(validActionCatalog());
    const flowSpec = readFlowSpec(validFlowSpec());
    const scriptCandidate = readScriptCandidate(validScriptCandidate());
    const pipelineRunManifest = readPipelineRunManifest(
      validPipelineRunManifest(),
    );

    expect(runPlan.expectedLocalUrl).toBe("http://127.0.0.1:3000");
    expect(preparationManifest.baseUrl).toBe("http://127.0.0.1:3000");
    expect(validationReport.stage).toBe("preparation-preflight");
    expect(validationReport.blockedNetworkAttempts[0]?.route).toBe(
      "http://127.0.0.1:3000/dashboard",
    );
    expect(validationReport.runtimeProbe?.attempts[0]).toMatchObject({
      attempt: 1,
      outcome: "responded",
      process: { running: true },
    });
    expect(appMap.discoveredRoutes[0]?.path).toBe("/");
    expect(actionCatalog.actions[0]?.kind).toBe("click");
    expect(flowSpec.features[0]?.referencedActionIds).toEqual([
      "open-dashboard",
    ]);
    expect(scriptCandidate.sourceFlowSpecId).toBe("flow_001");
    expect(scriptCandidate.browserActionCompilerVersion).toBe("2026-07-18.1");
    expect(scriptCandidate.bunRuntimeVersion).toBe("1.3.14");
    expect(scriptCandidate.playwrightRuntimeVersion).toBe("1.60.0");
    expect(pipelineRunManifest.stageStatuses["script-writing"]).toBe("passed");
  });

  it("preserves the reason when a non-semantic action locator is parsed again", () => {
    const catalog = validActionCatalog();
    const parsed = readActionCatalog({
      ...catalog,
      actions: catalog.actions.map((action, index) =>
        index === 0
          ? {
              ...action,
              preferredLocator: {
                reason:
                  "Navigation targets the observed page body rather than an element.",
                strategy: "css",
                value: "body",
              },
            }
          : action,
      ),
    });
    const reparsed = readActionCatalog(parsed);

    expect(reparsed.actions[0]?.preferredLocator.reason).toBe(
      "Navigation targets the observed page body rather than an element.",
    );
  });

  it("rejects an Action Catalog preferred locator that lacks verified evidence", () => {
    const catalog = validActionCatalog();
    const action = catalog.actions[0];
    if (action === undefined) {
      throw new Error("Expected an Action Catalog fixture");
    }

    expect(() =>
      readActionCatalog({
        ...catalog,
        actions: [
          {
            ...action,
            locatorCandidates: [
              {
                id: "open-dashboard-locator-1",
                locator: {
                  name: "Open dashboard",
                  role: "button",
                  strategy: "role",
                },
                verification: {
                  matchCount: 1,
                  route: "/",
                  visible: true,
                },
              },
            ],
            preferredLocatorCandidateId: "missing-locator",
          },
        ],
      }),
    ).toThrow(
      "actions[0].preferredLocatorCandidateId must reference locatorCandidates",
    );
  });

  it("does not label navigation as a browser-exercised feature interaction", () => {
    const catalog = validActionCatalog();
    expect(() =>
      readActionCatalog({
        ...catalog,
        actions: catalog.actions.map((action) => ({
          ...action,
          exercised: true,
          kind: "navigate",
        })),
      }),
    ).toThrow(/exercised is only valid for feature interactions/);
  });

  it("rejects artifacts that would break downstream validation boundaries", () => {
    expect(() =>
      readRunPlan({ ...validRunPlan(), expectedLocalUrl: "https://app.test" }),
    ).toThrow("expectedLocalUrl must be a local http URL");

    expect(() =>
      readRunPlan({
        ...validRunPlan(),
        appDir: "apps/website",
        targetSelection: {
          evidencePaths: ["apps/dashboard/src/app/page.tsx"],
          reason: "The dashboard is the product.",
          role: "product",
          source: "model",
          targetId: "apps/dashboard",
        },
      }),
    ).toThrow("targetSelection.targetId must match appDir");

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
      readScriptCandidate({
        ...validScriptCandidate(),
        outputPath: "/workspace/demo-script.json",
      }),
    ).toThrow("outputPath must be /workspace/.makeademo/demo-script.json");

    const { captureSdkVersion: _captureSdkVersion, ...unversionedCandidate } =
      validScriptCandidate();
    expect(() => readScriptCandidate(unversionedCandidate)).toThrow(
      "captureSdkVersion must be a non-empty string",
    );

    const invalidFlowSpec = validFlowSpec();
    const firstFeature = invalidFlowSpec.features[0];
    if (firstFeature === undefined) {
      throw new Error("Expected a FlowSpec feature fixture");
    }
    firstFeature.steps = [];
    expect(() => readFlowSpec(invalidFlowSpec)).toThrow(
      "features[0] must contain non-empty steps",
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

  it("reports every invalid feature inventory field in one pass", () => {
    const manifest = validPreparationManifest();
    const feature = manifest.productContext.featureInventory[0];
    if (feature === undefined) {
      throw new Error("Expected a prepared feature fixture");
    }
    feature.authStrategy = "not-required";
    Reflect.deleteProperty(feature, "description");
    Reflect.deleteProperty(feature, "fixtureNotes");
    Reflect.deleteProperty(feature, "label");

    expect(() => readPreparationManifest(manifest)).toThrow(
      "productContext.featureInventory[0].authStrategy must be one of: bypass, demo-identity, none; productContext.featureInventory[0].description must be a non-empty string; productContext.featureInventory[0].fixtureNotes must be an array; productContext.featureInventory[0].label must be a non-empty string",
    );
  });

  it("rejects Script Candidates without the compiler and runtime versions that produced them", () => {
    const {
      browserActionCompilerVersion: _browserActionCompilerVersion,
      ...candidateWithoutCompilerVersion
    } = validScriptCandidate();

    expect(() => readScriptCandidate(candidateWithoutCompilerVersion)).toThrow(
      "browserActionCompilerVersion must be a non-empty string",
    );
  });
});

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
    envUsed: { NODE_ENV: "development", VITE_MAKEADEMO_DEMO: "true" },
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: ["payments are mocked"],
    localDemoModeChanges: ["seed dashboard data"],
    mocksAndFixturesAdded: ["stripe fixture"],
    ports: [3000],
    productContext: {
      evidencePaths: ["README.md"],
      featureInventory: [
        {
          authStrategy: "demo-identity",
          description: "Open the seeded dashboard.",
          entryPaths: ["/dashboard"],
          fixtureNotes: ["Seed a local account"],
          id: "dashboard",
          label: "Dashboard",
          requestedFeature: "dashboard",
          sourcePaths: ["src/demo.ts"],
        },
      ],
      name: "Demo Dashboard",
      summary: "A dashboard onboarding application.",
    },
    requiredLocalOnlyAssumptions: ["no external APIs"],
    scriptGenerationContext: ["Demo dashboard onboarding"],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
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
    runtimeProbe: {
      attempts: [
        {
          attempt: 1,
          durationMs: 125,
          exitCode: 0,
          outcome: "responded",
          process: { running: true },
          startedAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      finalUrl: "http://127.0.0.1:3000/dashboard",
      httpStatus: 200,
      targetUrl: "http://127.0.0.1:3000/dashboard",
    },
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
        featureIds: ["dashboard"],
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
    features: [
      {
        expectedVisibleAssertions: ["Dashboard heading is visible"],
        featureId: "dashboard",
        label: "Dashboard onboarding",
        referencedActionIds: ["open-dashboard"],
        referencedAppMapRoutePaths: ["/", "/dashboard"],
        requestedFeature: "dashboard",
        requiredAppState: ["demo user"],
        selectionReason: "The route is visible and local",
        steps: ["Open the dashboard", "Show the dashboard heading"],
      },
    ],
    id: "flow_001",
    repairConstraints: ["Do not remove dashboard assertion"],
    version: 2,
  };
}

function validScriptCandidate() {
  return {
    assumptions: ["dashboard available"],
    captureSdkVersion: "generated",
    browserActionCompilerVersion: "2026-07-18.1",
    bunRuntimeVersion: "1.3.14",
    conformanceResult: validValidationReport(),
    contractVersion: "2026-07-08",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    playwrightRuntimeVersion: "1.60.0",
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

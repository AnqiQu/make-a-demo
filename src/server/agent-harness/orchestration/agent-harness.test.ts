import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT_OUTPUT_PATH } from "../schemas/artifacts";
import { runAgentHarnessPipeline } from "./agent-harness";

describe("runAgentHarnessPipeline", () => {
  it("runs the artifact-driven pipeline in order and hands durable artifacts to each stage", async () => {
    const calls: string[] = [];
    const artifacts: Record<string, unknown> = {};

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_001",
      },
      {
        artifactStore: {
          async writeJson(path, value) {
            artifacts[path] = value;
          },
        },
        async createWorkspace() {
          calls.push("workspace");
          return workspace();
        },
        async exploreApp({ preparationManifest, preparationValidation }) {
          calls.push(
            `explore:${preparationManifest.id}:${preparationValidation.status}`,
          );
          return {
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport: report("app-exploration", "passed"),
          };
        },
        async planFlow({ actionCatalog: catalog, appMap: map }) {
          calls.push(`flow:${map.id}:${catalog.id}`);
          return flowSpec();
        },
        async prepareRepo({ repoProfile, runPlan }) {
          calls.push(
            `prepare:${repoProfile.packageManager}:${runPlan.installCommand}`,
          );
          return {
            manifest: preparationManifest(),
            opencodeSessionId: "session_prepare",
          };
        },
        async synthesizeRunPlan({ repoProfile }) {
          calls.push(`run-plan:${repoProfile.packageManager}`);
          return runPlan();
        },
        async validateCapturePath({ scriptCandidate }) {
          calls.push(`dynamic:${scriptCandidate.outputPath}`);
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest: manifest }) {
          calls.push(`preflight:${manifest.baseUrl}`);
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract({ scriptCandidate }) {
          calls.push(`static:${scriptCandidate.sourceFlowSpecId}`);
          return report("static-script-contract-validation", "passed");
        },
        async writeScript({ flowSpec: flow, preparationManifest: manifest }) {
          calls.push(`script:${flow.id}:${manifest.baseUrl}`);
          return scriptCandidate();
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "run-plan:bun",
      "workspace",
      "prepare:bun:bun install --frozen-lockfile",
      "preflight:http://127.0.0.1:3000",
      "explore:prep_001:passed",
      "flow:appmap_001:actions_001",
      "script:flow_001:http://127.0.0.1:3000",
      `static:${"flow_001"}`,
      `dynamic:${DEMO_SCRIPT_OUTPUT_PATH}`,
    ]);
    expect(result.pipelineRunManifest.stageStatuses).toMatchObject({
      "app-exploration": "passed",
      "capture-path-validation": "passed",
      "flow-planning": "passed",
      "repo-preparation": "passed",
      "script-writing": "passed",
      "static-repo-security-screen": "passed",
      "static-script-contract-validation": "passed",
    });
    expect(artifacts["/workspace/.makeademo/repo-profile.json"]).toMatchObject({
      packageManager: "bun",
    });
    expect(
      artifacts["/workspace/.makeademo/pipeline-run-manifest.json"],
    ).toMatchObject({
      finalStatus: "passed",
      opencodeSessionIds: ["session_prepare"],
    });
  });

  it("fails Script Writing when the diff contains app source edits", async () => {
    await expect(
      runAgentHarnessPipeline(
        {
          demoBrief: { keyProductFeatures: ["dashboard"] },
          files: [
            { path: "package.json", text: "{}" },
            { path: "bun.lock", text: "" },
          ],
          repoStats: { fileCount: 2, sizeBytes: 200 },
          repoUrl: "https://github.com/example/app",
          runId: "run_002",
        },
        {
          async captureWorkspaceDiff() {
            return ["/workspace/src/App.tsx"];
          },
          async createWorkspace() {
            return workspace();
          },
          async exploreApp() {
            return {
              actionCatalog: actionCatalog(),
              appMap: appMap(),
              validationReport: report("app-exploration", "passed"),
            };
          },
          async planFlow() {
            return flowSpec();
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async synthesizeRunPlan() {
            return runPlan();
          },
          async validateCapturePath() {
            return report("capture-path-validation", "passed");
          },
          async validatePreparation() {
            return report("preparation-preflight", "passed");
          },
          async validateScriptContract() {
            return report("static-script-contract-validation", "passed");
          },
          async writeScript() {
            return scriptCandidate();
          },
        },
      ),
    ).rejects.toThrow("Script Writing modified disallowed workspace paths");
  });
});

function workspace() {
  return {
    agentSandboxId: "agent_sandbox",
    async destroy() {
      return undefined;
    },
    async execute() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    submittedCodeSandboxId: "submitted_sandbox",
  };
}

function runPlan() {
  return {
    allowedPorts: [3000],
    appDir: ".",
    assumptions: [],
    env: {},
    expectedLocalUrl: "http://127.0.0.1:3000",
    installCommand: "bun install --frozen-lockfile",
    localServices: [],
    riskFlags: [],
    runtime: "bun" as const,
    startCommand: "bun run dev --host 127.0.0.1 --port 3000",
    validationExpectations: ["body visible"],
  };
}

function preparationManifest() {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    createdFiles: [],
    envUsed: {},
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    modifiedFiles: [],
    ports: [3000],
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
    validationEvidence: ["passed"],
  };
}

function appMap() {
  return {
    accessibilitySnapshots: ["snapshot.yml"],
    appStateAssumptions: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedNetworkAttempts: [],
    buttons: ["Open dashboard"],
    candidateFlows: ["Dashboard"],
    consoleErrors: [],
    discoveredRoutes: [
      {
        buttons: ["Open dashboard"],
        forms: [],
        headings: ["Home"],
        inputs: [],
        links: ["/dashboard"],
        path: "/",
        screenshots: [],
        text: ["Home"],
      },
    ],
    forms: [],
    id: "appmap_001",
    inputs: [],
    links: ["/dashboard"],
    loginOrAuthWalls: [],
    pageErrors: [],
    primaryNavigation: [],
    routeTitles: { "/": "Home" },
    stableLocatorCandidates: ["role=button[name='Open dashboard']"],
  };
}

function actionCatalog() {
  return {
    actions: [
      {
        confidence: 0.9,
        evidence: "snapshot",
        expectedResult: "Dashboard opens",
        id: "open-dashboard",
        kind: "click" as const,
        preferredLocator: {
          name: "Open dashboard",
          strategy: "role" as const,
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

function flowSpec() {
  return {
    expectedVisibleAssertions: ["Dashboard visible"],
    id: "flow_001",
    locatorStrategyNotes: [],
    objective: "Show dashboard",
    referencedActionIds: ["open-dashboard"],
    referencedAppMapRoutePaths: ["/"],
    repairConstraints: ["Preserve dashboard step"],
    requiredAppState: [],
    selectedFlowName: "Dashboard",
    skippedOrBlockedFlows: [],
    steps: ["Open dashboard"],
    userDemoBriefFeaturesCovered: ["dashboard"],
    whySelected: "Visible route",
  };
}

function scriptCandidate() {
  return {
    assumptions: [],
    conformanceResult: report("static-script-contract-validation", "passed"),
    contractVersion: "2026-07-08",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH as typeof DEMO_SCRIPT_OUTPUT_PATH,
    scriptJsonContent: { scriptId: "script_001" },
    sourceAppMapId: "appmap_001",
    sourceFlowSpecId: "flow_001",
    sourcePreparationManifestId: "prep_001",
    unsupportedPieces: [],
    validationArtifacts: [],
  };
}

function report(stage: string, status: "failed" | "passed") {
  return {
    artifactReferences: [],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    logsSummary: `${stage} ${status}`,
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage,
    status,
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: [],
  };
}

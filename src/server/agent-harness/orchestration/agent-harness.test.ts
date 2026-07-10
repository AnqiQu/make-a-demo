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
        async resetCaptureRuntime({ preparationManifest: manifest }) {
          calls.push(`reset:${manifest.id}`);
          return report("capture-runtime-reset", "passed");
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
      "reset:prep_001",
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
      networkStateTransitions: [
        { at: "2026-07-09T20:00:00.000Z", state: "dependency-install-open" },
        {
          at: "2026-07-09T20:00:01.000Z",
          state: "dependency-install-closed",
        },
        { at: "2026-07-09T20:00:01.000Z", state: "runtime-locked" },
      ],
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

  it("records async stage failures after the stage promise rejects", async () => {
    const artifacts: Record<string, unknown> = {};

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
          runId: "run_003",
        },
        {
          artifactStore: {
            async writeJson(path, value) {
              artifacts[path] = value;
            },
          },
          async createWorkspace() {
            return workspace();
          },
          async exploreApp() {
            throw new Error("App Exploration should not run.");
          },
          async planFlow() {
            throw new Error("Flow Planning should not run.");
          },
          async prepareRepo() {
            throw Object.assign(new Error("Repo clone failed."), {
              opencodeSessionId: "session_failed_prepare",
            });
          },
          async synthesizeRunPlan() {
            return runPlan();
          },
          async validateCapturePath() {
            throw new Error("Capture Path Validation should not run.");
          },
          async validatePreparation() {
            throw new Error("Preparation Preflight should not run.");
          },
          async validateScriptContract() {
            throw new Error("Static Script Contract should not run.");
          },
          async writeScript() {
            throw new Error("Script Writing should not run.");
          },
        },
      ),
    ).rejects.toThrow("Repo clone failed.");

    expect(
      artifacts["/workspace/.makeademo/pipeline-run-manifest.json"],
    ).toMatchObject({
      finalStatus: "failed",
      opencodeSessionIds: ["session_failed_prepare"],
      stageStatuses: {
        "agent-harness": "failed",
        "repo-preparation": "failed",
      },
      unsupportedOrFailureReason: "Repo clone failed.",
    });
  });

  it("feeds failed capture validation back through Script Repair and retries", async () => {
    const calls: string[] = [];
    let captureAttempts = 0;

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_repair",
      },
      {
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
        async repairScript({ failureReport }) {
          calls.push(`repair:${failureReport.logsSummary}`);
          return scriptCandidate();
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          captureAttempts += 1;
          calls.push(`dynamic:${captureAttempts}`);
          return captureAttempts === 1
            ? {
                ...report("capture-path-validation", "failed"),
                failureClassification: "locator failure",
                logsSummary: "Dashboard locator did not resolve",
              }
            : report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          calls.push("static");
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "static",
      "dynamic:1",
      "repair:Dashboard locator did not resolve",
      "static",
      "dynamic:2",
    ]);
    expect(result.validationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logsSummary: "Dashboard locator did not resolve",
          retryCount: 0,
        }),
        expect.objectContaining({
          stage: "capture-path-validation",
          status: "passed",
          retryCount: 1,
        }),
      ]),
    );
  });

  it("feeds failed runtime preflight back through Repo Preparation Repair", async () => {
    const calls: string[] = [];
    const artifactWrites: string[] = [];
    let preflightAttempts = 0;

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_preparation_repair",
      },
      {
        artifactStore: {
          async writeJson(path) {
            artifactWrites.push(path);
          },
        },
        async createWorkspace() {
          return workspace();
        },
        async exploreApp({ preparationManifest: manifest }) {
          calls.push(`explore:${manifest.id}`);
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
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.logsSummary}`);
          return {
            manifest: { ...preparationManifest(), id: "prep_repaired" },
          };
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest: manifest }) {
          preflightAttempts += 1;
          calls.push(`preflight:${manifest.id}`);
          return preflightAttempts === 1
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "start failure",
                logsSummary: "App exited before it became ready",
              }
            : report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: "prep_repaired",
          };
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(result.preparationManifest?.id).toBe("prep_repaired");
    expect(calls).toEqual([
      "preflight:prep_001",
      "repair:App exited before it became ready",
      "preflight:prep_repaired",
      "explore:prep_repaired",
    ]);
    expect(artifactWrites).toEqual(
      expect.arrayContaining([
        "/workspace/.makeademo/validation-attempts/preparation-preflight/attempt-1.json",
        "/workspace/.makeademo/validation-attempts/preparation-preflight/attempt-2.json",
      ]),
    );
  });

  it("rejects Script Repair when it mutates app source", async () => {
    let diffChecks = 0;

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
          runId: "run_repair_mutation",
        },
        {
          async captureWorkspaceDiff() {
            diffChecks += 1;
            return diffChecks === 1 ? [] : ["/workspace/repo/src/App.tsx"];
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
          async repairScript() {
            return scriptCandidate();
          },
          async synthesizeRunPlan() {
            return runPlan();
          },
          async validateCapturePath() {
            return {
              ...report("capture-path-validation", "failed"),
              failureClassification: "locator failure",
            };
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

  it("repairs preparation and re-explores when browser exploration finds external network", async () => {
    let explorationAttempts = 0;
    const calls: string[] = [];

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_exploration_repair",
      },
      {
        async createWorkspace() {
          return workspace();
        },
        async exploreApp({ preparationManifest: manifest }) {
          explorationAttempts += 1;
          calls.push(`explore:${manifest.id}`);
          return {
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport:
              explorationAttempts === 1
                ? {
                    ...report("app-exploration", "failed"),
                    failureClassification: "external network required",
                    logsSummary: "Blocked api.example.com",
                  }
                : report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.stage}`);
          return {
            manifest: { ...preparationManifest(), id: "prep_network_fixed" },
          };
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest: manifest }) {
          calls.push(`preflight:${manifest.id}`);
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: "prep_network_fixed",
          };
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "preflight:prep_001",
      "explore:prep_001",
      "repair:app-exploration",
      "preflight:prep_network_fixed",
      "explore:prep_network_fixed",
    ]);
  });

  it("allows three preparation repairs independently in preflight and app exploration", async () => {
    let explorationAttempts = 0;
    let preflightAttempts = 0;
    const repairStages: string[] = [];

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_phase_repair_budgets",
      },
      {
        async createWorkspace() {
          return workspace();
        },
        async exploreApp() {
          explorationAttempts += 1;
          return {
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport:
              explorationAttempts <= 3
                ? {
                    ...report("app-exploration", "failed"),
                    failureClassification: "external network attempted",
                    logsSummary: "Blocked external stylesheet",
                  }
                : report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
        async repairPreparation({ failureReport }) {
          repairStages.push(failureReport.stage);
          return {
            manifest: {
              ...preparationManifest(),
              id: `prep_repaired_${repairStages.length}`,
            },
          };
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          return preflightAttempts <= 3
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "start failure",
                logsSummary: "App is not ready",
              }
            : report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript({ preparationManifest: manifest }) {
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: manifest.id,
          };
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(repairStages).toEqual([
      "preparation-preflight",
      "preparation-preflight",
      "preparation-preflight",
      "app-exploration",
      "app-exploration",
      "app-exploration",
    ]);
  });

  it("allows three script repairs independently in static and capture validation", async () => {
    let captureAttempts = 0;
    let staticAttempts = 0;
    const repairStages: string[] = [];

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_phase_script_repair_budgets",
      },
      {
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
        async repairScript({ failureReport }) {
          repairStages.push(failureReport.stage);
          return scriptCandidate();
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          captureAttempts += 1;
          return captureAttempts <= 3
            ? {
                ...report("capture-path-validation", "failed"),
                failureClassification: "locator failure",
              }
            : report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          staticAttempts += 1;
          return staticAttempts <= 3
            ? {
                ...report("static-script-contract-validation", "failed"),
                failureClassification: "script contract failure",
              }
            : report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(repairStages).toEqual([
      "static-script-contract-validation",
      "static-script-contract-validation",
      "static-script-contract-validation",
      "capture-path-validation",
      "capture-path-validation",
      "capture-path-validation",
    ]);
  });

  it("repairs preparation and regenerates downstream artifacts after a runtime capture failure", async () => {
    let captureAttempts = 0;
    const calls: string[] = [];

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_capture_preparation_repair",
      },
      {
        async createWorkspace() {
          return workspace();
        },
        async exploreApp({ preparationManifest: manifest }) {
          calls.push(`explore:${manifest.id}`);
          return {
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport: report("app-exploration", "passed"),
          };
        },
        async planFlow({ preparationManifest: manifest }) {
          calls.push(`flow:${manifest.id}`);
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.stage}`);
          return {
            manifest: { ...preparationManifest(), id: "prep_capture_fixed" },
          };
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath({ preparationManifest: manifest }) {
          captureAttempts += 1;
          calls.push(`capture:${manifest.id}`);
          return captureAttempts === 1
            ? {
                ...report("capture-path-validation", "failed"),
                failureClassification: "external network required",
                logsSummary: "Runtime requested api.example.com",
              }
            : report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest: manifest }) {
          calls.push(`preflight:${manifest.id}`);
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript({ preparationManifest: manifest }) {
          calls.push(`script:${manifest.id}`);
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: manifest.id,
          };
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "preflight:prep_001",
      "explore:prep_001",
      "flow:prep_001",
      "script:prep_001",
      "capture:prep_001",
      "repair:capture-path-validation",
      "preflight:prep_capture_fixed",
      "explore:prep_capture_fixed",
      "flow:prep_capture_fixed",
      "script:prep_capture_fixed",
      "capture:prep_capture_fixed",
    ]);
  });
});

function workspace() {
  return {
    agentSandboxId: "agent_sandbox",
    async collectNetworkStateLog() {
      return [
        {
          at: "2026-07-09T20:00:00.000Z",
          state: "dependency-install-open" as const,
        },
        {
          at: "2026-07-09T20:00:01.000Z",
          state: "dependency-install-closed" as const,
        },
        {
          at: "2026-07-09T20:00:01.000Z",
          state: "runtime-locked" as const,
        },
      ];
    },
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

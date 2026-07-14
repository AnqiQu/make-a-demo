import { describe, expect, it } from "vitest";
import {
  AgentHarnessCommandTimeoutError,
  AgentHarnessSandboxUnavailableError,
} from "../daytona/workspace.interface";
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
        async capturePreparationWorkspaceDiff() {
          calls.push("preparation-diff");
          return preparationWorkspaceDiff();
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
            kind: "artifacts" as const,
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
      "preparation-diff",
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
      "preparation-fidelity": "passed",
      "script-writing": "passed",
      "static-repo-security-screen": "passed",
      "static-script-contract-validation": "passed",
    });
    expect(artifacts["/workspace/.makeademo/repo-profile.json"]).toMatchObject({
      packageManager: "bun",
    });
    expect(
      artifacts["/workspace/.makeademo/preparation-workspace-diff.json"],
    ).toMatchObject({
      changedPaths: ["/workspace/repo/src/demo.ts"],
      sourceCommitSha: "abc123def456",
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
              kind: "artifacts" as const,
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
          async resetCaptureRuntime() {
            return report("capture-runtime-reset", "passed");
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
          async resetCaptureRuntime() {
            return report("capture-runtime-reset", "passed");
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
    expect(
      artifacts["/workspace/.makeademo/preparation-fallback.json"],
    ).toMatchObject({
      blockers: [{ summary: "Repo clone failed." }],
      failedStage: "repo-preparation",
      repoUrl: "https://github.com/example/app",
      runId: "run_003",
    });
  });

  it.each([
    [
      "an agent timeout",
      new AgentHarnessCommandTimeoutError(300_000, "inactivity"),
    ],
    [
      "a sandbox outage",
      new AgentHarnessSandboxUnavailableError(
        "sandbox_123",
        new Error("no IP address found"),
      ),
    ],
  ])(
    "does not turn %s into a Preparation Fallback",
    async (_label, failure) => {
      const artifacts: Record<string, unknown> = {};
      let caught: unknown;

      try {
        await runAgentHarnessPipeline(
          {
            demoBrief: { keyProductFeatures: ["dashboard"] },
            files: [{ path: "package.json", text: "{}" }],
            repoStats: { fileCount: 1, sizeBytes: 2 },
            repoUrl: "https://github.com/example/app",
            runId: "run_infrastructure_failure",
          },
          failingPreparationDependencies(failure, artifacts),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(
        artifacts["/workspace/.makeademo/preparation-fallback.json"],
      ).toBeUndefined();
      expect(
        artifacts["/workspace/.makeademo/pipeline-run-manifest.json"],
      ).toMatchObject({
        finalStatus: "failed",
        unsupportedOrFailureReason: failure.message,
      });
    },
  );

  it("captures a preparation diff once after failure without masking the pipeline error", async () => {
    const failure = new AgentHarnessCommandTimeoutError(300_000, "inactivity");
    const diffFailure = new Error("Preparation diff timed out");
    let diffCaptures = 0;
    let caught: unknown;

    try {
      await runAgentHarnessPipeline(
        {
          demoBrief: { keyProductFeatures: ["dashboard"] },
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 2 },
          repoUrl: "https://github.com/example/app",
          runId: "run_failure_diff",
        },
        {
          ...failingPreparationDependencies(failure, {}),
          async capturePreparationWorkspaceDiff() {
            diffCaptures += 1;
            throw diffFailure;
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(diffCaptures).toBe(1);
    expect(Reflect.get(caught as object, "preparationWorkspaceDiffError")).toBe(
      diffFailure,
    );
  });

  it("preserves the pipeline failure and durably records a teardown failure", async () => {
    const artifacts: Record<string, unknown> = {};
    let caught: unknown;

    try {
      await runAgentHarnessPipeline(
        {
          demoBrief: { keyProductFeatures: ["dashboard"] },
          files: [{ path: "package.json", text: "{}" }],
          repoStats: { fileCount: 1, sizeBytes: 2 },
          repoUrl: "https://github.com/example/app",
          runId: "run_teardown_failure",
        },
        {
          artifactStore: {
            async writeJson(path, value) {
              artifacts[path] = value;
            },
          },
          async createWorkspace() {
            return {
              ...workspace(),
              async destroy() {
                throw new Error("Daytona delete failed");
              },
            };
          },
          async exploreApp() {
            throw new Error("should not explore");
          },
          async planFlow() {
            throw new Error("should not plan");
          },
          async prepareRepo() {
            throw new Error("Repo clone failed");
          },
          async resetCaptureRuntime() {
            return report("capture-runtime-reset", "passed");
          },
          async synthesizeRunPlan() {
            return runPlan();
          },
          async validateCapturePath() {
            throw new Error("should not validate capture");
          },
          async validatePreparation() {
            throw new Error("should not validate preparation");
          },
          async validateScriptContract() {
            throw new Error("should not validate script");
          },
          async writeScript() {
            throw new Error("should not write script");
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Repo clone failed");
    expect(Reflect.get(caught as object, "cleanupError")).toMatchObject({
      message: "Daytona delete failed",
    });
    expect(
      artifacts["/workspace/.makeademo/pipeline-run-manifest.json"],
    ).toMatchObject({
      unsupportedOrFailureReason:
        "Repo clone failed; workspace cleanup failed: Daytona delete failed",
    });
  });

  it("feeds failed capture validation back through Script Repair and retries", async () => {
    const calls: string[] = [];
    let captureAttempts = 0;
    let explorationAttempts = 0;
    let flowAttempts = 0;

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
          explorationAttempts += 1;
          calls.push(`explore:${explorationAttempts}`);
          return {
            kind: "artifacts" as const,
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport: report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          flowAttempts += 1;
          calls.push(`flow:${flowAttempts}`);
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
        async repairScript({ failureReport }) {
          calls.push(`repair:${failureReport.logsSummary}`);
          return scriptCandidate();
        },
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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
      "explore:1",
      "flow:1",
      "static",
      "dynamic:1",
      "explore:2",
      "flow:2",
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
            kind: "artifacts" as const,
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
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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

  it("repairs a product fidelity violation before runtime preflight", async () => {
    const calls: string[] = [];
    let diffAttempts = 0;

    const result = await runAgentHarnessPipeline(
      {
        demoBrief: { keyProductFeatures: ["dashboard"] },
        files: [
          { path: "package.json", text: "{}" },
          { path: "src/App.tsx", text: "export function App() {}" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
        repoUrl: "https://github.com/example/app",
        runId: "run_fidelity_repair",
      },
      {
        async capturePreparationWorkspaceDiff() {
          diffAttempts += 1;
          return diffAttempts === 1
            ? replacementWorkspaceDiff()
            : unchangedWorkspaceDiff();
        },
        async createWorkspace() {
          return workspace();
        },
        async exploreApp() {
          calls.push("explore");
          return {
            kind: "artifacts" as const,
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport: report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          return flowSpec();
        },
        async prepareRepo() {
          return {
            manifest: {
              ...preparationManifest(),
              createdFiles: ["demo/server.ts"],
              modifiedFiles: ["package.json"],
            },
          };
        },
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.stage}`);
          return { manifest: preparationManifest() };
        },
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
        },
        async synthesizeRunPlan() {
          return runPlan();
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          calls.push("preflight");
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      },
    );

    expect(result.status).toBe("passed");
    expect(diffAttempts).toBe(2);
    expect(calls).toEqual([
      "repair:preparation-fidelity",
      "preflight",
      "explore",
    ]);
    expect(result.validationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureClassification: "product fidelity violation",
          stage: "preparation-fidelity",
          status: "failed",
        }),
        expect.objectContaining({
          stage: "preparation-fidelity",
          status: "passed",
        }),
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
              kind: "artifacts" as const,
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
          async resetCaptureRuntime() {
            return report("capture-runtime-reset", "passed");
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

  it("repairs preparation and re-explores when no grounded browser route is discovered", async () => {
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
          return explorationAttempts === 1
            ? {
                kind: "repairable-failure" as const,
                validationReport: {
                  ...report("app-exploration", "failed"),
                  failureClassification: "app route not discoverable",
                  logsSummary: "No browser routes were discovered",
                },
              }
            : {
                kind: "artifacts" as const,
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
          calls.push(`repair:${failureReport.stage}`);
          return {
            manifest: { ...preparationManifest(), id: "prep_network_fixed" },
          };
        },
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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
    let diffCaptures = 0;
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
        async capturePreparationWorkspaceDiff() {
          diffCaptures += 1;
          return preparationWorkspaceDiff();
        },
        async createWorkspace() {
          return workspace();
        },
        async exploreApp() {
          explorationAttempts += 1;
          return {
            kind: "artifacts" as const,
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
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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
    expect(diffCaptures).toBe(7);
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
            kind: "artifacts" as const,
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
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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
            kind: "artifacts" as const,
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
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
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

function failingPreparationDependencies(
  error: Error,
  artifacts: Record<string, unknown>,
) {
  return {
    artifactStore: {
      async writeJson(path: string, value: unknown) {
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
      throw error;
    },
    async resetCaptureRuntime() {
      return report("capture-runtime-reset", "passed");
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

function preparationWorkspaceDiff() {
  return {
    changedPaths: ["/workspace/repo/src/demo.ts"],
    patch: "diff --git a/src/demo.ts b/src/demo.ts",
    patchSha256: `sha256:${"a".repeat(64)}` as const,
    sourceCommitSha: "abc123def456",
  };
}

function replacementWorkspaceDiff() {
  return {
    changedPaths: [
      "/workspace/repo/demo/server.ts",
      "/workspace/repo/package.json",
    ],
    patch: [
      "diff --git a/demo/server.ts b/demo/server.ts",
      "new file mode 100644",
      "+Bun.serve({ fetch() { return new Response(`<!doctype html><style></style>`); } });",
      "diff --git a/package.json b/package.json",
      '+  "dev": "bun run demo/server.ts"',
    ].join("\n"),
    patchSha256: `sha256:${"b".repeat(64)}` as const,
    sourceCommitSha: "abc123def456",
  };
}

function unchangedWorkspaceDiff() {
  return {
    changedPaths: [],
    patch: "",
    patchSha256: `sha256:${"c".repeat(64)}` as const,
    sourceCommitSha: "abc123def456",
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
    productContext: {
      evidencePaths: ["package.json"],
      featureInventory: [
        {
          authStrategy: "none" as const,
          description: "Show the dashboard.",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "dashboard",
          label: "Dashboard",
          requestedFeature: "dashboard",
          sourcePaths: ["package.json"],
        },
      ],
      name: "Demo App",
      summary: "A dashboard application.",
    },
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
        featureIds: ["dashboard"],
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
    features: [
      {
        expectedVisibleAssertions: ["Dashboard visible"],
        featureId: "dashboard",
        label: "Dashboard",
        referencedActionIds: ["open-dashboard"],
        referencedAppMapRoutePaths: ["/"],
        requestedFeature: "dashboard",
        requiredAppState: [],
        selectionReason: "Visible route",
        steps: ["Open dashboard"],
      },
    ],
    id: "flow_001",
    repairConstraints: ["Preserve dashboard step"],
    version: 2 as const,
  };
}

function scriptCandidate() {
  return {
    assumptions: [],
    browserActionCompilerVersion: "2026-07-12.1",
    bunRuntimeVersion: "1.3.14",
    captureSdkVersion: "2026-07-10.1",
    conformanceResult: report("static-script-contract-validation", "passed"),
    contractVersion: "2026-07-08",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH as typeof DEMO_SCRIPT_OUTPUT_PATH,
    playwrightRuntimeVersion: "1.60.0",
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

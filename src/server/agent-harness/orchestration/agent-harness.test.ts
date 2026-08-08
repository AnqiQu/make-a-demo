import { describe, expect, it } from "vitest";
import {
  AgentHarnessArtifactTransferError,
  AgentHarnessCommandTimeoutError,
  AgentHarnessSandboxUnavailableError,
  isAgentHarnessInfrastructureError,
} from "../daytona/workspace.interface";
import { createFakeAgentHarnessWorkspace } from "../daytona/workspace.test-helpers";
import { DEMO_SCRIPT_OUTPUT_PATH } from "../schemas/artifacts";
import {
  type AgentHarnessPipelineDependencies,
  type AgentHarnessPipelineInput,
  runAgentHarnessPipeline,
} from "./agent-harness";

describe("runAgentHarnessPipeline", () => {
  it("refuses a dependency set that omits workspace-diff capture before any stage runs", async () => {
    let workspaceCreations = 0;
    const dependencies = {
      async createWorkspace() {
        workspaceCreations += 1;
        return workspace();
      },
      async exploreApp() {
        throw new Error("App Exploration must not run.");
      },
      async planFlow() {
        throw new Error("Flow Planning must not run.");
      },
      async prepareRepo() {
        throw new Error("Repo Preparation must not run.");
      },
      async resetCaptureRuntime() {
        return report("capture-runtime-reset", "passed");
      },
      async synthesizeRunPlan() {
        return runPlan();
      },
      async validateCapturePath() {
        throw new Error("Capture Path Validation must not run.");
      },
      async validatePreparation() {
        throw new Error("Preparation Preflight must not run.");
      },
      async validateScriptContract() {
        throw new Error("Static Script Contract must not run.");
      },
      async writeScript() {
        throw new Error("Script Writing must not run.");
      },
    };
    const pipelineInput = {
      demoBrief: { keyProductFeatures: ["dashboard"] },
      files: [
        { path: "package.json", text: "{}" },
        { path: "src/page.tsx", text: "export default 1" },
      ],
      repoUrl: "https://github.com/example/app",
      runId: "run_missing_diff_capture",
    };

    await expect(
      runAgentHarnessPipeline(pipelineInput, {
        ...dependencies,
        async captureWorkspaceDiff() {
          return [];
        },
      } as unknown as AgentHarnessPipelineDependencies),
    ).rejects.toThrow(/capturePreparationWorkspaceDiff/);
    await expect(
      runAgentHarnessPipeline(pipelineInput, {
        ...dependencies,
        async capturePreparationWorkspaceDiff() {
          return preparationWorkspaceDiff();
        },
      } as unknown as AgentHarnessPipelineDependencies),
    ).rejects.toThrow(/captureWorkspaceDiff/);
    expect(workspaceCreations).toBe(0);
  });

  it("stops before planning or workspace creation when static security rejects the repository", async () => {
    const downstreamCalls: string[] = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          { path: ".env", text: "DATABASE_URL=postgres://live-secret" },
          { path: "package.json", text: "{}" },
        ],
        repoUrl: "https://github.com/example/unsafe-app",
        runId: "run_security_rejected",
      }),
      stubPipelineDependencies({
        async createWorkspace() {
          downstreamCalls.push("workspace");
          return workspace();
        },
        async resetCaptureRuntime() {
          throw new Error("Capture reset must not run after rejection.");
        },
        async synthesizeRunPlan() {
          downstreamCalls.push("run-plan");
          return runPlan();
        },
      }),
    );

    expect(result.status).toBe("security-rejected");
    expect(downstreamCalls).toEqual([]);
  });

  it("runs the artifact-driven pipeline in order and hands durable artifacts to each stage", async () => {
    const calls: string[] = [];
    const artifacts: Record<string, unknown> = {};

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({
              scripts: {
                "dev:dashboard": "turbo dev --filter=@acme/dashboard",
              },
              workspaces: ["apps/*"],
            }),
          },
          {
            path: "apps/dashboard/package.json",
            text: JSON.stringify({
              name: "@acme/dashboard",
              scripts: { dev: "next dev -p 3001" },
            }),
          },
          { path: "apps/dashboard/src/page.tsx", text: "export default 1" },
          { path: "bun.lock", text: "" },
        ],
        runId: "run_001",
      }),
      {
        async captureWorkspaceDiff() {
          return [];
        },
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
          const manifest = preparationManifest();
          const feature = manifest.productContext.featureInventory[0];
          if (feature === undefined) {
            throw new Error("Expected dashboard fixture");
          }
          feature.sourcePaths = ["apps/dashboard/src/page.tsx"];
          return {
            manifest,
            opencodeSessionId: "session_prepare",
          };
        },
        async resetCaptureRuntime({ preparationManifest: manifest }) {
          calls.push(`reset:${manifest.id}`);
          return report("capture-runtime-reset", "passed");
        },
        async synthesizeRunPlan({ repoProfile, workspace: targetWorkspace }) {
          calls.push(
            `run-plan:${repoProfile.packageManager}:${targetWorkspace.agentSandboxId}`,
          );
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
      "workspace",
      "run-plan:bun:agent_sandbox",
      "prepare:bun:bun install --frozen-lockfile",
      "preparation-diff",
      "preflight:http://127.0.0.1:3001",
      "explore:prep_001:passed",
      "flow:appmap_001:actions_001",
      "script:flow_001:http://127.0.0.1:3001",
      `static:${"flow_001"}`,
      "reset:prep_001",
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
      artifacts["/workspace/.makeademo/preparation-manifest.json"],
    ).toMatchObject({
      appDir: "apps/dashboard",
      baseUrl: "http://127.0.0.1:3001",
      installCommandUsed:
        "bun install --frozen-lockfile --filter=@acme/dashboard",
      ports: [3001],
      startCommandUsed: "bun run dev",
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

  it("routes Script Writing app-source edits to script repair", async () => {
    let diffChecks = 0;
    const repairClassifications: Array<string | undefined> = [];
    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_002" }),
      stubPipelineDependencies({
        async captureWorkspaceDiff() {
          diffChecks += 1;
          return diffChecks === 1 ? ["/workspace/src/App.tsx"] : [];
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
          repairClassifications.push(failureReport.failureClassification);
          return scriptCandidate();
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
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairClassifications).toEqual(["script modified app source"]);
  });

  it("stops the run with a classified timeout once the job wall-clock budget is spent", async () => {
    // One wall-clock budget bounds the whole job: a repair spiral converts
    // into a classified infrastructure timeout carrying the accumulated
    // stage evidence instead of a many-hour hang.
    const error: unknown = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_deadline" }),
      stubPipelineDependencies({
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
      }),
      { jobDeadlineMs: 0 },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(String(error)).toMatch(/wall-clock budget/i);
    expect(isAgentHarnessInfrastructureError(error)).toBe(true);
  });

  it("records async stage failures after the stage promise rejects", async () => {
    const artifacts: Record<string, unknown> = {};

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_003" }),
        stubPipelineDependencies({
          artifactStore: {
            async writeJson(path, value) {
              artifacts[path] = value;
            },
          },
          async prepareRepo() {
            throw Object.assign(new Error("Repo clone failed."), {
              opencodeSessionId: "session_failed_prepare",
            });
          },
        }),
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

  it("rejects a prepared manifest violating the feature inventory even when dependencies skip validation", async () => {
    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_inventory_backstop" }),
        stubPipelineDependencies({
          async prepareRepo() {
            const manifest = preparationManifest();
            const feature = manifest.productContext.featureInventory[0];
            if (feature === undefined) {
              throw new Error("Expected dashboard fixture");
            }
            feature.sourcePaths = ["package.json"];
            return { manifest };
          },
        }),
      ),
    ).rejects.toThrow(
      /must cite an original route, page, component, or browser UI module/,
    );
  });

  it("rejects a runtime-repaired manifest that drops a requested feature", async () => {
    let preflightAttempts = 0;
    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          runId: "run_repair_inventory_backstop",
        }),
        stubPipelineDependencies({
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            const manifest = preparationManifest();
            const feature = manifest.productContext.featureInventory[0];
            if (feature === undefined) {
              throw new Error("Expected dashboard fixture");
            }
            const { requestedFeature: _dropped, ...unrequestedFeature } =
              feature;
            return {
              manifest: {
                ...manifest,
                productContext: {
                  ...manifest.productContext,
                  featureInventory: [unrequestedFeature],
                },
              },
            };
          },
          async validatePreparation() {
            preflightAttempts += 1;
            if (preflightAttempts === 1) {
              return {
                ...report("preparation-preflight", "failed"),
                logsSummary: "App start failed before readiness.",
              };
            }
            return report("preparation-preflight", "passed");
          },
        }),
      ),
    ).rejects.toThrow(/must prepare every requested demo feature exactly once/);
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
    [
      "an artifact transfer failure",
      new AgentHarnessArtifactTransferError({
        attempts: 3,
        cause: new Error("upload timed out"),
        operation: "upload",
        sandboxId: "sandbox_123",
      }),
    ],
  ])(
    "does not turn %s into a Preparation Fallback",
    async (_label, failure) => {
      const artifacts: Record<string, unknown> = {};
      let caught: unknown;

      try {
        await runAgentHarnessPipeline(
          pipelineInput({
            files: [{ path: "package.json", text: "{}" }],
            runId: "run_infrastructure_failure",
          }),
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
        pipelineInput({
          files: [{ path: "package.json", text: "{}" }],
          runId: "run_failure_diff",
        }),
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
        pipelineInput({
          files: [{ path: "package.json", text: "{}" }],
          runId: "run_teardown_failure",
        }),
        stubPipelineDependencies({
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
          async prepareRepo() {
            throw new Error("Repo clone failed");
          },
        }),
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
      pipelineInput({ runId: "run_repair" }),
      stubPipelineDependencies({
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
          calls.push("reset");
          return report("capture-runtime-reset", "passed");
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
      }),
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "explore:1",
      "flow:1",
      "static",
      "reset",
      "dynamic:1",
      "explore:2",
      "flow:2",
      "repair:Dashboard locator did not resolve",
      "static",
      "reset",
      "dynamic:2",
      "reset",
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

  it("derives missing scene navigation before validating the script contract", async () => {
    let validatedCandidate: unknown;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_navigation_derived" }),
      stubPipelineDependencies({
        async exploreApp() {
          return {
            kind: "artifacts" as const,
            actionCatalog: {
              ...actionCatalog(),
              actions: [
                ...actionCatalog().actions,
                {
                  confidence: 1,
                  evidence: "Playwright loaded /",
                  expectedResult: "Dashboard becomes visible",
                  featureIds: ["dashboard"],
                  id: "navigate-route-1",
                  kind: "navigate" as const,
                  preferredLocator: {
                    reason:
                      "Navigation actions target an observed route, not an element.",
                    strategy: "css" as const,
                    value: "body",
                  },
                  risks: [],
                  route: "/",
                },
              ],
            },
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
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract({ scriptCandidate: candidate }) {
          validatedCandidate = candidate;
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return {
            ...scriptCandidate(),
            scriptJsonContent: {
              scenes: [
                {
                  actions: [
                    {
                      id: "open",
                      locator: {
                        name: "Open dashboard",
                        role: "button",
                        strategy: "role",
                      },
                      sourceActionId: "open-dashboard",
                      type: "click",
                    },
                  ],
                  featureId: "dashboard",
                  id: "dashboard",
                  type: "playwright-recording",
                },
              ],
              scriptId: "script_001",
            },
          };
        },
      }),
    );

    expect(result.status).toBe("passed");
    const scenes = (
      validatedCandidate as {
        scriptJsonContent: {
          scenes: Array<{ actions: Array<Record<string, unknown>> }>;
        };
      }
    ).scriptJsonContent.scenes;
    expect(scenes[0]?.actions[0]).toEqual({
      id: "dashboard-navigate",
      path: "/",
      sourceActionId: "navigate-route-1",
      type: "goto",
    });
  });

  it("excludes an action that fails dynamic validation twice and re-plans the flow without it", async () => {
    const planCatalogs: string[][] = [];
    let captureAttempts = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_flow_lock_escape" }),
      stubPipelineDependencies({
        async exploreApp() {
          return {
            kind: "artifacts" as const,
            actionCatalog: {
              ...actionCatalog(),
              actions: [
                ...actionCatalog().actions,
                {
                  confidence: 0.98,
                  evidence: "Playwright exercised the dashboard toggle",
                  exercised: true,
                  expectedResult: "Dashboard summary becomes visible",
                  featureIds: ["dashboard"],
                  id: "toggle-dashboard-summary",
                  kind: "click" as const,
                  preferredLocator: {
                    name: "Toggle summary",
                    strategy: "role" as const,
                    value: "button",
                  },
                  risks: [],
                  route: "/",
                },
              ],
            },
            appMap: appMap(),
            validationReport: report("app-exploration", "passed"),
          };
        },
        async planFlow({ actionCatalog: catalog }) {
          planCatalogs.push(
            (catalog as { actions: Array<{ id: string }> }).actions.map(
              ({ id }) => id,
            ),
          );
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: preparationManifest() };
        },
        async repairScript() {
          return scriptCandidate();
        },
        async validateCapturePath() {
          captureAttempts += 1;
          return captureAttempts <= 2
            ? {
                ...report("capture-path-validation", "failed"),
                failureClassification: "assertion failure",
                logsSummary:
                  "CaptureBrowserActionFailureError: Browser action open-dashboard failed in Scene dashboard. expect(locator).toBeVisible() failed",
              }
            : report("capture-path-validation", "passed");
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
      }),
    );

    expect(result.status).toBe("passed");
    expect(planCatalogs).toHaveLength(2);
    expect(planCatalogs[0]).toContain("open-dashboard");
    expect(planCatalogs[1]).not.toContain("open-dashboard");
    expect(planCatalogs[1]).toContain("toggle-dashboard-summary");
  });

  it("retries capture validation after a transient infrastructure failure without spending script repair", async () => {
    const calls: string[] = [];
    let captureAttempts = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_transient" }),
      stubPipelineDependencies({
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
          calls.push(`repair:${failureReport.logsSummary}`);
          return scriptCandidate();
        },
        async validateCapturePath() {
          captureAttempts += 1;
          calls.push(`dynamic:${captureAttempts}`);
          return captureAttempts === 1
            ? {
                ...report("capture-path-validation", "failed"),
                failureClassification: "transient infrastructure failure",
                logsSummary:
                  "Submitted-code artifact download failed after 3 attempt(s)",
              }
            : report("capture-path-validation", "passed");
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
      }),
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual(["dynamic:1", "dynamic:2"]);
  });

  it("fails with the transient infrastructure cause once its retry budget is spent", async () => {
    const calls: string[] = [];

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_transient_exhausted" }),
        stubPipelineDependencies({
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
            calls.push(`repair:${failureReport.logsSummary}`);
            return scriptCandidate();
          },
          async validateCapturePath() {
            calls.push("dynamic");
            return {
              ...report("capture-path-validation", "failed"),
              failureClassification: "transient infrastructure failure",
              logsSummary:
                "Submitted-code artifact download failed after 3 attempt(s)",
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
        }),
      ),
    ).rejects.toThrow(/Submitted-code artifact download failed/);
    expect(calls).toEqual(["dynamic", "dynamic", "dynamic"]);
  });

  it("feeds failed runtime preflight back through Repo Preparation Repair", async () => {
    const calls: string[] = [];
    const artifactWrites: string[] = [];
    let preflightAttempts = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_preparation_repair" }),
      stubPipelineDependencies({
        artifactStore: {
          async writeJson(path) {
            artifactWrites.push(path);
          },
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
      }),
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

  it("expands a missing internal workspace before invoking preparation repair", async () => {
    const installCommands: string[] = [];
    let preflightAttempts = 0;
    let repairAttempts = 0;
    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
          },
          {
            path: "apps/web/package.json",
            text: JSON.stringify({
              name: "@acme/web",
              scripts: { dev: "vite" },
            }),
          },
          { path: "apps/web/src/page.tsx", text: "export default 1" },
          {
            path: "packages/events/package.json",
            text: JSON.stringify({ name: "@acme/events" }),
          },
          {
            path: "packages/ui/package.json",
            text: JSON.stringify({ name: "@acme/ui" }),
          },
          {
            path: "packages/data/package.json",
            text: JSON.stringify({ name: "@acme/data" }),
          },
          {
            path: "packages/auth/package.json",
            text: JSON.stringify({ name: "@acme/auth" }),
          },
          { path: "bun.lock", text: "" },
        ],
        runId: "run_workspace_scope_recovery",
      }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          return unchangedWorkspaceDiff();
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
          const manifest = preparationManifest();
          const feature = manifest.productContext.featureInventory[0];
          if (feature !== undefined) {
            feature.sourcePaths = ["apps/web/src/page.tsx"];
          }
          return { manifest };
        },
        async repairPreparation() {
          repairAttempts += 1;
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest: manifest }) {
          preflightAttempts += 1;
          installCommands.push(manifest.installCommandUsed);
          const missingWorkspace = [
            "@acme/events/client",
            "@acme/ui/button",
            "@acme/data/client",
            "@acme/auth/session",
          ][preflightAttempts - 1];
          return missingWorkspace === undefined
            ? report("preparation-preflight", "passed")
            : {
                ...report("preparation-preflight", "failed"),
                failureClassification: "start failure",
                logsSummary: `Module not found: Can't resolve '${missingWorkspace}'`,
              };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairAttempts).toBe(0);
    expect(installCommands).toEqual([
      "bun install --frozen-lockfile --filter=@acme/web",
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events",
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events --filter=@acme/ui",
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events --filter=@acme/ui --filter=@acme/data",
      "bun install --frozen-lockfile --filter=@acme/web --filter=@acme/events --filter=@acme/ui --filter=@acme/data --filter=@acme/auth",
    ]);
  });

  it("reuses the previous round's install when a repair changes no dependency inputs", async () => {
    // Loop economics (N58): most repairs touch source and fixtures, not
    // package manifests — re-running the gated install every round spends
    // 1–2 minutes reproducing the same warm node_modules. When the repair
    // delta leaves dependency inputs unchanged and the prior round's
    // install succeeded in this sandbox, the next validation skips install
    // and the repair agent is told the install was reused.
    const installFlags: Array<boolean | undefined> = [];
    const repairHintLog: string[] = [];
    let preflightAttempts = 0;
    let diffCalls = 0;
    const diffAfterRepair = (round: number) => ({
      changedFileSha256: {
        "/workspace/repo/src/demo-fixtures.ts":
          `sha256:${String(round).repeat(64).slice(0, 64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/demo-fixtures.ts"],
      patch: [
        "diff --git a/src/demo-fixtures.ts b/src/demo-fixtures.ts",
        "new file mode 100644",
        `+export const fixtureRows = [${round}];`,
      ].join("\n"),
      patchSha256: `sha256:${"d".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    });

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_install_reuse" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCalls += 1;
          // Call order: initial fidelity diff; before-repair baseline;
          // after-repair diff; before-repair-2 baseline; after-repair-2.
          if (diffCalls <= 2) return unchangedWorkspaceDiff();
          if (diffCalls === 3) return diffAfterRepair(1);
          if (diffCalls === 4) return diffAfterRepair(1);
          return diffAfterRepair(2);
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
        async repairPreparation({ failureReport }) {
          repairHintLog.push(failureReport.suggestedRepairHints.join("\n"));
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ installDependencies }) {
          preflightAttempts += 1;
          installFlags.push(installDependencies);
          return preflightAttempts <= 2
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "start failure",
                logsSummary: `boot failed round ${preflightAttempts}`,
              }
            : report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
    );

    expect(result.status).toBe("passed");
    // Round 1 installs; rounds 2 and 3 follow source-only repairs and reuse
    // the round-1 install.
    expect(installFlags).toEqual([undefined, false, false]);
    expect(repairHintLog[1]).toContain(
      "install reused from validation attempt 1",
    );
  });

  it("counts a deterministic install-scope expansion against the global repair budget", async () => {
    let preflightAttempts = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            {
              path: "package.json",
              text: JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
            },
            {
              path: "apps/web/package.json",
              text: JSON.stringify({
                name: "@acme/web",
                scripts: { dev: "vite" },
              }),
            },
            { path: "apps/web/src/page.tsx", text: "export default 1" },
            {
              path: "packages/events/package.json",
              text: JSON.stringify({ name: "@acme/events" }),
            },
            { path: "bun.lock", text: "" },
          ],
          runId: "run_expansion_budget",
        }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return unchangedWorkspaceDiff();
          },
          async prepareRepo() {
            const manifest = preparationManifest();
            const feature = manifest.productContext.featureInventory[0];
            if (feature !== undefined) {
              feature.sourcePaths = ["apps/web/src/page.tsx"];
            }
            return { manifest };
          },
          async repairPreparation() {
            repairAttempts += 1;
            return { manifest: preparationManifest() };
          },
          async resetCaptureRuntime() {
            throw new Error("Capture reset must not run.");
          },
          async validatePreparation() {
            preflightAttempts += 1;
            return preflightAttempts === 1
              ? {
                  ...report("preparation-preflight", "failed"),
                  failureClassification: "start failure",
                  logsSummary:
                    "Module not found: Can't resolve '@acme/events/client'",
                }
              : {
                  ...report("preparation-preflight", "failed"),
                  failureClassification: "start failure",
                  logsSummary: "App exited before it became ready",
                };
          },
        }),
        { repoPreparationRepairLimit: 1 },
      ),
    ).rejects.toThrow("global retry budget exhausted");

    expect(repairAttempts).toBe(0);
  });

  it("repairs a product fidelity violation before runtime preflight", async () => {
    const calls: string[] = [];
    let diffAttempts = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          { path: "package.json", text: "{}" },
          { path: "src/page.tsx", text: "export default 1" },
          { path: "src/App.tsx", text: "export function App() {}" },
        ],
        runId: "run_fidelity_repair",
      }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffAttempts += 1;
          return diffAttempts === 1
            ? replacementWorkspaceDiff()
            : unchangedWorkspaceDiff();
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
            },
          };
        },
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.stage}`);
          return { manifest: preparationManifest() };
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
      }),
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

  it("records a completed repair session when follow-up fidelity still fails", async () => {
    const artifacts: Record<string, unknown> = {};

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            { path: "package.json", text: "{}" },
            { path: "src/page.tsx", text: "export default 1" },
            { path: "src/App.tsx", text: "export function App() {}" },
          ],
          runId: "run_failed_fidelity_repair",
        }),
        {
          ...failingPreparationDependencies(
            new Error("Unexpected pipeline stage."),
            artifacts,
          ),
          async capturePreparationWorkspaceDiff() {
            return replacementWorkspaceDiff();
          },
          async prepareRepo() {
            return {
              manifest: preparationManifest(),
              opencodeSessionId: "session_prepare",
            };
          },
          async repairPreparation() {
            return {
              manifest: preparationManifest(),
              opencodeSessionId: "session_repair",
            };
          },
        },
      ),
    ).rejects.toThrow("preparation-fidelity failed");

    expect(
      artifacts["/workspace/.makeademo/pipeline-run-manifest.json"],
    ).toMatchObject({
      finalStatus: "failed",
      opencodeSessionIds: ["session_prepare", "session_repair"],
    });
  });

  it("retries an invalid install repair from the last fidelity-approved preparation", async () => {
    const approvedManifest = {
      ...preparationManifest(),
      authBypassOrDemoIdentity: "Local demo identity",
      envUsed: { MAKEADEMO_DEMO: "true" },
      id: "prep_approved",
    };
    const driftedManifest = {
      ...preparationManifest(),
      id: "prep_drifted",
      productContext: {
        ...preparationManifest().productContext,
        featureInventory: [],
      },
    };
    const approvedDiff = unchangedWorkspaceDiff();
    const invalidRepairDiff = {
      changedFileSha256: {
        "src/service/export.ts": `sha256:${"d".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/service/export.ts"],
      patch:
        "diff --git a/src/service/export.ts b/src/service/export.ts\n+export const value = 2;",
      patchSha256: `sha256:${"d".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    const validDependencyDiff = {
      changedFileSha256: {
        "package.json": `sha256:${"e".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/package.json"],
      patch:
        'diff --git a/package.json b/package.json\n+  "overrides": { "xlsx": "0.18.5" }',
      patchSha256: `sha256:${"e".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    const repairInputs: Array<{ manifestId: string; stage: string }> = [];
    const reconcileRequests: Array<boolean | undefined> = [];
    const restored: string[] = [];
    const artifacts: Record<string, unknown> = {};
    let diffAttempt = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
          { path: "src/page.tsx", text: "export default 1" },
          { path: "src/service/export.ts", text: "export const value = 1" },
        ],
        runId: "run_transactional_install_repair",
      }),
      stubPipelineDependencies({
        artifactStore: {
          async writeJson(path, value) {
            artifacts[path] = value;
          },
        },
        async capturePreparationWorkspaceDiff() {
          diffAttempt += 1;
          const diff = [
            approvedDiff,
            approvedDiff,
            approvedDiff,
            invalidRepairDiff,
            validDependencyDiff,
          ][diffAttempt - 1];
          if (diff === undefined) throw new Error("Unexpected diff capture.");
          return diff;
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
          return { manifest: approvedManifest };
        },
        async repairPreparation({ failureReport, preparationManifest }) {
          repairInputs.push({
            manifestId: preparationManifest.id,
            stage: failureReport.stage,
          });
          return {
            manifest:
              repairInputs.length === 2 ? driftedManifest : approvedManifest,
          };
        },
        async restorePreparationCandidate({ preparationManifest }) {
          restored.push(preparationManifest.id);
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ reconcileLockfile }) {
          reconcileRequests.push(reconcileLockfile);
          if (repairInputs.length === 1) {
            throw new Error(
              "Preflight must not rerun after an unchanged dependency repair.",
            );
          }
          return repairInputs.length === 0
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "install failure",
                logsSummary: "Dependency install failed",
              }
            : report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: approvedManifest.id,
          };
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(restored).toEqual([approvedManifest.id]);
    expect(repairInputs).toEqual([
      { manifestId: approvedManifest.id, stage: "preparation-preflight" },
      { manifestId: approvedManifest.id, stage: "preparation-preflight" },
      { manifestId: approvedManifest.id, stage: "preparation-preflight" },
    ]);
    expect(reconcileRequests).toEqual([undefined, true]);
    expect(result.preparationManifest).toEqual(approvedManifest);
    expect(
      artifacts[
        "/workspace/.makeademo/validation-attempts/preparation-fidelity/attempt-3-workspace-diff.json"
      ],
    ).toMatchObject({
      acceptedBaselinePatchSha256: approvedDiff.patchSha256,
      patchSha256: invalidRepairDiff.patchSha256,
      repair: "dependency",
    });
  });

  it("points post-rejection repairs at the vetoed candidate diff without duplicating hints", async () => {
    const approvedManifest = {
      ...preparationManifest(),
      id: "prep_approved",
    };
    const invalidDiff = {
      changedFileSha256: {
        "bun.lock": `sha256:${"a".repeat(64)}` as const,
        "src/demo/fixtures.ts": `sha256:${"d".repeat(64)}` as const,
        "src/feature.ts": `sha256:${"f".repeat(64)}` as const,
      },
      changedPaths: [
        "/workspace/repo/bun.lock",
        "/workspace/repo/src/demo/fixtures.ts",
        "/workspace/repo/src/feature.ts",
      ],
      patch: [
        "diff --git a/bun.lock b/bun.lock",
        "+generated lock",
        "diff --git a/src/demo/fixtures.ts b/src/demo/fixtures.ts",
        "+export const fixtures = [];",
        "diff --git a/src/feature.ts b/src/feature.ts",
        "+export const replacement = true;",
      ].join("\n"),
      patchSha256: `sha256:${"f".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    const repairHintLists: string[][] = [];
    let diffAttempt = 0;
    let explorationAttempt = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          { path: "package.json", text: "{}" },
          { path: "bun.lock", text: "" },
          { path: "src/page.tsx", text: "export default 1" },
          { path: "src/feature.ts", text: "export const feature = true" },
        ],
        runId: "run_rejected_repair_hint",
      }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffAttempt += 1;
          return diffAttempt === 2 || diffAttempt === 3
            ? invalidDiff
            : unchangedWorkspaceDiff();
        },
        async exploreApp() {
          explorationAttempt += 1;
          return {
            kind: "artifacts" as const,
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport:
              explorationAttempt === 1
                ? {
                    ...report("app-exploration", "failed"),
                    failureClassification: "empty/unmeaningful app state",
                  }
                : report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: approvedManifest };
        },
        async repairPreparation({ failureReport }) {
          repairHintLists.push([...failureReport.suggestedRepairHints]);
          return { manifest: approvedManifest };
        },
        async restorePreparationCandidate() {},
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
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: approvedManifest.id,
          };
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairHintLists).toHaveLength(3);
    const vetoedCandidateHints = (hints: string[]) =>
      hints.filter((hint) =>
        hint.includes("/workspace/.makeademo/preparation-workspace-diff.json"),
      );
    expect(vetoedCandidateHints(repairHintLists[0] ?? [])).toHaveLength(0);
    expect(vetoedCandidateHints(repairHintLists[1] ?? [])).toHaveLength(1);
    expect(vetoedCandidateHints(repairHintLists[2] ?? [])).toHaveLength(1);
    const rejectionHint = vetoedCandidateHints(repairHintLists[1] ?? [])[0];
    expect(rejectionHint).toContain("src/demo/fixtures.ts");
    expect(rejectionHint).not.toContain("src/feature.ts");
    expect(rejectionHint).not.toContain("bun.lock");
    // midday (2026-08-07 matrix): five repair rounds re-tried the vetoed
    // kind of change because no prompt ever presented the original failure
    // and the veto as one simultaneous constraint set.
    expect((repairHintLists[1] ?? []).join("\n")).toContain(
      "Both constraints hold at once",
    );
    const thirdHints = repairHintLists[2] ?? [];
    expect(new Set(thirdHints).size).toBe(thirdHints.length);
  });

  it("retains the approved preparation baseline across downstream repair phases", async () => {
    const approvedManifest = {
      ...preparationManifest(),
      id: "prep_approved",
    };
    const invalidDiff = {
      changedFileSha256: {
        "src/feature.ts": `sha256:${"f".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/feature.ts"],
      patch:
        "diff --git a/src/feature.ts b/src/feature.ts\n+export const replacement = true;",
      patchSha256: `sha256:${"f".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    const repairStages: string[] = [];
    const restored: string[] = [];
    let diffAttempt = 0;
    let explorationAttempt = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          { path: "package.json", text: "{}" },
          { path: "src/page.tsx", text: "export default 1" },
          { path: "src/feature.ts", text: "export const feature = true" },
        ],
        runId: "run_downstream_preparation_baseline",
      }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffAttempt += 1;
          return diffAttempt === 2 ? invalidDiff : unchangedWorkspaceDiff();
        },
        async exploreApp() {
          explorationAttempt += 1;
          return {
            kind: "artifacts" as const,
            actionCatalog: actionCatalog(),
            appMap: appMap(),
            validationReport:
              explorationAttempt === 1
                ? {
                    ...report("app-exploration", "failed"),
                    failureClassification: "empty/unmeaningful app state",
                  }
                : report("app-exploration", "passed"),
          };
        },
        async planFlow() {
          return flowSpec();
        },
        async prepareRepo() {
          return { manifest: approvedManifest };
        },
        async repairPreparation({ failureReport }) {
          repairStages.push(failureReport.stage);
          return {
            manifest:
              repairStages.length === 1
                ? { ...approvedManifest, id: "prep_drifted" }
                : approvedManifest,
          };
        },
        async restorePreparationCandidate({ preparationManifest }) {
          restored.push(preparationManifest.id);
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
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: approvedManifest.id,
          };
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairStages).toEqual(["app-exploration", "app-exploration"]);
    expect(restored).toEqual([approvedManifest.id]);
    expect(result.preparationManifest).toEqual(approvedManifest);
  });

  it("treats a backend-generated lockfile as the baseline for the next install repair", async () => {
    const lockDigest = `sha256:${"1".repeat(64)}` as const;
    const promotedLockDiff = {
      changedFileSha256: { "bun.lock": lockDigest },
      changedPaths: ["/workspace/repo/bun.lock"],
      patch: "diff --git a/bun.lock b/bun.lock\n+generated lock",
      patchSha256: `sha256:${"1".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    const repairedDependencyDiff = {
      changedFileSha256: {
        "bun.lock": lockDigest,
        "package.json": `sha256:${"2".repeat(64)}` as const,
      },
      changedPaths: [
        "/workspace/repo/bun.lock",
        "/workspace/repo/package.json",
      ],
      patch: [
        promotedLockDiff.patch,
        "diff --git a/package.json b/package.json",
        '+  "overrides": { "dependency": "1.0.0" }',
      ].join("\n"),
      patchSha256: `sha256:${"2".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    let state: "initial" | "promoted" | "repaired" = "initial";
    let diffCaptures = 0;
    let repairs = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_generated_lockfile_baseline" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCaptures += 1;
          if (state === "promoted") return promotedLockDiff;
          if (state === "repaired") return repairedDependencyDiff;
          return unchangedWorkspaceDiff();
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
        async repairPreparation() {
          repairs += 1;
          state = "repaired";
          return { manifest: preparationManifest() };
        },
        async restorePreparationCandidate() {
          throw new Error("A backend-generated lockfile must not be rejected.");
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ reconcileLockfile }) {
          if (state === "initial") {
            state = "promoted";
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "install failure",
            };
          }
          expect(reconcileLockfile).toBe(true);
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairs).toBe(1);
    expect(diffCaptures).toBe(3);
  });

  it("reconciles dependency metadata introduced by a runtime repair", async () => {
    const dependencyDiff = {
      changedFileSha256: {
        "package.json": `sha256:${"3".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/package.json"],
      patch:
        'diff --git a/package.json b/package.json\n+  "dependencies": { "missing-package": "1.0.0" }',
      patchSha256: `sha256:${"3".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
    let repaired = false;
    const reconcileRequests: Array<boolean | undefined> = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_runtime_dependency_repair" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          return repaired ? dependencyDiff : unchangedWorkspaceDiff();
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
        async repairPreparation() {
          repaired = true;
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ reconcileLockfile }) {
          reconcileRequests.push(reconcileLockfile);
          return repaired
            ? report("preparation-preflight", "passed")
            : {
                ...report("preparation-preflight", "failed"),
                failureClassification: "missing dependency",
              };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(reconcileRequests).toEqual([undefined, true]);
  });

  it("recognizes a repeated failure whose logs differ only by port and temp path", async () => {
    let preflightAttempts = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            { path: "package.json", text: "{}" },
            { path: "src/page.tsx", text: "export default 1" },
          ],
          runId: "run_noisy_repeated_failure",
        }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return unchangedWorkspaceDiff();
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            repairAttempts += 1;
            return { manifest: preparationManifest() };
          },
          async resetCaptureRuntime() {
            throw new Error("Capture reset must not run.");
          },
          async validatePreparation() {
            preflightAttempts += 1;
            return {
              ...report("preparation-preflight", "failed"),
              attemptedCommand: "bun run dev",
              failureClassification: "start failure",
              logsSummary: `Start command could not listen on 127.0.0.1:${3000 + preflightAttempts}\nfull log: /tmp/makeademo-run-${preflightAttempts}/app.log`,
            };
          },
        }),
        { repoPreparationRepairLimit: 5 },
      ),
    ).rejects.toThrow("repeated failure");

    expect(repairAttempts).toBe(2);
  });

  it("stops repeating the same preparation failure after two repairs", async () => {
    let preflightAttempts = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            { path: "package.json", text: "{}" },
            { path: "src/page.tsx", text: "export default 1" },
          ],
          runId: "run_repeated_failure_budget",
        }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return unchangedWorkspaceDiff();
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            repairAttempts += 1;
            return { manifest: preparationManifest() };
          },
          async resetCaptureRuntime() {
            throw new Error("Capture reset must not run.");
          },
          async validatePreparation() {
            preflightAttempts += 1;
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "render timeout",
              logsSummary: `Feature render timed out after ${90_000 + preflightAttempts}ms`,
            };
          },
        }),
        { repoPreparationRepairLimit: 5 },
      ),
    ).rejects.toThrow("repeated failure");

    expect(repairAttempts).toBe(2);
  });

  it("reports the terminal validation stage after an earlier stage also failed", async () => {
    const artifacts: Record<string, unknown> = {};
    let state: "initial-fidelity-failure" | "install-failure" | "source-edit" =
      "initial-fidelity-failure";

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            { path: "package.json", text: "{}" },
            { path: "bun.lock", text: "" },
            { path: "src/page.tsx", text: "export default 1" },
            { path: "src/service/export.ts", text: "export const value = 1" },
          ],
          runId: "run_terminal_preparation_stage",
        }),
        {
          ...failingPreparationDependencies(
            new Error("Unexpected pipeline stage."),
            artifacts,
          ),
          async capturePreparationWorkspaceDiff() {
            if (state === "initial-fidelity-failure") {
              return replacementWorkspaceDiff();
            }
            if (state === "install-failure") return unchangedWorkspaceDiff();
            return {
              changedFileSha256: {
                "src/service/export.ts": `sha256:${"f".repeat(64)}` as const,
              },
              changedPaths: ["/workspace/repo/src/service/export.ts"],
              patch:
                "diff --git a/src/service/export.ts b/src/service/export.ts\n+export const value = 2;",
              patchSha256: `sha256:${"f".repeat(64)}` as const,
              sourceCommitSha: "abc123def456",
            };
          },
          async prepareRepo() {
            return {
              manifest: {
                ...preparationManifest(),
              },
            };
          },
          async repairPreparation({ failureReport }) {
            state =
              failureReport.stage === "preparation-fidelity"
                ? "install-failure"
                : "source-edit";
            return { manifest: preparationManifest() };
          },
          async validatePreparation() {
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "install failure",
              logsSummary: "Dependency install failed",
            };
          },
        },
      ),
    ).rejects.toThrow("preparation-fidelity failed");

    expect(
      artifacts["/workspace/.makeademo/preparation-fallback.json"],
    ).toMatchObject({
      blockers: [
        {
          failureClassification: "product fidelity violation",
          summary: expect.stringContaining("src/service/export.ts"),
        },
      ],
      failedStage: "preparation-fidelity",
    });
  });

  it("re-repairs a Script Repair that mutates app source", async () => {
    let diffChecks = 0;
    let captureChecks = 0;
    const repairClassifications: Array<string | undefined> = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_repair_mutation" }),
      stubPipelineDependencies({
        async captureWorkspaceDiff() {
          diffChecks += 1;
          return diffChecks === 2 ? ["/workspace/repo/src/App.tsx"] : [];
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
          repairClassifications.push(failureReport.failureClassification);
          return scriptCandidate();
        },
        async validateCapturePath() {
          captureChecks += 1;
          return captureChecks === 1
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
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairClassifications).toEqual([
      "locator failure",
      "script modified app source",
    ]);
  });

  it("repairs preparation when a claimed auth bypass still reaches login", async () => {
    let explorationAttempts = 0;
    const calls: string[] = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_exploration_repair" }),
      stubPipelineDependencies({
        async exploreApp({ preparationManifest: manifest }) {
          explorationAttempts += 1;
          calls.push(`explore:${manifest.id}`);
          return explorationAttempts === 1
            ? {
                kind: "repairable-failure" as const,
                validationReport: {
                  ...report("app-exploration", "failed"),
                  failureClassification: "feature auth barrier",
                  logsSummary:
                    "Prepared dashboard route redirected to authentication",
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
          return { manifest: claimedAuthBypassManifest() };
        },
        async repairPreparation({ failureReport }) {
          calls.push(`repair:${failureReport.stage}`);
          return {
            manifest: {
              ...claimedAuthBypassManifest(),
              id: "prep_network_fixed",
            },
          };
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
      }),
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

  it("caps preparation repairs globally while allowing changed failures to progress", async () => {
    let diffCaptures = 0;
    let explorationAttempts = 0;
    let preflightAttempts = 0;
    const repairStages: string[] = [];
    const explorationFailures = [
      {
        failureClassification: "external network attempted",
        logsSummary: "Blocked external stylesheet",
      },
      {
        failureClassification: "auth wall",
        logsSummary: "Login page remained visible",
      },
      {
        failureClassification: "empty/unmeaningful app state",
        logsSummary: "Feature route rendered no content",
      },
    ];
    const preflightFailures = [
      {
        failureClassification: "start failure",
        logsSummary: "App is not ready",
      },
      {
        failureClassification: "render timeout",
        logsSummary: "Feature render timed out",
      },
      {
        failureClassification: "runtime crash",
        logsSummary: "App process exited during probing",
      },
    ];

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_phase_repair_budgets" }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            diffCaptures += 1;
            return preparationWorkspaceDiff();
          },
          async exploreApp() {
            explorationAttempts += 1;
            const failure = explorationFailures[explorationAttempts - 1];
            if (failure === undefined) {
              throw new Error("Unexpected exploration attempt.");
            }
            return {
              kind: "artifacts" as const,
              actionCatalog: actionCatalog(),
              appMap: appMap(),
              validationReport: {
                ...report("app-exploration", "failed"),
                ...failure,
              },
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
          async validateCapturePath() {
            return report("capture-path-validation", "passed");
          },
          async validatePreparation() {
            preflightAttempts += 1;
            if (preflightAttempts > 3) {
              return report("preparation-preflight", "passed");
            }
            const failure = preflightFailures[preflightAttempts - 1];
            if (failure === undefined) {
              throw new Error("Unexpected preflight attempt.");
            }
            return {
              ...report("preparation-preflight", "failed"),
              ...failure,
            };
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
        }),
      ),
    ).rejects.toThrow("global retry budget");

    expect(repairStages).toEqual([
      "preparation-preflight",
      "preparation-preflight",
      "preparation-preflight",
      "app-exploration",
      "app-exploration",
    ]);
    expect(diffCaptures).toBe(6);
  });

  it("allows three script repairs independently in static and capture validation", async () => {
    let captureAttempts = 0;
    let staticAttempts = 0;
    const repairStages: string[] = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_phase_script_repair_budgets" }),
      stubPipelineDependencies({
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
      }),
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
      pipelineInput({ runId: "run_capture_preparation_repair" }),
      stubPipelineDependencies({
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
      }),
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

/** The dominant pipeline input; tests override the fields they care about. */
function pipelineInput(
  overrides: Partial<AgentHarnessPipelineInput> = {},
): AgentHarnessPipelineInput {
  return {
    demoBrief: { keyProductFeatures: ["dashboard"] },
    files: [
      { path: "package.json", text: "{}" },
      { path: "src/page.tsx", text: "export default 1" },
      { path: "bun.lock", text: "" },
    ],
    repoUrl: "https://github.com/example/app",
    runId: "run_default",
    ...overrides,
  };
}

/**
 * Complete dependency set whose stage methods throw stage-named sentinels, so
 * a stage a test did not explicitly allow fails loudly if it runs. Tests
 * override only the members they observe or allow.
 */
function stubPipelineDependencies(
  overrides: Partial<AgentHarnessPipelineDependencies> = {},
): AgentHarnessPipelineDependencies {
  return {
    artifactStore: {
      async writeJson() {},
    },
    async capturePreparationWorkspaceDiff() {
      return preparationWorkspaceDiff();
    },
    async captureWorkspaceDiff() {
      return [];
    },
    async createWorkspace() {
      return workspace();
    },
    async exploreApp() {
      throw new Error("App Exploration must not run.");
    },
    async planFlow() {
      throw new Error("Flow Planning must not run.");
    },
    async prepareRepo() {
      throw new Error("Repo Preparation must not run.");
    },
    async resetCaptureRuntime() {
      return report("capture-runtime-reset", "passed");
    },
    async synthesizeRunPlan() {
      return runPlan();
    },
    async validateCapturePath() {
      throw new Error("Capture Path Validation must not run.");
    },
    async validatePreparation() {
      throw new Error("Preparation Preflight must not run.");
    },
    async validateScriptContract() {
      throw new Error("Static Script Contract must not run.");
    },
    async writeScript() {
      throw new Error("Script Writing must not run.");
    },
    ...overrides,
  };
}

function workspace() {
  return createFakeAgentHarnessWorkspace({
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
    submittedCodeSandboxId: "submitted_sandbox",
  });
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
    async capturePreparationWorkspaceDiff() {
      return preparationWorkspaceDiff();
    },
    async captureWorkspaceDiff() {
      return [];
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
    changedFileSha256: {
      "src/demo.ts": `sha256:${"a".repeat(64)}` as const,
    },
    changedPaths: ["/workspace/repo/src/demo.ts"],
    patch: "diff --git a/src/demo.ts b/src/demo.ts",
    patchSha256: `sha256:${"a".repeat(64)}` as const,
    sourceCommitSha: "abc123def456",
  };
}

function replacementWorkspaceDiff() {
  return {
    changedFileSha256: {
      "demo/server.ts": `sha256:${"b".repeat(64)}` as const,
      "package.json": `sha256:${"b".repeat(64)}` as const,
    },
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
    changedFileSha256: {},
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
    envUsed: {},
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
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
          sourcePaths: ["src/page.tsx"],
        },
      ],
      name: "Demo App",
      summary: "A dashboard application.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
  };
}

function claimedAuthBypassManifest() {
  const manifest = preparationManifest();
  return {
    ...manifest,
    authBypassOrDemoIdentity: "MAKEADEMO_DEMO supplies a local identity.",
    envUsed: { MAKEADEMO_DEMO: "true" },
    productContext: {
      ...manifest.productContext,
      featureInventory: manifest.productContext.featureInventory.map(
        (feature) => ({ ...feature, authStrategy: "bypass" as const }),
      ),
    },
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
    browserActionCompilerVersion: "2026-07-18.1",
    bunRuntimeVersion: "1.3.14",
    captureSdkVersion: "2026-07-18.1",
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

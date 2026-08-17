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

  it("profiles the screened archive size before creating the workspace", async () => {
    let profiledArchiveSizeBytes: number | undefined;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ archiveSizeBytes: 134_113_964 }),
        stubPipelineDependencies({
          async createWorkspace({ repoProfile }) {
            profiledArchiveSizeBytes = repoProfile.archiveSizeBytes;
            return workspace();
          },
          async synthesizeRunPlan() {
            throw new Error("profile observed");
          },
        }),
      ),
    ).rejects.toThrow("profile observed");

    expect(profiledArchiveSizeBytes).toBe(134_113_964);
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

  it("swaps the submitted-code sandbox to the repo-pinned node line before repo preparation", async () => {
    const events: string[] = [];
    const submittedCommands: string[] = [];
    const fakeWorkspace = createFakeAgentHarnessWorkspace({
      executeSubmittedCode: async (command: string) => {
        events.push("swap");
        submittedCommands.push(command);
        return { exitCode: 0, stderr: "", stdout: "v22.23.1\n" };
      },
    });

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            {
              path: "package.json",
              text: JSON.stringify({ engines: { node: "22" } }),
            },
            { path: "src/page.tsx", text: "export default 1" },
            { path: "bun.lock", text: "" },
          ],
        }),
        stubPipelineDependencies({
          async createWorkspace() {
            return fakeWorkspace;
          },
          async prepareRepo() {
            events.push("prepare");
            throw new Error("stop after swap");
          },
        }),
      ),
    ).rejects.toThrow("stop after swap");

    expect(events).toEqual(["swap", "prepare"]);
    expect(submittedCommands[0]).toContain("node-v22");
    expect(submittedCommands[0]).toContain("corepack enable");
  });

  it("skips the node-line swap when the repository declares no Node pin", async () => {
    const submittedCommands: string[] = [];
    const fakeWorkspace = createFakeAgentHarnessWorkspace({
      executeSubmittedCode: async (command: string) => {
        submittedCommands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    await expect(
      runAgentHarnessPipeline(
        pipelineInput(),
        stubPipelineDependencies({
          async createWorkspace() {
            return fakeWorkspace;
          },
          async prepareRepo() {
            throw new Error("stop before preparation");
          },
        }),
      ),
    ).rejects.toThrow("stop before preparation");

    expect(submittedCommands).toEqual([]);
  });

  it("fails the run legibly when the pinned node line cannot be activated", async () => {
    const fakeWorkspace = createFakeAgentHarnessWorkspace({
      executeSubmittedCode: async () => ({
        exitCode: 1,
        stderr:
          "makeademo: node line 22 is not baked into this image; rebuild the submitted-code snapshot",
        stdout: "",
      }),
    });

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            {
              path: "package.json",
              text: JSON.stringify({ engines: { node: "22" } }),
            },
            { path: "src/page.tsx", text: "export default 1" },
            { path: "bun.lock", text: "" },
          ],
        }),
        stubPipelineDependencies({
          async createWorkspace() {
            return fakeWorkspace;
          },
          async prepareRepo() {
            throw new Error(
              "Repo Preparation must not run after a failed swap.",
            );
          },
        }),
      ),
    ).rejects.toThrow(/Node line 22.*rebuild the submitted-code snapshot/s);
  });

  it("records the resolved node line in the run-plan artifact", async () => {
    const artifacts: Record<string, unknown> = {};

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({
          files: [
            {
              path: "package.json",
              text: JSON.stringify({ engines: { node: "22" } }),
            },
            { path: "src/page.tsx", text: "export default 1" },
            { path: "bun.lock", text: "" },
          ],
        }),
        stubPipelineDependencies({
          artifactStore: {
            async writeJson(path: string, value: unknown) {
              artifacts[path] = value;
            },
          },
          async prepareRepo() {
            throw new Error("stop after run plan");
          },
        }),
      ),
    ).rejects.toThrow("stop after run plan");

    const recordedRunPlan = artifacts[
      "/workspace/.makeademo/run-plan.json"
    ] as {
      nodeLine?: { line: number; provenance: string[]; satisfied: boolean };
    };
    expect(recordedRunPlan.nodeLine?.line).toBe(22);
    expect(recordedRunPlan.nodeLine?.satisfied).toBe(true);
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

  it("repairs a failed continuous take, revalidates it, and captures again within budget", async () => {
    // N137 (calcom, 2026-08-14): capture-path validation passed, but the
    // real take lost a client-navigation race on return-availability. The
    // take's typed failure must spend the bounded script lane, then pass the
    // static, dry-run, and fresh-runtime gates again before a retake.
    const calls: string[] = [];
    let footageAttempts = 0;
    const repairedCandidate = {
      ...scriptCandidate(),
      scriptJsonContent: { scriptId: "script_repaired" },
    };

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_footage_capture_repair" }),
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
          calls.push(`repair:${failureReport.stage}`);
          expect(failureReport.failedAction).toEqual({
            actionId: "return-availability",
            sceneId: "availability-settings",
          });
          return repairedCandidate;
        },
        async resetCaptureRuntime() {
          calls.push("reset");
          return report("capture-runtime-reset", "passed");
        },
        async validateCapturePath() {
          calls.push("dynamic");
          return report("capture-path-validation", "passed");
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
      {
        async captureAcceptedScript({ scriptCandidate: candidate }) {
          footageAttempts += 1;
          calls.push(
            `footage:${(candidate.scriptJsonContent as { scriptId?: string }).scriptId}`,
          );
          return footageAttempts === 1
            ? {
                ...report("footage-capture", "failed"),
                failedAction: {
                  actionId: "return-availability",
                  sceneId: "availability-settings",
                },
                failureClassification: "timing/state failure",
                logsSummary:
                  "Browser action return-availability failed in Scene availability-settings. goto: net::ERR_ABORTED",
              }
            : report("footage-capture", "passed");
        },
        scriptRepairLimit: 1,
      },
    );

    expect(result.status).toBe("passed");
    expect(result.scriptCandidate).toEqual(repairedCandidate);
    expect(calls).toEqual([
      "static",
      "reset",
      "dynamic",
      "reset",
      "footage:script_001",
      "repair:footage-capture",
      "static",
      "reset",
      "dynamic",
      "reset",
      "footage:script_repaired",
    ]);
    expect(
      result.validationReports.filter(
        (validation) => validation.stage === "footage-capture",
      ),
    ).toMatchObject([
      { retryCount: 0, status: "failed" },
      { retryCount: 1, status: "passed" },
    ]);
  });

  it("passes the failed candidate identity into locator regrounding", async () => {
    // N125: regrounding must know which candidate failed at replay — the
    // action, its verified locator, the scene prefix ahead of it, and the
    // failure screenshot — instead of re-exploring blind.
    const exploreInputs: Array<Record<string, unknown>> = [];
    let captureAttempts = 0;
    const scriptWithScenes = {
      ...scriptCandidate(),
      scriptJsonContent: {
        scenes: [
          {
            actions: [
              { id: "goto-dashboard", path: "/", type: "goto" },
              {
                id: "click-dashboard",
                locator: {
                  name: "Open dashboard",
                  role: "button",
                  strategy: "role",
                },
                locatorCandidateId: "open-dashboard-locator-1",
                sourceActionId: "open-dashboard",
                type: "click",
              },
            ],
            id: "scene-main",
          },
        ],
        scriptId: "script_001",
      },
    };

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_regrounding_identity" }),
      stubPipelineDependencies({
        async exploreApp(input) {
          exploreInputs.push(input);
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
          return scriptWithScenes;
        },
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
        },
        async validateCapturePath() {
          captureAttempts += 1;
          return captureAttempts === 1
            ? {
                ...report("capture-path-validation", "failed"),
                failedAction: {
                  actionId: "click-dashboard",
                  sceneId: "scene-main",
                },
                failureClassification: "locator failure",
                logsSummary:
                  "Browser action click-dashboard failed in Scene scene-main. locator resolution timed out",
                screenshots: ["/tmp/run/makeademo-validation-failure.png"],
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
          return scriptWithScenes;
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(exploreInputs).toHaveLength(2);
    expect(exploreInputs[0]).not.toHaveProperty("captureFailure");
    expect(exploreInputs[1]).toMatchObject({
      captureFailure: {
        actionId: "click-dashboard",
        locator: { name: "Open dashboard", role: "button", strategy: "role" },
        locatorCandidateId: "open-dashboard-locator-1",
        sceneId: "scene-main",
        scenePrefix: [{ id: "goto-dashboard", path: "/", type: "goto" }],
        screenshotPath: "/tmp/run/makeademo-validation-failure.png",
      },
    });
  });

  it("routes unreproducible regrounding evidence to preparation repair", async () => {
    // N125(3): when regrounding's prefix replay cannot reproduce the failed
    // candidate, the run must not die on the failed regrounding report or
    // burn the script budget — the app-state divergence goes to preparation
    // repair and the pipeline re-enters from validated preparation.
    const calls: string[] = [];
    let captureAttempts = 0;
    let exploreAttempts = 0;
    const scriptWithScenes = {
      ...scriptCandidate(),
      scriptJsonContent: {
        scenes: [
          {
            actions: [
              { id: "goto-root", path: "/", type: "goto" },
              {
                id: "click-save",
                locator: {
                  name: "Save entry",
                  role: "button",
                  strategy: "role",
                },
                locatorCandidateId: "save-entry-locator-1",
                sourceActionId: "open-dashboard",
                type: "click",
              },
            ],
            id: "scene-main",
          },
        ],
        scriptId: "script_001",
      },
    };

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_unreproducible_regrounding" }),
      stubPipelineDependencies({
        async exploreApp(input) {
          exploreAttempts += 1;
          if (input.captureFailure !== undefined) {
            calls.push(`reground:${exploreAttempts}`);
            return {
              kind: "repairable-failure" as const,
              validationReport: {
                ...report("app-exploration", "failed"),
                failureClassification: "evidence unreproducible at replay",
                logsSummary:
                  "Browser action click-save's locator could not be reproduced in its replay context.",
              },
            };
          }
          calls.push(`explore:${exploreAttempts}`);
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
          calls.push(`repair:${failureReport.failureClassification}`);
          return {
            manifest: { ...preparationManifest(), id: "prep_replay_fixed" },
          };
        },
        async resetCaptureRuntime() {
          return report("capture-runtime-reset", "passed");
        },
        async validateCapturePath() {
          captureAttempts += 1;
          calls.push(`capture:${captureAttempts}`);
          return captureAttempts === 1
            ? {
                ...report("capture-path-validation", "failed"),
                failedAction: {
                  actionId: "click-save",
                  sceneId: "scene-main",
                },
                failureClassification: "locator failure",
                logsSummary:
                  "Browser action click-save failed in Scene scene-main. locator resolution timed out",
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
          return scriptWithScenes;
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(calls).toEqual([
      "explore:1",
      "capture:1",
      "reground:2",
      "repair:evidence unreproducible at replay",
      "explore:3",
      "capture:2",
    ]);
  });

  it("stops a capture/static locator ping-pong with a combined diagnosis", async () => {
    // N125(4): capture keeps failing the browser-verified candidate at
    // replay while the static contract rejects every locator that differs
    // from it. Two consecutive pairs must stop the run with one combined
    // diagnosis instead of silently exhausting both repair budgets.
    let captureAttempts = 0;
    let staticAttempts = 0;
    const equalityRejection =
      'Browser action click-save locator does not match browser-verified candidate open-dashboard-locator-1: the script wrote {"name":"Save","role":"button","strategy":"role"} but the verified candidate is {"name":"Save entry","role":"button","strategy":"role"}';
    const scriptWithScenes = {
      ...scriptCandidate(),
      scriptJsonContent: {
        scenes: [
          {
            actions: [
              { id: "goto-root", path: "/", type: "goto" },
              {
                id: "click-save",
                locator: {
                  name: "Save entry",
                  role: "button",
                  strategy: "role",
                },
                locatorCandidateId: "open-dashboard-locator-1",
                sourceActionId: "open-dashboard",
                type: "click",
              },
            ],
            id: "scene-main",
          },
        ],
        scriptId: "script_001",
      },
    };

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_locator_ping_pong" }),
        stubPipelineDependencies({
          async exploreApp() {
            const catalog = actionCatalog();
            const [firstAction] = catalog.actions;
            if (firstAction === undefined) {
              throw new Error("Expected the dashboard action fixture");
            }
            // A second action keeps the catalog legal when the flow-lock
            // escape excludes the failing one before the breaker trips.
            return {
              kind: "artifacts" as const,
              actionCatalog: {
                ...catalog,
                actions: [firstAction, { ...firstAction, id: "open-settings" }],
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
          async repairScript() {
            return scriptWithScenes;
          },
          async resetCaptureRuntime() {
            return report("capture-runtime-reset", "passed");
          },
          async validateCapturePath() {
            captureAttempts += 1;
            return {
              ...report("capture-path-validation", "failed"),
              failedAction: { actionId: "click-save", sceneId: "scene-main" },
              failureClassification: "locator failure",
              logsSummary: `Browser action click-save failed in Scene scene-main. locator resolution timed out (attempt ${captureAttempts})`,
            };
          },
          async validatePreparation() {
            return report("preparation-preflight", "passed");
          },
          async validateScriptContract() {
            staticAttempts += 1;
            // Pass on odd attempts so capture runs; reject the repaired
            // script on even attempts — the alternating pattern.
            return staticAttempts % 2 === 1
              ? report("static-script-contract-validation", "passed")
              : {
                  ...report("static-script-contract-validation", "failed"),
                  failureClassification: "script contract failure",
                  logsSummary: equalityRejection,
                };
          },
          async writeScript() {
            return scriptWithScenes;
          },
        }),
      ),
    ).rejects.toThrow(/Locator ping-pong on browser action click-save/);

    expect(captureAttempts).toBe(2);
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
      patchSha256: `sha256:${String(round).repeat(64).slice(0, 64)}` as const,
      sourceCommitSha: "abc123def456",
    });

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_install_reuse" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCalls += 1;
          // Call order: initial fidelity diff; after repair 1; after
          // repair 2. Each repair lands a fresh source-only change.
          if (diffCalls === 1) return unchangedWorkspaceDiff();
          if (diffCalls === 2) return diffAfterRepair(1);
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

  it("passes the prior feature ledger and diff-touched features into repair validation", async () => {
    const verificationScopes: Array<
      Parameters<
        AgentHarnessPipelineDependencies["validatePreparation"]
      >[0]["repairFeatureVerification"]
    > = [];
    let preflightAttempts = 0;
    let diffCalls = 0;
    const dashboardFailure = {
      detail: "Dashboard overview was not found",
      failedBecause: "declared-proof-failed" as const,
      featureId: "dashboard",
      verdict: "failed" as const,
    };
    const repairedManifest = {
      ...preparationManifest(),
      envUsed: { MAKEADEMO_DEMO: "true" },
    };
    const repairedDiff = {
      changedFileSha256: {
        "src/page.tsx": `sha256:${"d".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/page.tsx"],
      patch:
        "diff --git a/src/page.tsx b/src/page.tsx\n+if (process.env.MAKEADEMO_DEMO === 'true') return 'Dashboard overview';",
      patchSha256: `sha256:${"d".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_repair_feature_scope" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCalls += 1;
          return diffCalls === 1 ? unchangedWorkspaceDiff() : repairedDiff;
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
          return { manifest: repairedManifest };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ repairFeatureVerification }) {
          preflightAttempts += 1;
          verificationScopes.push(repairFeatureVerification);
          return preflightAttempts === 1
            ? {
                ...report("preparation-preflight", "failed"),
                failingFeatureIds: ["dashboard"],
                failureClassification: "requested feature not observable",
                featureVerdicts: [dashboardFailure],
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
    expect(verificationScopes).toEqual([
      undefined,
      {
        priorFeatureVerdicts: [dashboardFailure],
        touchedFeatureIds: ["dashboard"],
      },
    ]);
  });

  it("reinstalls after a lifecycle timeout instead of reusing the incomplete install", async () => {
    // A timed-out lifecycle (N98) left native builds and postinstall codegen
    // unfinished: reusing that install would skip the lifecycle re-run and
    // send preflight against half-built node_modules.
    const installFlags: Array<boolean | undefined> = [];
    let preflightAttempts = 0;
    let diffCalls = 0;
    const sourceOnlyDiff = () => ({
      changedFileSha256: {
        "/workspace/repo/src/demo-fixtures.ts":
          `sha256:${"e".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/demo-fixtures.ts"],
      patch: [
        "diff --git a/src/demo-fixtures.ts b/src/demo-fixtures.ts",
        "new file mode 100644",
        "+export const fixtureRows = [1];",
      ].join("\n"),
      patchSha256: `sha256:${"f".repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    });

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_lifecycle_timeout_reinstall" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCalls += 1;
          return diffCalls <= 2 ? unchangedWorkspaceDiff() : sourceOnlyDiff();
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
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ installDependencies }) {
          preflightAttempts += 1;
          installFlags.push(installDependencies);
          return preflightAttempts <= 1
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "lifecycle timeout",
                logsSummary:
                  "Network-closed lifecycle scripts were killed after 5 minutes of silence with no CPU progress (exit 124).",
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
    // Round 2 must run a full install again, not reuse round 1's.
    expect(installFlags).toEqual([undefined, undefined]);
  });

  it("stops reusing the install after a reuse round's lifecycle times out", async () => {
    // N127: a reuse round re-runs the offline lifecycle on the re-synced
    // tree. A lifecycle timeout there gets a full-latitude repair, so a
    // source-only fix keeps dependency inputs unchanged — holding on to the
    // reused install would replay the identical timeout every round.
    const installFlags: Array<boolean | undefined> = [];
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
      patchSha256: `sha256:${String(round).repeat(64).slice(0, 64)}` as const,
      sourceCommitSha: "abc123def456",
    });

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_reuse_round_lifecycle_failure" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          diffCalls += 1;
          // Call order: round-1 fidelity diff; after repair 1; after
          // repair 2. Each repair lands a fresh source-only change.
          if (diffCalls === 1) return unchangedWorkspaceDiff();
          if (diffCalls === 2) return diffAfterRepair(1);
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
        async repairPreparation() {
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ installDependencies }) {
          preflightAttempts += 1;
          installFlags.push(installDependencies);
          if (preflightAttempts === 1) {
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "start failure",
              logsSummary: "boot failed round 1",
            };
          }
          if (preflightAttempts === 2) {
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "lifecycle timeout",
              logsSummary:
                "Network-closed lifecycle scripts were killed after 5 minutes of silence (exit 124).",
            };
          }
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
    // Round 2 reuses round 1's install and its lifecycle times out, so
    // round 3 must reinstall even though repair 2 touched only source.
    expect(installFlags).toEqual([undefined, false, undefined]);
  });

  it("never dispatches a repair agent for a harness-internal validation failure", async () => {
    // Repair-evidence contract clause 5 (N62): infra errors must not reach
    // agent prompts or spend repair budget — outline's fallback once asked a
    // future coding agent to "fix" a Daytona control-plane error. A
    // harness-internal failure gets one agent-free revalidation (transient
    // blips recover), then fails the run as infrastructure.
    let preflightAttempts = 0;
    let repairs = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_internal_failure" }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return unchangedWorkspaceDiff();
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            repairs += 1;
            return { manifest: preparationManifest() };
          },
          async validatePreparation() {
            preflightAttempts += 1;
            return {
              ...report("preparation-preflight", "failed"),
              failureClassification: "harness/internal failure",
              logsSummary:
                "Failed to reset submitted-code workspace: Daytona rejected the update",
            };
          },
          async writeScript() {
            return scriptCandidate();
          },
        }),
      ),
    ).rejects.toThrow(/not agent-repairable/);
    expect(repairs).toBe(0);
    expect(preflightAttempts).toBe(2);
  });

  it("recovers from a transient harness-internal failure without spending repairs", async () => {
    let preflightAttempts = 0;
    let repairs = 0;

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_internal_recovery" }),
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
          return { manifest: preparationManifest() };
        },
        async repairPreparation() {
          repairs += 1;
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          return preflightAttempts === 1
            ? {
                ...report("preparation-preflight", "failed"),
                failureClassification: "harness/internal failure",
                logsSummary: "Failed to reset submitted-code workspace: blip",
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
    expect(repairs).toBe(0);
    expect(preflightAttempts).toBe(2);
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

  it("overturns a false fidelity veto through the adjudicator", async () => {
    // The judge-on-veto lane (N92): heuristic candidates are proposals, and
    // an agent judge with the diff in front of it can overturn a false veto
    // before it costs a repair round.
    const judged: unknown[] = [];
    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_fidelity_adjudicated" }),
      stubPipelineDependencies({
        async adjudicateFidelityCandidates({ candidates }) {
          judged.push(candidates);
          return candidates.map((_, candidateIndex) => ({
            candidateIndex,
            quotedEvidence: [],
            verdict: "overturn" as const,
          }));
        },
        async capturePreparationWorkspaceDiff() {
          return presentationVetoWorkspaceDiff();
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
    expect(judged).toHaveLength(1);
    const fidelityReport = result.validationReports.find(
      (entry) => entry.stage === "preparation-fidelity",
    );
    expect(fidelityReport).toMatchObject({
      fidelityAdjudication: {
        outcomes: [expect.objectContaining({ outcome: "overturned" })],
        status: "adjudicated",
      },
      status: "passed",
    });
  });

  it("fails a word-only stub structurally without invoking fidelity adjudication", async () => {
    let adjudications = 0;
    let repairs = 0;
    const wordOnlyManifest = {
      ...preparationManifest(),
      dataStrategy: [
        {
          detail: "No fixture adapter was added for this API.",
          rung: "declared-stub" as const,
          service: "directus-api",
        },
      ],
      envUsed: { NODE_ENV: "development" },
      localDemoModeChanges: [],
      mocksAndFixturesAdded: [],
    };
    const deliveredManifest = {
      ...wordOnlyManifest,
      dataStrategy: [
        {
          detail: "The existing API client returns deterministic fixtures.",
          rung: "client-stub" as const,
          service: "directus-api",
        },
      ],
      mocksAndFixturesAdded: [
        "src/demo-fixtures.json supplies deterministic API rows.",
      ],
    };
    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_structural_stub_fidelity" }),
      stubPipelineDependencies({
        async adjudicateFidelityCandidates({ candidates }) {
          adjudications += 1;
          return candidates.map((_, candidateIndex) => ({
            candidateIndex,
            quotedEvidence: [],
            verdict: "overturn" as const,
          }));
        },
        async capturePreparationWorkspaceDiff() {
          return {
            changedFileSha256: {
              "src/demo-fixtures.json": `sha256:${"d".repeat(64)}` as const,
            },
            changedPaths: ["/workspace/repo/src/demo-fixtures.json"],
            patch: [
              "diff --git a/src/demo-fixtures.json b/src/demo-fixtures.json",
              "new file mode 100644",
              '+{"projects":[{"id":"demo"}]}',
            ].join("\n"),
            patchSha256: `sha256:${"d".repeat(64)}` as const,
            sourceCommitSha: "abc123def456",
          };
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
          return { manifest: wordOnlyManifest };
        },
        async repairPreparation() {
          repairs += 1;
          return { manifest: deliveredManifest };
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
    expect(repairs).toBe(1);
    expect(adjudications).toBe(0);
    expect(result.validationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failureClassification: "product fidelity violation",
          logsSummary: expect.stringContaining("directus-api"),
          stage: "preparation-fidelity",
          status: "failed",
        }),
      ]),
    );
  });

  it("keeps the veto and reports unadjudicated when the judge fails", async () => {
    let diffAttempts = 0;
    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_fidelity_judge_failed" }),
      stubPipelineDependencies({
        async adjudicateFidelityCandidates() {
          throw new Error("judge unavailable");
        },
        async capturePreparationWorkspaceDiff() {
          diffAttempts += 1;
          return diffAttempts === 1
            ? presentationVetoWorkspaceDiff()
            : unchangedWorkspaceDiff();
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
          return { manifest: preparationManifest() };
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
    const failedFidelity = result.validationReports.find(
      (entry) =>
        entry.stage === "preparation-fidelity" && entry.status === "failed",
    );
    expect(failedFidelity).toMatchObject({
      failureClassification: "product fidelity violation",
      fidelityAdjudication: {
        outcomes: [expect.objectContaining({ outcome: "unjudged" })],
        status: "unadjudicated",
      },
    });
  });

  it("discards the adjudication when the workspace diff changes under the judge", async () => {
    let diffAttempts = 0;
    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_fidelity_diff_changed" }),
      stubPipelineDependencies({
        async adjudicateFidelityCandidates({ candidates }) {
          return candidates.map((_, candidateIndex) => ({
            candidateIndex,
            quotedEvidence: [],
            verdict: "overturn" as const,
          }));
        },
        async capturePreparationWorkspaceDiff() {
          diffAttempts += 1;
          if (diffAttempts === 1) {
            return presentationVetoWorkspaceDiff();
          }
          if (diffAttempts === 2) {
            return {
              ...presentationVetoWorkspaceDiff(),
              patchSha256: `sha256:${"e".repeat(64)}` as const,
            };
          }
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
          return { manifest: preparationManifest() };
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
    const failedFidelity = result.validationReports.find(
      (entry) =>
        entry.stage === "preparation-fidelity" && entry.status === "failed",
    );
    expect(failedFidelity).toMatchObject({
      fidelityAdjudication: { status: "discarded-diff-changed" },
    });
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

  it("feeds observed auth-wall verdicts into the next round's fidelity check", async () => {
    // The failure report that triggers a repair carries exploration's
    // feature verdicts; post-repair fidelity must see them, so a manifest
    // that still declares authStrategy "none" over an observed wall
    // reaches the judge instead of passing on prose alone (N111).
    const repairedStages: string[] = [];
    let fidelityFailureSummary = "";

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_auth_wall_contradiction" }),
        stubPipelineDependencies({
          capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation({ failureReport }) {
            repairedStages.push(failureReport.stage);
            if (failureReport.stage === "preparation-fidelity") {
              fidelityFailureSummary = failureReport.logsSummary;
            }
            return { manifest: preparationManifest() };
          },
          async resetCaptureRuntime() {
            throw new Error("Capture reset must not run.");
          },
          async validatePreparation() {
            return {
              ...report("preparation-preflight", "failed"),
              attemptedCommand: "bun run dev",
              failureClassification: "start failure",
              featureVerdicts: [
                {
                  detail: "entry route / redirected to /login",
                  failedBecause: "auth-wall" as const,
                  featureId: "dashboard",
                  verdict: "failed" as const,
                },
              ],
              logsSummary:
                "Feature dashboard's entry routes sit behind an authentication redirect.",
            };
          },
        }),
        { repoPreparationRepairLimit: 2 },
      ),
    ).rejects.toThrow("failed");

    expect(repairedStages).toEqual([
      "preparation-preflight",
      "preparation-fidelity",
    ]);
    expect(fidelityFailureSummary).toContain("authentication wall");
    expect(fidelityFailureSummary).toContain("dashboard");
    expect(fidelityFailureSummary).toContain('authStrategy "none"');
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
          // Call order: initial fidelity diff; the failed install's
          // post-validation lockfile check; after the no-op dependency
          // repair; after the invalid repair; after the valid repair.
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
    // The no-op repair round ran no fidelity validation, so the vetoed
    // diff lands at attempt 2.
    expect(
      artifacts[
        "/workspace/.makeademo/validation-attempts/preparation-fidelity/attempt-2-workspace-diff.json"
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
    // The third repair heeds the veto: it re-applies only the fixtures
    // change, a real diff that violates nothing.
    const heededVetoDiff = {
      changedFileSha256: {
        "src/demo/fixtures.ts": `sha256:${"d".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/demo/fixtures.ts"],
      patch:
        "diff --git a/src/demo/fixtures.ts b/src/demo/fixtures.ts\n+export const fixtures = [];",
      patchSha256: `sha256:${"d".repeat(64)}` as const,
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
          if (diffAttempt === 2 || diffAttempt === 3) return invalidDiff;
          if (diffAttempt >= 4) return heededVetoDiff;
          return unchangedWorkspaceDiff();
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
    // The second repair replaces the vetoed change with a fixtures-only
    // diff, so it counts as a real attempt rather than a bare revert.
    const heededVetoDiff = {
      changedFileSha256: {
        "src/demo/fixtures.ts": `sha256:${"d".repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/demo/fixtures.ts"],
      patch:
        "diff --git a/src/demo/fixtures.ts b/src/demo/fixtures.ts\n+export const fixtures = [];",
      patchSha256: `sha256:${"d".repeat(64)}` as const,
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
          if (diffAttempt === 2) return invalidDiff;
          if (diffAttempt >= 3) return heededVetoDiff;
          return unchangedWorkspaceDiff();
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

  it("escalates a second unbuilt workspace failure to the app dependency graph", async () => {
    // N155 (directus, 2026-08-15): repairing only the package named by each
    // crash bounced from extensions to constants and back. Once one such
    // repair has run, the next package proves the app's build graph is the
    // unit of repair.
    const graphBuild = "pnpm --recursive --filter=@directus/app... run build";
    const narrowBuild = "pnpm --filter=@directus/extensions run build";
    const repairHints: string[] = [];
    const preflightBuilds: Array<string | undefined> = [];
    let preflightAttempts = 0;
    const basePreparationManifest = preparationManifest();
    const preparedManifest = {
      ...basePreparationManifest,
      appDir: "app",
      baseUrl: "http://127.0.0.1:5173",
      installCommandUsed: "pnpm install --frozen-lockfile",
      ports: [5173],
      productContext: {
        ...basePreparationManifest.productContext,
        evidencePaths: ["app/package.json", "app/src/page.tsx"],
        featureInventory:
          basePreparationManifest.productContext.featureInventory.map(
            (feature) => ({
              ...feature,
              sourcePaths: ["app/src/page.tsx"],
            }),
          ),
      },
      startCommandUsed: "pnpm run dev",
    };
    const selectedRunPlan = {
      ...runPlan(),
      allowedPorts: [5173],
      appDir: "app",
      expectedLocalUrl: "http://127.0.0.1:5173",
      installCommand: "pnpm install --frozen-lockfile",
      runtime: "node" as const,
      startCommand: "pnpm run dev",
      targetSelection: {
        evidencePaths: ["app/package.json", "app/src/page.tsx"],
        reason: "The app workspace is the product surface.",
        role: "product" as const,
        source: "model" as const,
        targetId: "app",
      },
    };

    const result = await runAgentHarnessPipeline(
      pipelineInput({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({
              name: "directus-monorepo",
              packageManager: "pnpm@10.0.0",
              scripts: { build: "pnpm --recursive run build" },
              workspaces: ["app", "packages/*"],
            }),
          },
          { path: "pnpm-lock.yaml", text: "" },
          {
            path: "app/package.json",
            text: JSON.stringify({
              dependencies: {
                "@directus/constants": "workspace:*",
                "@directus/extensions": "workspace:*",
              },
              name: "@directus/app",
              scripts: { build: "vite build", dev: "vite --host" },
            }),
          },
          { path: "app/src/page.tsx", text: "export default 1" },
          {
            path: "packages/extensions/package.json",
            text: JSON.stringify({
              dependencies: { "@directus/constants": "workspace:*" },
              name: "@directus/extensions",
              scripts: { build: "tsdown" },
            }),
          },
          {
            path: "packages/constants/package.json",
            text: JSON.stringify({
              name: "@directus/constants",
              scripts: { build: "tsdown" },
            }),
          },
        ],
        runId: "run_workspace_graph_escalation",
      }),
      stubPipelineDependencies({
        capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
          return { manifest: preparedManifest };
        },
        async repairPreparation({ failureReport, preparationManifest }) {
          repairHints.push(failureReport.suggestedRepairHints.join("\n"));
          const buildCommandUsed =
            repairHints.length === 1 ? narrowBuild : graphBuild;
          return {
            manifest: {
              ...preparationManifest,
              buildCommandUsed,
              id: `prep_workspace_graph_${repairHints.length}`,
            },
          };
        },
        async synthesizeRunPlan() {
          return selectedRunPlan;
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation({ preparationManifest }) {
          preflightAttempts += 1;
          preflightBuilds.push(preparationManifest.buildCommandUsed);
          const packageName = ["@directus/extensions", "@directus/constants"][
            preflightAttempts - 1
          ];
          return packageName === undefined
            ? report("preparation-preflight", "passed")
            : {
                ...report("preparation-preflight", "failed"),
                failureClassification: "unbuilt workspace dependency",
                logsSummary: `Unbuilt workspace dependency ${packageName}: its dist entry is missing`,
                suggestedRepairHints: [`Build ${packageName} before the app.`],
              };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript({ preparationManifest }) {
          return {
            ...scriptCandidate(),
            sourcePreparationManifestId: preparationManifest.id,
          };
        },
      }),
    );

    expect(result.status).toBe("passed");
    expect(repairHints[0]).not.toContain("workspace dependency graph");
    expect(repairHints[1]).toContain("workspace dependency graph");
    expect(repairHints[1]).toContain(graphBuild);
    expect(preflightBuilds).toEqual([undefined, narrowBuild, graphBuild]);
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
          capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
          capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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

  it("does not collapse failures that share a symptom line but hide different causes", async () => {
    // The probe symptom (`curl: (7)`) is identical on every attempt; the
    // decisive cause buried in the managed output differs each time. Each
    // failure is new information, so the repeated-failure limit must not
    // fire while the causes keep changing.
    let preflightAttempts = 0;
    let repairAttempts = 0;
    const causes = [
      "Error: NEXTAUTH_SECRET must be set",
      "SyntaxError: Unexpected token '}' in /workspace/config.json",
      'x No package found for "react-email"',
    ];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_shared_symptom_distinct_causes" }),
      stubPipelineDependencies({
        capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
          repairAttempts += 1;
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          const cause = causes[preflightAttempts - 1];
          if (cause === undefined) {
            return report("preparation-preflight", "passed");
          }
          return {
            ...report("preparation-preflight", "failed"),
            attemptedCommand: "bun run dev",
            failureClassification: "start failure",
            logsSummary: `Start command was not reachable: curl: (7) Failed to connect to 127.0.0.1 port 3000\n$ next start\n${cause}`,
          };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
      { repoPreparationRepairLimit: 5 },
    );

    expect(result.status).toBe("passed");
    expect(repairAttempts).toBe(3);
    expect(preflightAttempts).toBe(4);
  });

  it("does not collapse distinct causes behind the same package-manager epilogue", async () => {
    // N130 (directus, 2026-08-13): pnpm ends every failed run with the same
    // ` ELIFECYCLE ` epilogue, and the fingerprint's cause line landed on it
    // — three distinct crashes counted as one repeat and the run died on the
    // repeated-failure limit with the global budget barely touched.
    let preflightAttempts = 0;
    let repairAttempts = 0;
    const causes = [
      '✗ [ERROR] Could not resolve "./dist/node.js"',
      "SyntaxError: Unexpected end of JSON input in /workspace/repo/packages/extensions/package.json",
      'Error: Cannot find module "@directus/extensions/dist/index.mjs"',
    ];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_epilogue_distinct_causes" }),
      stubPipelineDependencies({
        capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
          repairAttempts += 1;
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          const cause = causes[preflightAttempts - 1];
          if (cause === undefined) {
            return report("preparation-preflight", "passed");
          }
          return {
            ...report("preparation-preflight", "failed"),
            attemptedCommand: "pnpm run dev",
            failureClassification: "start failure",
            logsSummary: [
              "Start command exited with code 1",
              cause,
              " ELIFECYCLE  Command failed with exit code 1.",
              'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  "@directus/extensions#build" failed',
            ].join("\n"),
          };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
      { repoPreparationRepairLimit: 5 },
    );

    expect(result.status).toBe("passed");
    expect(repairAttempts).toBe(3);
    expect(preflightAttempts).toBe(4);
  });

  it("collapses failures whose symptom lines differ while the decisive cause repeats", async () => {
    // The curl exit code drifts run to run, but every attempt dies on the
    // same EADDRINUSE cause line — the same wall, so the repeated-failure
    // limit must fire instead of burning the whole repair budget.
    let preflightAttempts = 0;
    let repairAttempts = 0;
    const symptoms = [
      "curl: (7) Failed to connect to 127.0.0.1 port 3000",
      "curl: (56) Recv failure: Connection reset by peer",
      "curl: (28) Operation timed out after 30001 milliseconds",
    ];

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_drifting_symptom_same_cause" }),
        stubPipelineDependencies({
          capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
            const symptom =
              symptoms[Math.min(preflightAttempts, symptoms.length) - 1];
            return {
              ...report("preparation-preflight", "failed"),
              attemptedCommand: "bun run dev",
              failureClassification: "start failure",
              logsSummary: `Start command was not reachable: ${symptom}\nError: listen EADDRINUSE: address already in use 0.0.0.0:3000`,
            };
          },
        }),
        { repoPreparationRepairLimit: 5 },
      ),
    ).rejects.toThrow("repeated failure");

    expect(repairAttempts).toBe(2);
  });

  it("collapses repeats whose cause line varies only by a debug-log timestamp path", async () => {
    // npm's terminal error line points at a per-run debug log whose file
    // name embeds an underscore-separated timestamp. That noise must not
    // make the same failure look new to the repeated-failure limit.
    let preflightAttempts = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_debug_log_timestamp_noise" }),
        stubPipelineDependencies({
          capturePreparationWorkspaceDiff: advancingWorkspaceDiffCapture(),
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
              attemptedCommand: "npm start",
              failureClassification: "start failure",
              logsSummary: [
                "Start command exited before the app became reachable",
                "npm ERR! code ELIFECYCLE",
                `npm ERR! A complete log of this run can be found in: /root/.npm/_logs/2026-08-10T21_0${preflightAttempts}_49_340Z-debug-0.log`,
              ].join("\n"),
            };
          },
        }),
        { repoPreparationRepairLimit: 5 },
      ),
    ).rejects.toThrow("repeated failure");

    expect(repairAttempts).toBe(2);
  });

  it("rejects a repair that changes nothing without spending the repair budget", async () => {
    // Rounds 1-2 return the workspace and manifest untouched: non-attempts
    // that must not burn the (deliberately tiny) global budget and must not
    // re-run the preflight. Round 3 fixes the manifest alone — a real
    // repair even though the workspace still did not change.
    let preflightAttempts = 0;
    const repairSummaries: string[] = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_noop_repair_non_attempt" }),
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
          return { manifest: preparationManifest() };
        },
        async repairPreparation({ failureReport }) {
          repairSummaries.push(failureReport.logsSummary);
          if (repairSummaries.length < 3) {
            return { manifest: preparationManifest() };
          }
          return {
            manifest: { ...preparationManifest(), envUsed: { DEMO_MODE: "1" } },
          };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          if (preflightAttempts === 1) {
            return {
              ...report("preparation-preflight", "failed"),
              attemptedCommand: "bun run dev",
              failureClassification: "start failure",
              logsSummary:
                "Start command was not reachable: connection refused",
            };
          }
          return report("preparation-preflight", "passed");
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
      { repoPreparationRepairLimit: 1 },
    );

    expect(result.status).toBe("passed");
    expect(preflightAttempts).toBe(2);
    expect(repairSummaries).toHaveLength(3);
    expect(repairSummaries[1]).toContain(
      "Rejected repair: the repair produced no change",
    );
    expect(repairSummaries[2]).toContain(
      "Rejected repair: the repair produced no change",
    );
  });

  it("charges no-op repairs after two free rounds so they still terminate", async () => {
    let preflightAttempts = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_endless_noop_repairs" }),
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
              logsSummary:
                "Start command was not reachable: connection refused",
            };
          },
        }),
        { repoPreparationRepairLimit: 5 },
      ),
    ).rejects.toThrow("repeated failure");

    // Two free rounds, then two charged rounds against the rejected
    // failure's fingerprint; the fifth dispatch trips the repeated-failure
    // limit. The preflight never re-ran for any of them.
    expect(repairAttempts).toBe(4);
    expect(preflightAttempts).toBe(1);
  });

  it("rejects a dependency repair that changes nothing with the dependency-lane steering", async () => {
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
    let preflightAttempts = 0;
    let realRepairDone = false;
    const repairSummaries: string[] = [];
    const repairHints: string[][] = [];

    const result = await runAgentHarnessPipeline(
      pipelineInput({ runId: "run_noop_dependency_repair" }),
      stubPipelineDependencies({
        async capturePreparationWorkspaceDiff() {
          return realRepairDone ? dependencyDiff : unchangedWorkspaceDiff();
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
          repairSummaries.push(failureReport.logsSummary);
          repairHints.push([...failureReport.suggestedRepairHints]);
          if (repairSummaries.length === 2) {
            realRepairDone = true;
          }
          return { manifest: preparationManifest() };
        },
        async validateCapturePath() {
          return report("capture-path-validation", "passed");
        },
        async validatePreparation() {
          preflightAttempts += 1;
          if (realRepairDone) {
            return report("preparation-preflight", "passed");
          }
          return {
            ...report("preparation-preflight", "failed"),
            attemptedCommand: "bun install --frozen-lockfile",
            failureClassification: "install failure",
            logsSummary: "Install failed: error: lockfile had changes",
          };
        },
        async validateScriptContract() {
          return report("static-script-contract-validation", "passed");
        },
        async writeScript() {
          return scriptCandidate();
        },
      }),
      { repoPreparationRepairLimit: 1 },
    );

    expect(result.status).toBe("passed");
    expect(preflightAttempts).toBe(2);
    expect(repairSummaries).toHaveLength(2);
    expect(repairSummaries[1]).toContain(
      "Rejected repair: no package manifest or recognized package-manager configuration changed.",
    );
    expect(repairHints[1]).toContain(
      "Change the dependency metadata responsible for the reported install failure; do not rewrite the manifest or executable source.",
    );
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
      {
        failureClassification: "app route crashes",
        logsSummary: "Feature route threw before rendering",
      },
      {
        failureClassification: "browser console/page error",
        logsSummary: "Feature route logged an uncaught error",
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

    // The three preflight repairs spend 3 of the global 5; exploration may
    // spend the remaining 2 plus its own 2-round reserve (N93) before the
    // fifth exploration failure exhausts the widened cap.
    expect(repairStages).toEqual([
      "preparation-preflight",
      "preparation-preflight",
      "preparation-preflight",
      "app-exploration",
      "app-exploration",
      "app-exploration",
      "app-exploration",
    ]);
    expect(diffCaptures).toBe(8);
  });

  it("reserves two exploration repair rounds when earlier stages spent the global budget", async () => {
    // ghost (2026-08-09): three preflight repairs plus two false fidelity
    // vetoes consumed the whole global budget of 5 before exploration ever
    // got a repair round — the data-path steering never reached an agent.
    // Exploration is the terminal preparation gate, so its failures may
    // spend up to two rounds beyond the global limit; the widened cap
    // stays hard and earlier stages get no reservation.
    let explorationAttempts = 0;
    let explorationRepairs = 0;
    let preflightFailures = 0;
    let repairAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_exploration_reserve" }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return preparationWorkspaceDiff();
          },
          async exploreApp() {
            explorationAttempts += 1;
            return {
              kind: "artifacts" as const,
              actionCatalog: actionCatalog(),
              appMap: appMap(),
              validationReport: {
                ...report("app-exploration", "failed"),
                failureClassification: "empty/unmeaningful app state",
                logsSummary: `Feature route rendered no content: probe ${"x".repeat(explorationAttempts)}`,
              },
            };
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation({ failureReport }) {
            repairAttempts += 1;
            if (failureReport.stage === "app-exploration") {
              explorationRepairs += 1;
            }
            return {
              manifest: {
                ...preparationManifest(),
                id: `prep_repaired_${repairAttempts}`,
              },
            };
          },
          async validatePreparation() {
            if (preflightFailures < 2) {
              preflightFailures += 1;
              return {
                ...report("preparation-preflight", "failed"),
                failureClassification: "start failure",
                logsSummary: `App is not ready: probe ${"y".repeat(preflightFailures)}`,
              };
            }
            return report("preparation-preflight", "passed");
          },
        }),
        { repoPreparationRepairLimit: 2 },
      ),
    ).rejects.toThrow("global retry budget exhausted");

    // The two preflight repairs spend the whole global budget of 2; the
    // reserve still grants exploration exactly two repair rounds before
    // its third failure exhausts the widened cap.
    expect(explorationRepairs).toBe(2);
    expect(explorationAttempts).toBe(3);
    expect(repairAttempts).toBe(4);
  });

  it("grants bonus repair rounds while the failing-feature set strictly shrinks, capped at two", async () => {
    let explorationAttempts = 0;
    let repairAttempts = 0;
    const failingFeatureSets = [
      ["feature-a", "feature-b", "feature-c", "feature-d", "feature-e"],
      ["feature-a", "feature-b", "feature-c", "feature-d"],
      ["feature-a", "feature-b", "feature-c"],
      ["feature-a", "feature-b"],
      ["feature-a"],
      ["feature-b"],
      ["feature-c"],
    ];

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_progress_bonus" }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return preparationWorkspaceDiff();
          },
          async exploreApp() {
            explorationAttempts += 1;
            const failingFeatureIds =
              failingFeatureSets[explorationAttempts - 1];
            if (failingFeatureIds === undefined) {
              throw new Error("Unexpected exploration attempt.");
            }
            return {
              kind: "artifacts" as const,
              actionCatalog: actionCatalog(),
              appMap: appMap(),
              validationReport: {
                ...report("app-exploration", "failed"),
                failingFeatureIds,
                failureClassification: "requested feature not observable",
                logsSummary: `No browser evidence for requested features: ${failingFeatureIds.join(", ")}`,
              },
            };
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            repairAttempts += 1;
            return {
              manifest: {
                ...preparationManifest(),
                id: `prep_repaired_${repairAttempts}`,
              },
            };
          },
          async validatePreparation() {
            return report("preparation-preflight", "passed");
          },
        }),
        { repoPreparationRepairLimit: 2 },
      ),
    ).rejects.toThrow("global retry budget exhausted");

    // Base limit 2, plus one bonus per shrinking round capped at +2, plus
    // the exploration reserve of +2 (N93): six repairs run before the
    // seventh failure exhausts the budget.
    expect(repairAttempts).toBe(6);
    expect(explorationAttempts).toBe(7);
  });

  it("grants no bonus round when the failing-feature set merely changes", async () => {
    let explorationAttempts = 0;
    let repairAttempts = 0;
    const failingFeatureSets = [
      ["feature-a", "feature-b"],
      ["feature-c", "feature-d"],
      ["feature-e", "feature-f"],
      ["feature-g", "feature-h"],
      ["feature-i", "feature-j"],
    ];

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_progress_no_bonus" }),
        stubPipelineDependencies({
          async capturePreparationWorkspaceDiff() {
            return preparationWorkspaceDiff();
          },
          async exploreApp() {
            explorationAttempts += 1;
            const failingFeatureIds =
              failingFeatureSets[explorationAttempts - 1];
            if (failingFeatureIds === undefined) {
              throw new Error("Unexpected exploration attempt.");
            }
            return {
              kind: "artifacts" as const,
              actionCatalog: actionCatalog(),
              appMap: appMap(),
              validationReport: {
                ...report("app-exploration", "failed"),
                failingFeatureIds,
                failureClassification: "requested feature not observable",
                logsSummary: `No browser evidence for requested features: ${failingFeatureIds.join(", ")}`,
              },
            };
          },
          async prepareRepo() {
            return { manifest: preparationManifest() };
          },
          async repairPreparation() {
            repairAttempts += 1;
            return {
              manifest: {
                ...preparationManifest(),
                id: `prep_repaired_${repairAttempts}`,
              },
            };
          },
          async validatePreparation() {
            return report("preparation-preflight", "passed");
          },
        }),
        { repoPreparationRepairLimit: 2 },
      ),
    ).rejects.toThrow("global retry budget exhausted");

    // Base limit 2 plus the exploration reserve of +2 (N93), and no bonus
    // for merely-changing feature sets: four repairs, not the six a
    // shrinking set earns.
    expect(repairAttempts).toBe(4);
    expect(explorationAttempts).toBe(5);
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

  it("stops an identical capture protocol violation after one script repair", async () => {
    let captureAttempts = 0;
    let repairAttempts = 0;
    let staticAttempts = 0;

    await expect(
      runAgentHarnessPipeline(
        pipelineInput({ runId: "run_repeated_capture_protocol_violation" }),
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
          async repairScript() {
            repairAttempts += 1;
            return scriptCandidate();
          },
          async validateCapturePath() {
            captureAttempts += 1;
            return {
              ...report("capture-path-validation", "failed"),
              failureClassification: "script contract failure",
              logsSummary:
                "Capture Script Protocol Violation: Capture script emitted nested Browser Action markers: page.waitForURL(/roles/new) was still open when locator.click(Create role) started.",
            };
          },
          async validatePreparation() {
            return report("preparation-preflight", "passed");
          },
          async validateScriptContract() {
            staticAttempts += 1;
            return report("static-script-contract-validation", "passed");
          },
          async writeScript() {
            return scriptCandidate();
          },
        }),
      ),
    ).rejects.toThrow(
      "script-repair repeated failure retry budget exhausted after 1 attempts",
    );

    expect(captureAttempts).toBe(2);
    expect(repairAttempts).toBe(1);
    expect(staticAttempts).toBe(2);
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

/** A diff that trips exactly one fidelity candidate: new markup in an original UI file. */
function presentationVetoWorkspaceDiff() {
  return {
    changedFileSha256: {
      "src/page.tsx": `sha256:${"d".repeat(64)}` as const,
    },
    changedPaths: ["/workspace/repo/src/page.tsx"],
    patch: [
      "diff --git a/src/page.tsx b/src/page.tsx",
      "-export default 1",
      "+export default <main>Demo banner</main>;",
    ].join("\n"),
    patchSha256: `sha256:${"d".repeat(64)}` as const,
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

/**
 * A capture stub whose diff advances on every call, so each repair round
 * reads as a real workspace change rather than a no-op resubmission.
 */
function advancingWorkspaceDiffCapture() {
  let captures = 0;
  return async () => {
    captures += 1;
    const digit = String(captures % 10);
    return {
      changedFileSha256: {
        "src/demo.ts": `sha256:${digit.repeat(64)}` as const,
      },
      changedPaths: ["/workspace/repo/src/demo.ts"],
      patch: `diff --git a/src/demo.ts b/src/demo.ts\n+// capture ${captures}`,
      patchSha256: `sha256:${digit.repeat(64)}` as const,
      sourceCommitSha: "abc123def456",
    };
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
    // An honest manifest over the stubs' often-empty diffs: the vacuity
    // candidate (N111) targets manifests that claim features while
    // declaring no demo machinery at all.
    localDemoModeChanges: [
      "MAKEADEMO_DEMO=true activates the repository's existing demo mode.",
    ],
    mocksAndFixturesAdded: [],
    ports: [3000],
    productContext: {
      evidencePaths: ["package.json"],
      featureInventory: [
        {
          authStrategy: "none" as const,
          description: "Show the dashboard.",
          entryPaths: ["/"],
          expectedProof: {
            kind: "visible-text" as const,
            text: "Dashboard overview",
          },
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
    browserActionCompilerVersion: "2026-08-14.1",
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

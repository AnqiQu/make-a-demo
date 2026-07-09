import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspace } from "../daytona/workspace.interface";
import type { OpenCodeHarnessRunner } from "../opencode/opencode-harness";
import type {
  PreparationManifest,
  RepoProfile,
  RunPlan,
} from "../schemas/artifacts";
import { createDefaultAgentHarnessDependencies } from "./default-harness-dependencies";

describe("createDefaultAgentHarnessDependencies", () => {
  it("clones submitted repos with the Daytona CA bundle when provider secrets hide Git CA config", async () => {
    const workspace = secretMountedDaytonaWorkspace();
    const harness = await createDefaultAgentHarnessDependencies({
      artifactStore: { async writeJson() {} },
      openCodeRunner: repoPreparationRunner(),
      outputRoot: "/tmp/makeademo-test",
    });

    await expect(
      harness.dependencies.prepareRepo({
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: undefined,
        repoProfile: repoProfile(),
        runPlan: runPlan(),
        workspace,
      }),
    ).resolves.toMatchObject({
      manifest: { id: "prep_001" },
      opencodeSessionId: "session_prepare",
    });

    expect(workspace.networkAccessRequests).toEqual([true]);
  });

  it("runs Repo Preparation repair when OpenCode succeeds without writing the manifest", async () => {
    const workspace = repairableRepoPreparationWorkspace();
    const stages: string[] = [];
    const harness = await createDefaultAgentHarnessDependencies({
      artifactStore: { async writeJson() {} },
      openCodeRunner: {
        async run(input) {
          stages.push(input.stage);
          if (input.stage === "repo-preparation") {
            return {
              exitCode: 0,
              sessionId: "session_prepare",
              stderr: "",
              stdout: "Finished, but no artifact was written.",
            };
          }

          expect(input.stage).toBe("repo-preparation-repair");
          expect(input.sessionId).toBe("session_prepare");
          expect(input.prompt).toContain(
            "Repo Preparation completed without producing the required artifact",
          );
          workspace.writePreparationManifest();
          return {
            exitCode: 0,
            sessionId: "session_prepare",
            stderr: "",
            stdout: "Wrote preparation-manifest.json.",
          };
        },
      },
      outputRoot: "/tmp/makeademo-test",
    });

    await expect(
      harness.dependencies.prepareRepo({
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: undefined,
        repoProfile: repoProfile(),
        runPlan: runPlan(),
        workspace,
      }),
    ).resolves.toMatchObject({
      manifest: { id: "prep_001" },
      opencodeSessionId: "session_prepare",
    });

    expect(stages).toEqual(["repo-preparation", "repo-preparation-repair"]);
  });

  it("runs Repo Preparation repair when the manifest fails schema validation", async () => {
    const workspace = schemaRepairableRepoPreparationWorkspace();
    const stages: string[] = [];
    const harness = await createDefaultAgentHarnessDependencies({
      artifactStore: { async writeJson() {} },
      openCodeRunner: {
        async run(input) {
          stages.push(input.stage);
          if (input.stage === "repo-preparation") {
            return {
              exitCode: 0,
              sessionId: "session_prepare",
              stderr: "",
              stdout: "Wrote a malformed preparation manifest.",
            };
          }

          expect(input.stage).toBe("repo-preparation-repair");
          expect(input.sessionId).toBe("session_prepare");
          expect(input.prompt).toContain(
            "blockedExternalServicesReplaced[0] must be a string",
          );
          expect(input.prompt).toContain(
            "envUsed must be a flat JSON object whose keys and values are strings",
          );
          workspace.writeValidPreparationManifest();
          return {
            exitCode: 0,
            sessionId: "session_prepare",
            stderr: "",
            stdout: "Rewrote preparation-manifest.json.",
          };
        },
      },
      outputRoot: "/tmp/makeademo-test",
    });

    await expect(
      harness.dependencies.prepareRepo({
        demoBrief: { keyProductFeatures: ["dashboard"] },
        normalizedSupportingDocuments: undefined,
        repoProfile: repoProfile(),
        runPlan: runPlan(),
        workspace,
      }),
    ).resolves.toMatchObject({
      manifest: { blockedExternalServicesReplaced: [], id: "prep_001" },
      opencodeSessionId: "session_prepare",
    });

    expect(stages).toEqual(["repo-preparation", "repo-preparation-repair"]);
  });
});

function secretMountedDaytonaWorkspace(): AgentHarnessWorkspace & {
  networkAccessRequests: boolean[];
} {
  const manifest = preparationManifest();
  const networkAccessRequests: boolean[] = [];

  return {
    networkAccessRequests,
    async destroy() {},
    async execute(command) {
      if (command.includes("git clone --depth 1")) {
        const usesGitCa =
          command.includes("http.sslCAInfo") &&
          command.includes("SSL_CERT_FILE");
        return usesGitCa
          ? { exitCode: 0, stderr: "", stdout: "cloned\n" }
          : {
              exitCode: 128,
              stderr:
                "fatal: unable to access 'https://github.com/example/app/': server certificate verification failed. CAfile: none CRLfile: none\n",
              stdout: "",
            };
      }

      if (command.includes("/workspace/.makeademo/preparation-manifest.json")) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(manifest) };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async executeSubmittedCode() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async setOutboundNetworkAccess(enabled) {
      networkAccessRequests.push(enabled);
    },
    async setSubmittedCodeNetworkAccess() {},
    async syncSubmittedCodeWorkspace() {},
  };
}

function repoPreparationRunner(): OpenCodeHarnessRunner {
  return {
    async run(input) {
      expect(input.stage).toBe("repo-preparation");
      expect(input.prompt).toContain(
        "envUsed must be a flat JSON object whose keys and values are strings",
      );
      return {
        exitCode: 0,
        sessionId: "session_prepare",
        stderr: "",
        stdout: "",
      };
    },
  };
}

function repairableRepoPreparationWorkspace(): AgentHarnessWorkspace & {
  writePreparationManifest(): void;
} {
  const manifest = preparationManifest();
  let manifestWritten = false;

  return {
    writePreparationManifest() {
      manifestWritten = true;
    },
    async destroy() {},
    async execute(command) {
      if (command.includes("git clone --depth 1")) {
        return { exitCode: 0, stderr: "", stdout: "cloned\n" };
      }

      if (command.includes("/workspace/.makeademo/preparation-manifest.json")) {
        return manifestWritten
          ? { exitCode: 0, stderr: "", stdout: JSON.stringify(manifest) }
          : {
              exitCode: 1,
              stderr: "cat: can't open preparation-manifest.json\n",
              stdout: "",
            };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async executeSubmittedCode() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async setOutboundNetworkAccess() {},
    async setSubmittedCodeNetworkAccess() {},
    async syncSubmittedCodeWorkspace() {},
  };
}

function schemaRepairableRepoPreparationWorkspace(): AgentHarnessWorkspace & {
  writeValidPreparationManifest(): void;
} {
  const validManifest = preparationManifest();
  let manifest: unknown = {
    ...validManifest,
    blockedExternalServicesReplaced: [
      { replacement: "local fixture", service: "remote API" },
    ],
  };

  return {
    writeValidPreparationManifest() {
      manifest = validManifest;
    },
    async destroy() {},
    async execute(command) {
      if (command.includes("git clone --depth 1")) {
        return { exitCode: 0, stderr: "", stdout: "cloned\n" };
      }

      if (command.includes("/workspace/.makeademo/preparation-manifest.json")) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(manifest) };
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async executeSubmittedCode() {
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async setOutboundNetworkAccess() {},
    async setSubmittedCodeNetworkAccess() {},
    async syncSubmittedCodeWorkspace() {},
  };
}

function repoProfile(): RepoProfile {
  return {
    authHints: [],
    candidateAppDirs: ["."],
    candidateBuildCommands: [],
    candidateInstallCommands: ["bun install --frozen-lockfile"],
    candidatePorts: [3000],
    candidateStartCommands: ["bun run dev"],
    confidence: { assumptions: [], overall: 0.9 },
    detectedFrameworks: [],
    dockerHints: [],
    envExamples: [],
    externalServiceHints: [],
    lockfiles: ["bun.lock"],
    packageManager: "bun",
    packageScripts: { dev: "bun run dev" },
    repoUrl: "https://github.com/example/app",
    requiredEnvHints: [],
    rootDir: "/workspace",
    securityWarnings: [],
    unsupportedReasons: [],
    workspaces: { isMonorepo: false, packageDirectories: [] },
  };
}

function runPlan(): RunPlan {
  return {
    allowedPorts: [3000],
    appDir: ".",
    assumptions: [],
    env: {},
    expectedLocalUrl: "http://127.0.0.1:3000",
    installCommand: "bun install --frozen-lockfile",
    localServices: [],
    riskFlags: [],
    runtime: "bun",
    startCommand: "bun run dev --host 127.0.0.1 --port 3000",
    validationExpectations: ["body visible"],
  };
}

function preparationManifest(): PreparationManifest {
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
    validationEvidence: ["prepared"],
  };
}

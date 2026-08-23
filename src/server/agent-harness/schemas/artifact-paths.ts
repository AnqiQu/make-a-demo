import type { OpenCodeHarnessStage } from "../opencode/opencode-harness";
import { DEMO_SCRIPT_OUTPUT_PATH } from "./artifacts";

/**
 * The one table of durable MakeADemo artifact locations inside the sandbox.
 * Runner permissions, stage prompts, and the orchestrator's manifest must all
 * read paths from here: divergent per-module copies are how a stage ends up
 * prompted to write an artifact its permission table denies.
 */

/** Root directory for every durable pipeline artifact in the sandbox. */
export const makeADemoDirectory = "/workspace/.makeademo";

export const makeADemoArtifactPaths = {
  actionCatalog: `${makeADemoDirectory}/action-catalog.json`,
  agentArtifactAttempts: `${makeADemoDirectory}/agent-artifact-attempts`,
  appExplorationValidation: `${makeADemoDirectory}/app-exploration-validation-report.json`,
  appMap: `${makeADemoDirectory}/app-map.json`,
  capturePathPreflight: `${makeADemoDirectory}/capture-path-preflight-validation-report.json`,
  capturePathValidation: `${makeADemoDirectory}/capture-path-validation-report.json`,
  captureRuntimeReset: `${makeADemoDirectory}/capture-runtime-reset-validation-report.json`,
  captureSdkContract: `${makeADemoDirectory}/capture-sdk-contract.json`,
  demoBrief: `${makeADemoDirectory}/demo-brief.json`,
  demoScript: DEMO_SCRIPT_OUTPUT_PATH,
  demoScriptContract: `${makeADemoDirectory}/demo-script-contract.json`,
  externalResourceHydrationReport: `${makeADemoDirectory}/external-resource-hydration-report.json`,
  externalResourceManifest: `${makeADemoDirectory}/external-resource-manifest.json`,
  featureVerificationGuide: `${makeADemoDirectory}/feature-verification-guide.md`,
  fidelityAdjudication: `${makeADemoDirectory}/fidelity-adjudication.json`,
  flowSpec: `${makeADemoDirectory}/flow-spec.json`,
  flowSpecContract: `${makeADemoDirectory}/flow-spec-contract.json`,
  footageCaptureValidation: `${makeADemoDirectory}/footage-capture-validation-report.json`,
  pipelineRunManifest: `${makeADemoDirectory}/pipeline-run-manifest.json`,
  preparationFallback: `${makeADemoDirectory}/preparation-fallback.json`,
  preparationFidelity: `${makeADemoDirectory}/preparation-fidelity-validation-report.json`,
  preparationManifest: `${makeADemoDirectory}/preparation-manifest.json`,
  preparationManifestContract: `${makeADemoDirectory}/preparation-manifest-contract.json`,
  preparationManifestTemplate: `${makeADemoDirectory}/preparation-manifest-template.json`,
  preparationPreflight: `${makeADemoDirectory}/preparation-preflight-validation-report.json`,
  preparationWorkspaceDiff: `${makeADemoDirectory}/preparation-workspace-diff.json`,
  repoProfile: `${makeADemoDirectory}/repo-profile.json`,
  repairAdvice: `${makeADemoDirectory}/repair-advice.json`,
  repairRoundLedger: `${makeADemoDirectory}/repair-round-ledger.json`,
  runPlan: `${makeADemoDirectory}/run-plan.json`,
  runTriageAdvice: `${makeADemoDirectory}/run-triage-advice.json`,
  runtimeTargetSelection: `${makeADemoDirectory}/runtime-target-selection.json`,
  runtimeTargetSelectionContract: `${makeADemoDirectory}/runtime-target-selection-contract.json`,
  scriptCandidate: `${makeADemoDirectory}/script-candidate.json`,
  strategistMemory: `${makeADemoDirectory}/strategist-memory.json`,
  staticScriptContract: `${makeADemoDirectory}/static-script-contract-validation.json`,
  supportingDocuments: `${makeADemoDirectory}/supporting-documents.json`,
  validationAttempts: `${makeADemoDirectory}/validation-attempts`,
} as const;

/**
 * The artifact(s) each OpenCode stage is expected to write. The runner's edit
 * permission table allows exactly these paths, and each stage's prompt names
 * the same paths, so a prompted write is always a permitted write.
 */
export function stageWriteableArtifactPaths(
  stage: OpenCodeHarnessStage,
): string[] {
  switch (stage) {
    case "repo-preparation":
    case "repo-preparation-repair":
      return [makeADemoArtifactPaths.preparationManifest];
    case "app-exploration":
      return [
        makeADemoArtifactPaths.actionCatalog,
        makeADemoArtifactPaths.appMap,
      ];
    case "flow-planning":
      return [makeADemoArtifactPaths.flowSpec];
    case "preparation-fidelity-adjudication":
      return [makeADemoArtifactPaths.fidelityAdjudication];
    case "repair-strategy":
      return [makeADemoArtifactPaths.repairAdvice];
    case "run-triage":
      return [makeADemoArtifactPaths.runTriageAdvice];
    case "runtime-target-selection":
      return [makeADemoArtifactPaths.runtimeTargetSelection];
    case "script-repair":
    case "script-writing":
      return [makeADemoArtifactPaths.demoScript];
  }
}

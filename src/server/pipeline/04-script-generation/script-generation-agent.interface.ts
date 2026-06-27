import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScriptPackage } from "./demo-script-package";
import type { ScriptGenerationInput } from "./script-generation-orchestrator";

export type AgenticScriptGenerationInput = ScriptGenerationInput & {
  opencodeSessionID: string;
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Generates a Demo Script inside a prepared workspace.
 * Implementations should resume the provided preparation OpenCode session and
 * write only Script Generation artifacts; Capture Path Validation decides later
 * whether the Demo Script is accepted for Footage Capture.
 */
export interface ScriptGenerationAgent {
  generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<DemoScriptPackage>;
}

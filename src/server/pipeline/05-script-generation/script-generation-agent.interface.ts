import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { ScriptGenerationInput } from "./script-generation-orchestrator";
import type { VideoScriptPackage } from "./video-script-package";

export type AgenticScriptGenerationInput = ScriptGenerationInput & {
  opencodeSessionID: string;
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Generates a Video Script Package inside a prepared workspace.
 * Implementations should resume the provided preparation OpenCode session and
 * write only Script Generation artifacts; Capture Path Validation decides later
 * whether the package is accepted for Footage Capture.
 */
export interface ScriptGenerationAgent {
  generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<VideoScriptPackage>;
}

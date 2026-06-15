import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { ScriptGenerationInput } from "./script-generation-orchestrator";
import type { VideoScriptPackage } from "./video-script-package";

export type AgenticScriptGenerationInput = ScriptGenerationInput & {
  opencodeSessionID: string;
  preparationWorkspace: PreparationWorkspaceHandle;
};

/**
 * Generates the capture-ready Video Script Package inside a validated prepared workspace.
 * Implementations must treat the app runtime as frozen after Project Validation, resume
 * the provided preparation OpenCode session, and write only Script Generation artifacts.
 */
export interface ScriptGenerationAgent {
  generateScriptPackage(
    input: AgenticScriptGenerationInput,
  ): Promise<VideoScriptPackage>;
}

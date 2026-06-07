import type { ProjectExplorationResult } from "../../../pipeline/03-script-generation/project-exploration/project-exploration-result";
import type {
  ProjectExplorationInput,
  ProjectExplorer,
} from "../../../pipeline/03-script-generation/project-exploration/project-explorer.interface";

export class LlmProjectExplorer implements ProjectExplorer {
  async exploreProject(
    _input: ProjectExplorationInput,
  ): Promise<ProjectExplorationResult> {
    // TODO: Import and wire the Explorer agent implementation from the other project.
    throw new Error(
      "LlmProjectExplorer is a stub until the agent code is imported.",
    );
  }
}

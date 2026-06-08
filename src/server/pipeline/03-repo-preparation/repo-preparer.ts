import { createPreparationFallbackPrompt } from "./preparation-fallback-prompt";
import { readPreparationManifest } from "./preparation-manifest";
import type {
  RepoPreparationAgent,
  RepoPreparationInput,
  RepoPreparationResult,
} from "./repo-preparation-agent.interface";

export async function prepareRepo(
  input: RepoPreparationInput,
  dependencies: { agent: RepoPreparationAgent },
): Promise<RepoPreparationResult> {
  const result = await dependencies.agent.prepare(input);

  if (result.status === "failed") {
    return {
      fallbackPrompt: createPreparationFallbackPrompt({
        assumptions: result.assumptions,
        blockers: result.blockers,
        repoUrl: input.repoUrl,
        suggestedChanges: result.suggestedChanges,
      }),
      status: "failed",
    };
  }

  try {
    return {
      manifest: readPreparationManifest(result.manifest),
      status: "succeeded",
    };
  } catch (error) {
    return {
      fallbackPrompt: createPreparationFallbackPrompt({
        assumptions: [],
        blockers: [
          `Preparation Manifest was invalid: ${error instanceof Error ? error.message : String(error)}`,
        ],
        repoUrl: input.repoUrl,
        suggestedChanges: [
          "Retry repo preparation and return a complete Preparation Manifest JSON object.",
        ],
      }),
      status: "failed",
    };
  }
}

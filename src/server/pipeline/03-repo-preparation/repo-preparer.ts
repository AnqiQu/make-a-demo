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

  return {
    manifest: readPreparationManifest(result.manifest),
    status: "succeeded",
  };
}

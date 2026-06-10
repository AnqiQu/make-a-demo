import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";
import { OpenCodeRepoPreparationAgent } from "./opencode-repo-preparation-agent";

type RepoPreparationAgentRuntime = "daytona" | "docker";

export type RepoPreparationAgentFactoryOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  modelID: string;
  onProgress?: (line: string) => void;
  providerID: string;
  runtime: RepoPreparationAgentRuntime;
  sourceDirectory: string;
};

export function createRepoPreparationAgent(
  options: RepoPreparationAgentFactoryOptions,
): RepoPreparationAgent {
  if (options.runtime === "daytona") {
    if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
      throw new Error(
        "DAYTONA_API_KEY is required for Daytona Repo Preparation.",
      );
    }

    return new DaytonaOpenCodeRepoPreparationAgent({
      modelID: options.modelID,
      provider: new DaytonaSdkPreparationWorkspaceProvider({
        apiKey: options.daytonaApiKey,
        ...(options.daytonaSnapshot === undefined
          ? {}
          : { snapshot: options.daytonaSnapshot }),
      }),
      providerID: options.providerID,
      sourceDirectory: options.sourceDirectory,
    });
  }

  return new OpenCodeRepoPreparationAgent({
    directory: options.sourceDirectory,
    modelID: options.modelID,
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
    providerID: options.providerID,
  });
}

import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";

export type RepoPreparationAgentFactoryOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  modelID: string;
  providerApiKey: string;
  providerID: string;
};

export function createRepoPreparationAgent(
  options: RepoPreparationAgentFactoryOptions,
): RepoPreparationAgent {
  if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
    throw new Error(
      "DAYTONA_API_KEY is required for Daytona Repo Preparation.",
    );
  }

  return new DaytonaOpenCodeRepoPreparationAgent({
    modelID: options.modelID,
    providerApiKey: options.providerApiKey,
    provider: new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: options.daytonaApiKey,
      ...(options.daytonaSnapshot === undefined
        ? {}
        : { snapshot: options.daytonaSnapshot }),
    }),
    providerID: options.providerID,
  });
}

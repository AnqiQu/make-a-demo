import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { validateProject } from "../../../pipeline/04-project-validation/project-validator";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";
import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";

export type RepoPreparationAgentFactoryOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
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
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    providerApiKey: options.providerApiKey,
    provider: new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: options.daytonaApiKey,
      ...(options.daytonaSnapshot === undefined
        ? {}
        : { snapshot: options.daytonaSnapshot }),
    }),
    providerID: options.providerID,
    validatePreparation: ({ manifest, workspace }) =>
      validateProject(
        { preparationManifest: manifest, preparationWorkspace: workspace },
        {
          browserValidator: new PlaywrightBrowserValidator(),
          sandboxRunner: new DaytonaSandboxRunner({
            destroyWorkspaceOnCleanup: false,
          }),
        },
      ),
  });
}

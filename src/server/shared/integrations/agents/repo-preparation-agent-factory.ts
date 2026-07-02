import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { validateProject } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";
import { createOpenCodeProviderSandboxSecrets } from "./opencode-provider-secrets";

export type RepoPreparationAgentFactoryOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  daytonaSubmittedCodeSnapshot?: string;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerID: string;
  providerSecretName: string;
};

export function createRepoPreparationAgent(
  options: RepoPreparationAgentFactoryOptions,
): RepoPreparationAgent {
  if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
    throw new Error(
      "DAYTONA_API_KEY is required for Daytona Repo Preparation.",
    );
  }

  return new DaytonaOpenCodeRepoPreparation({
    modelID: options.modelID,
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    provider: new DaytonaSdkPreparationWorkspaceProvider({
      apiKey: options.daytonaApiKey,
      secrets: createOpenCodeProviderSandboxSecrets({
        providerID: options.providerID,
        providerSecretName: options.providerSecretName,
      }),
      ...(options.daytonaSnapshot === undefined
        ? {}
        : { snapshot: options.daytonaSnapshot }),
      ...(options.daytonaSubmittedCodeSnapshot === undefined
        ? {}
        : { submittedCodeSnapshot: options.daytonaSubmittedCodeSnapshot }),
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

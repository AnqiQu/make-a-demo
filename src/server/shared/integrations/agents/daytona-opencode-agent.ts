import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { ScriptGenerationAgent } from "../../../pipeline/04-script-generation/script-generation-agent.interface";
import type {
  CapturePathRepairInput,
  CapturePathRepairResult,
  CapturePathRepairer,
} from "../../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import { validateProject } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import { PlaywrightBrowserValidator } from "../browser/playwright-browser-validator";
import { DaytonaSdkPreparationWorkspaceProvider } from "../daytona/daytona-sdk-preparation-workspace-provider";
import { DaytonaSandboxRunner } from "../sandbox/daytona-sandbox-runner";
import { DaytonaOpenCodeRepoPreparation } from "./daytona-opencode-repo-preparation";
import {
  DaytonaOpenCodeScriptGeneration,
  type DraftCompositeReviewDecision,
  type DraftCompositeReviewInput,
} from "./daytona-opencode-script-generation";

export type DaytonaOpenCodeAgentOptions = {
  daytonaApiKey?: string;
  daytonaSnapshot?: string;
  maxScriptGenerationAttempts?: number;
  modelID: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  providerApiKey: string;
  providerID: string;
};

export class DaytonaOpenCodeAgent
  implements CapturePathRepairer, RepoPreparationAgent, ScriptGenerationAgent
{
  private readonly repoPreparation: DaytonaOpenCodeRepoPreparation;
  private readonly scriptGeneration: DaytonaOpenCodeScriptGeneration;

  constructor(options: DaytonaOpenCodeAgentOptions) {
    if (options.daytonaApiKey === undefined || options.daytonaApiKey === "") {
      throw new Error(
        "DAYTONA_API_KEY is required for Daytona OpenCode agent runs.",
      );
    }

    this.repoPreparation = new DaytonaOpenCodeRepoPreparation({
      modelID: options.modelID,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      provider: new DaytonaSdkPreparationWorkspaceProvider({
        apiKey: options.daytonaApiKey,
        ...(options.daytonaSnapshot === undefined
          ? {}
          : { snapshot: options.daytonaSnapshot }),
      }),
      providerApiKey: options.providerApiKey,
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
    this.scriptGeneration = new DaytonaOpenCodeScriptGeneration({
      ...(options.maxScriptGenerationAttempts === undefined
        ? {}
        : { maxAttempts: options.maxScriptGenerationAttempts }),
      modelID: options.modelID,
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      providerApiKey: options.providerApiKey,
      providerID: options.providerID,
    });
  }

  generateScriptPackage: ScriptGenerationAgent["generateScriptPackage"] = (
    input,
  ) => this.scriptGeneration.generateScriptPackage(input);

  prepare: RepoPreparationAgent["prepare"] = (input) =>
    this.repoPreparation.prepare(input);

  repairCapturePathFailure(
    input: CapturePathRepairInput,
  ): Promise<CapturePathRepairResult> {
    return this.scriptGeneration.repairCapturePathFailure(input);
  }

  reviewDraftComposite(
    input: DraftCompositeReviewInput,
  ): Promise<DraftCompositeReviewDecision> {
    return this.scriptGeneration.reviewDraftComposite(input);
  }
}

import { screenRepoSecurity } from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { RepoPreparationAgent } from "../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { prepareRepo } from "../../pipeline/03-repo-preparation/repo-preparer";
import { DefaultDemoPlanner } from "../../pipeline/04-script-generation/demo-planning/default-demo-planner";
import { DefaultScriptComposer } from "../../pipeline/04-script-generation/script-composition/default-script-composer";
import type { ScriptGenerationAgent } from "../../pipeline/04-script-generation/script-generation-agent.interface";
import { generateVideoScriptPackage } from "../../pipeline/04-script-generation/script-generation-orchestrator";
import type { CapturePathRepairer } from "../../pipeline/05-capture-path-validation/capture-path-repairer.interface";
import { validateCapturePath } from "../../pipeline/05-capture-path-validation/capture-path-validator";
import type { CapturePathSceneValidator } from "../../pipeline/05-capture-path-validation/capture-path-validator";
import { DefaultCapturePathSceneValidator } from "../../pipeline/05-capture-path-validation/playwright-capture-path-scene-validator";
import type { BrowserValidator } from "../../pipeline/05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import { validateProject } from "../../pipeline/05-capture-path-validation/project-runtime-preflight/project-validator";
import type { SandboxRunner } from "../../pipeline/05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import { LlmProjectExplorer } from "../integrations/agents/llm-project-explorer";
import { PlaywrightBrowserValidator } from "../integrations/browser/playwright-browser-validator";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

export type Stage1PipelineOptions = {
  browserValidator?: BrowserValidator;
  repoPreparationAgent: RepoPreparationAgent;
  sandboxRunner: SandboxRunner;
  sceneValidator?: CapturePathSceneValidator;
  capturePathRepairer?: CapturePathRepairer;
  scriptGenerationAgent?: ScriptGenerationAgent;
};

export function createStage1PipelineDependencies(
  options: Stage1PipelineOptions,
): PipelineOrchestratorDependencies {
  const browserValidator =
    options.browserValidator ?? new PlaywrightBrowserValidator();
  const sandboxRunner = options.sandboxRunner;
  const sceneValidator =
    options.sceneValidator ?? new DefaultCapturePathSceneValidator();
  const capturePathRepairer = readCapturePathRepairer(options);

  return {
    generateScriptPackage(input) {
      return generateVideoScriptPackage(input, {
        demoPlanner: new DefaultDemoPlanner(),
        projectExplorer: new LlmProjectExplorer(),
        ...(options.scriptGenerationAgent === undefined
          ? {}
          : { scriptGenerationAgent: options.scriptGenerationAgent }),
        scriptComposer: new DefaultScriptComposer(),
      });
    },
    prepareRepo(input) {
      return prepareRepo(input, { agent: options.repoPreparationAgent });
    },
    ...(capturePathRepairer === undefined
      ? {}
      : {
          repairCapturePathFailure:
            capturePathRepairer.repairCapturePathFailure.bind(
              capturePathRepairer,
            ),
        }),
    screenRepoSecurity,
    validateCapturePath(input) {
      return validateCapturePath(input, {
        sceneValidator,
        validateProject(projectInput) {
          return validateProject(projectInput, {
            browserValidator,
            sandboxRunner,
          });
        },
      });
    },
  };
}

function readCapturePathRepairer(
  options: Stage1PipelineOptions,
): CapturePathRepairer | undefined {
  if (options.capturePathRepairer !== undefined) {
    return options.capturePathRepairer;
  }

  if (
    options.scriptGenerationAgent !== undefined &&
    "repairCapturePathFailure" in options.scriptGenerationAgent &&
    typeof options.scriptGenerationAgent.repairCapturePathFailure === "function"
  ) {
    return options.scriptGenerationAgent as ScriptGenerationAgent &
      CapturePathRepairer;
  }

  return undefined;
}

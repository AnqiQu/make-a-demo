import { screenRepoSecurity } from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { RepoPreparationAgent } from "../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { prepareRepo } from "../../pipeline/03-repo-preparation/repo-preparer";
import type { BrowserValidator } from "../../pipeline/04-project-validation/browser-validator.interface";
import { validateProject } from "../../pipeline/04-project-validation/project-validator";
import type { SandboxRunner } from "../../pipeline/04-project-validation/sandbox-runner.interface";
import { DefaultDemoPlanner } from "../../pipeline/05-script-generation/demo-planning/default-demo-planner";
import { DefaultScriptComposer } from "../../pipeline/05-script-generation/script-composition/default-script-composer";
import { generateVideoScriptPackage } from "../../pipeline/05-script-generation/script-generation-orchestrator";
import { LlmProjectExplorer } from "../integrations/agents/llm-project-explorer";
import { PlaywrightBrowserValidator } from "../integrations/browser/playwright-browser-validator";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

export type Stage1PipelineOptions = {
  browserValidator?: BrowserValidator;
  repoPreparationAgent: RepoPreparationAgent;
  sandboxRunner: SandboxRunner;
};

export function createStage1PipelineDependencies(
  options: Stage1PipelineOptions,
): PipelineOrchestratorDependencies {
  const browserValidator =
    options.browserValidator ?? new PlaywrightBrowserValidator();
  const sandboxRunner = options.sandboxRunner;

  return {
    generateScriptPackage(input) {
      return generateVideoScriptPackage(input, {
        demoPlanner: new DefaultDemoPlanner(),
        projectExplorer: new LlmProjectExplorer(),
        scriptComposer: new DefaultScriptComposer(),
      });
    },
    prepareRepo(input) {
      return prepareRepo(input, { agent: options.repoPreparationAgent });
    },
    screenRepoSecurity,
    validateProject(input) {
      return validateProject(input, { browserValidator, sandboxRunner });
    },
  };
}

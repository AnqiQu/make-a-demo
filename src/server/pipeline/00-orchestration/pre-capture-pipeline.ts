import { PlaywrightBrowserValidator } from "../../shared/integrations/browser/playwright-browser-validator";
import { screenRepoSecurity } from "../02-repo-security-screen/repo-security-screen";
import type { RepoPreparationAgent } from "../03-repo-preparation/repo-preparation-agent.interface";
import { prepareRepo } from "../03-repo-preparation/repo-preparer";
import { DefaultDemoPlanner } from "../04-script-generation/demo-planning/default-demo-planner";
import { PreparationManifestProjectExplorer } from "../04-script-generation/project-exploration/preparation-manifest-project-explorer";
import { DefaultScriptComposer } from "../04-script-generation/script-composition/default-script-composer";
import type { ScriptGenerationAgent } from "../04-script-generation/script-generation-agent.interface";
import { generateDemoScriptPackage } from "../04-script-generation/script-generation-orchestrator";
import type { BrowserValidator } from "../05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import { validateProject } from "../05-capture-path-validation/project-runtime-preflight/project-validator";
import type { SandboxRunner } from "../05-capture-path-validation/project-runtime-preflight/sandbox-runner.interface";
import type { PipelineOrchestratorDependencies } from "./pipeline-orchestrator";

export type PreCapturePipelineOptions = {
  browserValidator?: BrowserValidator;
  repoPreparationAgent: RepoPreparationAgent;
  sandboxRunner: SandboxRunner;
  scriptGenerationAgent?: ScriptGenerationAgent;
};

export function createPreCapturePipelineDependencies(
  options: PreCapturePipelineOptions,
): PipelineOrchestratorDependencies {
  const browserValidator =
    options.browserValidator ?? new PlaywrightBrowserValidator();
  const sandboxRunner = options.sandboxRunner;

  return {
    generateScriptPackage(input) {
      return generateDemoScriptPackage(input, {
        demoPlanner: new DefaultDemoPlanner(),
        projectExplorer: new PreparationManifestProjectExplorer(),
        ...(options.scriptGenerationAgent === undefined
          ? {}
          : { scriptGenerationAgent: options.scriptGenerationAgent }),
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

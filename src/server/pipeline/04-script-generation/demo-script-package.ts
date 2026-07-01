import type { DemoScript } from "../06-footage-capture/demo-script.schema";
import type { DemoPlan } from "./demo-planning/demo-plan";
import type { ProjectExplorationResult } from "./project-exploration/project-exploration-result";
import type { ComposedDemoScript } from "./script-composition/composed-demo-script";

export type DemoScriptPackage = DemoScript & {
  assumptions: string[];
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
};

/**
 * Script Generation output that has passed local schema and quality checks but
 * has not yet passed Capture Path Validation.
 */
export type DemoScriptCandidate = DemoScriptPackage;

/**
 * Demo Script candidate promoted by successful Capture Path Validation.
 * Callers should use this type for Footage Capture and persistence handoffs.
 */
export type AcceptedDemoScript = DemoScriptPackage;

export function buildDemoScriptPackage(input: {
  demoPlan: DemoPlan;
  exploration: ProjectExplorationResult;
  demoScript: ComposedDemoScript;
}): DemoScriptPackage {
  return {
    ...input.demoScript,
    assumptions: input.exploration.assumptions,
    demoPlan: input.demoPlan,
    exploration: input.exploration,
  };
}

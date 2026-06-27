import type { DemoPlanner } from "./demo-planner.interface";

export class DefaultDemoPlanner implements DemoPlanner {
  async planDemo(input: Parameters<DemoPlanner["planDemo"]>[0]) {
    return {
      featureOrder: input.demoBrief.keyProductFeatures,
      narrative: input.exploration.summary,
      risks: [],
    };
  }
}

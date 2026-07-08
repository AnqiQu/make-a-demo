import { describe, expect, it } from "vitest";
import { runAgentHarnessPipeline } from "../../agent-harness/orchestration/agent-harness";
import { runArtifactDrivenAgentHarnessPipeline } from "./pipeline-orchestrator";

describe("artifact-driven harness public entrypoint", () => {
  it("is exported through the existing pipeline orchestration module", () => {
    expect(runArtifactDrivenAgentHarnessPipeline).toBe(runAgentHarnessPipeline);
  });
});

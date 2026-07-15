import { describe, expect, it } from "vitest";
import { readAgentHarnessRetryPolicy } from "./retry-policy";

describe("readAgentHarnessRetryPolicy", () => {
  it("reads bounded retry budgets from environment configuration", () => {
    expect(
      readAgentHarnessRetryPolicy({
        MAKEADEMO_AGENT_ARTIFACT_ATTEMPTS: "4",
        MAKEADEMO_EXTERNAL_RESOURCE_BROKER_PASSES: "8",
        MAKEADEMO_REPO_PREPARATION_REPAIRS: "2",
        MAKEADEMO_SCRIPT_REPAIRS: "5",
      }),
    ).toEqual({
      agentArtifactAttempts: 4,
      externalResourceBrokerPasses: 8,
      repoPreparationRepairs: 2,
      scriptRepairs: 5,
    });

    expect(() =>
      readAgentHarnessRetryPolicy({
        MAKEADEMO_SCRIPT_REPAIRS: "unbounded",
      }),
    ).toThrow("MAKEADEMO_SCRIPT_REPAIRS");
  });
});

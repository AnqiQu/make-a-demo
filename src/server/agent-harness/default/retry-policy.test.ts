import { describe, expect, it } from "vitest";
import { readAgentHarnessRetryPolicy } from "./retry-policy";

describe("readAgentHarnessRetryPolicy", () => {
  it("reads bounded retry budgets from environment configuration", () => {
    expect(
      readAgentHarnessRetryPolicy({
        MAKEADEMO_AGENT_ARTIFACT_ATTEMPTS: "4",
        MAKEADEMO_AGENT_STALL_RETRIES: "1",
        MAKEADEMO_EXTERNAL_RESOURCE_BROKER_PASSES: "8",
        MAKEADEMO_JOB_DEADLINE_MINUTES: "120",
        MAKEADEMO_REPO_PREPARATION_REPAIRS: "2",
        MAKEADEMO_SCRIPT_REPAIRS: "5",
      }),
    ).toEqual({
      agentArtifactAttempts: 4,
      agentStallRetries: 1,
      externalResourceBrokerPasses: 8,
      jobDeadlineMinutes: 120,
      repoPreparationRepairs: 2,
      scriptRepairs: 5,
    });

    expect(() =>
      readAgentHarnessRetryPolicy({
        MAKEADEMO_SCRIPT_REPAIRS: "unbounded",
      }),
    ).toThrow("MAKEADEMO_SCRIPT_REPAIRS");
  });

  it("defaults the job wall-clock budget to 90 minutes and bounds it", () => {
    expect(readAgentHarnessRetryPolicy({}).jobDeadlineMinutes).toBe(90);
    expect(() =>
      readAgentHarnessRetryPolicy({ MAKEADEMO_JOB_DEADLINE_MINUTES: "601" }),
    ).toThrow("MAKEADEMO_JOB_DEADLINE_MINUTES");
  });
});

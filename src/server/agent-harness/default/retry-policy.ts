export type AgentHarnessRetryPolicy = {
  agentArtifactAttempts: number;
  externalResourceBrokerPasses: number;
  /** Wall-clock budget for one whole pipeline job. */
  jobDeadlineMinutes: number;
  repoPreparationRepairs: number;
  scriptRepairs: number;
};

const defaultRetryPolicy: AgentHarnessRetryPolicy = {
  agentArtifactAttempts: 3,
  externalResourceBrokerPasses: 6,
  jobDeadlineMinutes: 90,
  repoPreparationRepairs: 5,
  scriptRepairs: 3,
};

/** Reads finite retry budgets shared by the default harness and orchestrator. */
export function readAgentHarnessRetryPolicy(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<AgentHarnessRetryPolicy> = {},
): AgentHarnessRetryPolicy {
  return {
    agentArtifactAttempts: readBudget({
      defaultValue: defaultRetryPolicy.agentArtifactAttempts,
      env,
      key: "MAKEADEMO_AGENT_ARTIFACT_ATTEMPTS",
      minimum: 1,
      override: overrides.agentArtifactAttempts,
    }),
    externalResourceBrokerPasses: readBudget({
      defaultValue: defaultRetryPolicy.externalResourceBrokerPasses,
      env,
      key: "MAKEADEMO_EXTERNAL_RESOURCE_BROKER_PASSES",
      minimum: 1,
      override: overrides.externalResourceBrokerPasses,
    }),
    jobDeadlineMinutes: readBudget({
      defaultValue: defaultRetryPolicy.jobDeadlineMinutes,
      env,
      key: "MAKEADEMO_JOB_DEADLINE_MINUTES",
      maximum: 600,
      minimum: 1,
      override: overrides.jobDeadlineMinutes,
    }),
    repoPreparationRepairs: readBudget({
      defaultValue: defaultRetryPolicy.repoPreparationRepairs,
      env,
      key: "MAKEADEMO_REPO_PREPARATION_REPAIRS",
      minimum: 0,
      override: overrides.repoPreparationRepairs,
    }),
    scriptRepairs: readBudget({
      defaultValue: defaultRetryPolicy.scriptRepairs,
      env,
      key: "MAKEADEMO_SCRIPT_REPAIRS",
      minimum: 0,
      override: overrides.scriptRepairs,
    }),
  };
}

function readBudget(input: {
  defaultValue: number;
  env: Record<string, string | undefined>;
  key: string;
  maximum?: number;
  minimum: number;
  override: number | undefined;
}): number {
  const maximum = input.maximum ?? 10;
  const raw = input.override ?? input.env[input.key] ?? input.defaultValue;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < input.minimum ||
    value > maximum
  ) {
    throw new Error(
      `${input.key} must be an integer from ${input.minimum} through ${maximum}.`,
    );
  }
  return value;
}

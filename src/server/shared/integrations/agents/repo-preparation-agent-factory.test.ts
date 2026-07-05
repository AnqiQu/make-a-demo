import { describe, expect, it, vi } from "vitest";

import { createRepoPreparationAgent } from "./repo-preparation-agent-factory";

describe("createRepoPreparationAgent", () => {
  it("threads the Repo Preparation timeout option into the Daytona agent", () => {
    const agent = createRepoPreparationAgent({
      daytonaApiKey: "daytona-key",
      modelID: "gpt-5.5",
      providerID: "openai",
      providerSecretName: "opencode-provider-secret",
      repoPreparationTimeoutMs: 15 * 60 * 1_000,
    });

    expect((agent as unknown as { timeoutMs: number }).timeoutMs).toBe(
      15 * 60 * 1_000,
    );
  });

  it("reads the Repo Preparation timeout from MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS", () => {
    const previous = process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS;
    process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = "900000";

    try {
      const agent = createRepoPreparationAgent({
        daytonaApiKey: "daytona-key",
        modelID: "gpt-5.5",
        providerID: "openai",
        providerSecretName: "opencode-provider-secret",
      });

      expect((agent as unknown as { timeoutMs: number }).timeoutMs).toBe(
        900_000,
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(
          process.env,
          "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS",
        );
      } else {
        process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = previous;
      }
    }
  });

  it.each(["10m", "1_000", "1.5"])(
    "rejects malformed Repo Preparation timeout env value %s",
    (timeoutEnvValue) => {
      const previous = process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS;
      process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = timeoutEnvValue;

      try {
        expect(() =>
          createRepoPreparationAgent({
            daytonaApiKey: "daytona-key",
            modelID: "gpt-5.5",
            providerID: "openai",
            providerSecretName: "opencode-provider-secret",
          }),
        ).toThrowError(
          "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
        );
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(
            process.env,
            "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS",
          );
        } else {
          process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = previous;
        }
      }
    },
  );

  it.each(["0", "-1"])(
    "rejects non-positive Repo Preparation timeout env value %s",
    (timeoutEnvValue) => {
      const previous = process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS;
      process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = timeoutEnvValue;

      try {
        expect(() =>
          createRepoPreparationAgent({
            daytonaApiKey: "daytona-key",
            modelID: "gpt-5.5",
            providerID: "openai",
            providerSecretName: "opencode-provider-secret",
          }),
        ).toThrowError(
          "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS must be a positive integer millisecond value.",
        );
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(
            process.env,
            "MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS",
          );
        } else {
          process.env.MAKEADEMO_REPO_PREPARATION_TIMEOUT_MS = previous;
        }
      }
    },
  );

  it("threads sandbox log sinks into the Daytona Repo Preparation workspace provider", () => {
    const sink = { write: vi.fn() };

    const agent = createRepoPreparationAgent({
      daytonaApiKey: "daytona-key",
      modelID: "gpt-5.5",
      providerID: "openai",
      providerSecretName: "opencode-provider-secret",
      sandboxLogSinks: [sink],
    });

    expect(
      (
        agent as unknown as {
          provider: { sandboxLogSinks: unknown[] };
        }
      ).provider.sandboxLogSinks,
    ).toEqual([sink]);
  });
});

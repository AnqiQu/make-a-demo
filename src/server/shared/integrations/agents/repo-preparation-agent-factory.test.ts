import { describe, expect, it } from "vitest";

import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";
import { OpenCodeRepoPreparationAgent } from "./opencode-repo-preparation-agent";
import { createRepoPreparationAgent } from "./repo-preparation-agent-factory";

describe("createRepoPreparationAgent", () => {
  it("creates the Dockerized OpenCode agent by default", () => {
    const agent = createRepoPreparationAgent({
      modelID: "gpt-5.5",
      providerID: "openai",
      runtime: "docker",
      sourceDirectory: "/tmp/workspace",
    });

    expect(agent).toBeInstanceOf(OpenCodeRepoPreparationAgent);
  });

  it("creates the Daytona OpenCode agent when Daytona is selected", () => {
    const agent = createRepoPreparationAgent({
      daytonaApiKey: "daytona_key",
      daytonaSnapshot: "makeademo-opencode-dind",
      modelID: "gpt-5.5",
      providerID: "openai",
      runtime: "daytona",
      sourceDirectory: "/tmp/workspace",
    });

    expect(agent).toBeInstanceOf(DaytonaOpenCodeRepoPreparationAgent);
  });

  it("requires a Daytona API key when Daytona is selected", () => {
    expect(() =>
      createRepoPreparationAgent({
        modelID: "gpt-5.5",
        providerID: "openai",
        runtime: "daytona",
        sourceDirectory: "/tmp/workspace",
      }),
    ).toThrow("DAYTONA_API_KEY is required");
  });
});

import { describe, expect, it } from "vitest";

import { DaytonaOpenCodeRepoPreparationAgent } from "./daytona-opencode-repo-preparation-agent";
import { createRepoPreparationAgent } from "./repo-preparation-agent-factory";

describe("createRepoPreparationAgent", () => {
  it("creates the Daytona OpenCode agent", () => {
    const agent = createRepoPreparationAgent({
      daytonaApiKey: "daytona_key",
      daytonaSnapshot: "makeademo-opencode",
      modelID: "gpt-5.5",
      providerApiKey: "openai_key",
      providerID: "openai",
    });

    expect(agent).toBeInstanceOf(DaytonaOpenCodeRepoPreparationAgent);
  });

  it("requires a Daytona API key", () => {
    expect(() =>
      createRepoPreparationAgent({
        modelID: "gpt-5.5",
        providerApiKey: "openai_key",
        providerID: "openai",
      }),
    ).toThrow("DAYTONA_API_KEY is required");
  });
});

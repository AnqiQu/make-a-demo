import { describe, expect, it } from "vitest";

import { DaytonaOpenCodeAgent } from "./daytona-opencode-agent";

describe("DaytonaOpenCodeAgent", () => {
  it("requires Daytona credentials for the unified OpenCode agent", () => {
    expect(
      () =>
        new DaytonaOpenCodeAgent({
          modelID: "gpt-5.5",
          providerApiKey: "openai_key",
          providerID: "openai",
        }),
    ).toThrow("DAYTONA_API_KEY is required for Daytona OpenCode agent runs.");
  });
});

import { describe, expect, it } from "vitest";

import { LlmProjectExplorer } from "./llm-project-explorer";

describe("LlmProjectExplorer", () => {
  it("is an explicit stub until the Explorer agent code is imported", async () => {
    const explorer = new LlmProjectExplorer();

    await expect(
      explorer.exploreProject({
        demoBrief: { keyProductFeatures: ["validation"] },
        repoUrl: "https://github.com/example/app",
        validation: {
          blockedNetworkAttempts: [],
          logs: ["validated"],
          status: "succeeded",
          warnings: [],
        },
      }),
    ).rejects.toThrowError("LlmProjectExplorer is a stub");
  });
});

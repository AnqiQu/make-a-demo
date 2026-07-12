import { describe, expect, it } from "vitest";

import type { DraftCompositeReviewer } from "../../../pipeline/07-compositing/draft-composite-reviewer.interface";
import { DaytonaOpenCodeAgent } from "./daytona-opencode-agent";

const reviewerContract: DraftCompositeReviewer =
  DaytonaOpenCodeAgent.prototype.reviewDraftComposite;

describe("DaytonaOpenCodeAgent", () => {
  it("exposes the canonical Draft Composite reviewer contract", () => {
    expect(typeof reviewerContract).toBe("function");
  });

  it("requires Daytona credentials for the unified OpenCode agent", () => {
    expect(
      () =>
        new DaytonaOpenCodeAgent({
          modelID: "gpt-5.5",
          providerID: "openai",
          providerSecretName: "openai-daytona-secret",
        }),
    ).toThrow("DAYTONA_API_KEY is required for Daytona OpenCode agent runs.");
  });
});

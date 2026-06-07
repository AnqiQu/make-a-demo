import { describe, expect, it } from "vitest";

import { createPreparationFallbackPrompt } from "./preparation-fallback-prompt";

describe("createPreparationFallbackPrompt", () => {
  it("gives the maker's coding agent blockers, assumptions, and suggested changes", () => {
    const prompt = createPreparationFallbackPrompt({
      assumptions: ["OAuth can be bypassed for demo mode"],
      blockers: ["Runtime attempted to call api.example.com"],
      repoUrl: "https://github.com/example/app",
      suggestedChanges: ["Add local fixture data for the dashboard endpoint"],
    });

    expect(prompt).toContain("https://github.com/example/app");
    expect(prompt).toContain("Runtime attempted to call api.example.com");
    expect(prompt).toContain("OAuth can be bypassed for demo mode");
    expect(prompt).toContain(
      "Add local fixture data for the dashboard endpoint",
    );
    expect(prompt).toContain("deterministic browser-accessible demo");
  });
});

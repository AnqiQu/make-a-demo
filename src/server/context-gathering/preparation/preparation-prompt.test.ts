import { describe, expect, it } from "vitest";

import { createPreparationPrompt } from "./preparation-prompt";

describe("createPreparationPrompt", () => {
  it("explains the Demo Run Contract before the maker submits repo details", () => {
    const prompt = createPreparationPrompt();

    expect(prompt).toContain("makeademo.config.json");
    expect(prompt).toContain("demoCommand");
    expect(prompt).toContain("url");
    expect(prompt).toContain("no runtime network access");
    expect(prompt).toContain("without secrets");
    expect(prompt).toContain("deterministic browser-accessible demo");
  });
});

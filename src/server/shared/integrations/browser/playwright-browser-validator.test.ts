import { describe, expect, it } from "vitest";

import { PlaywrightBrowserValidator } from "./playwright-browser-validator";

describe("PlaywrightBrowserValidator", () => {
  it("returns screenshot proof for reachable non-blank pages", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () => fakePage({ bodyText: "Demo app loaded" }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      interactable: true,
      logs: [
        "Loaded http://localhost:3000",
        "Captured screenshot artifact_screenshot",
      ],
      screenshotArtifactId: "artifact_screenshot",
    });
  });

  it("marks blank pages as not interactable", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () => fakePage({ bodyText: "   " }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toMatchObject({
      interactable: false,
      screenshotArtifactId: "artifact_screenshot",
    });
  });
});

function fakePage(input: { bodyText: string }) {
  return {
    async close() {},
    async goto() {},
    async screenshot() {
      return "artifact_screenshot";
    },
    async textContent() {
      return input.bodyText;
    },
  };
}

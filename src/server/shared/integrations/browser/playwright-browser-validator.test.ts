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

  it("marks unreachable pages as not interactable instead of throwing", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "",
          gotoError: new Error("net::ERR_CONNECTION_REFUSED"),
        }),
    });

    await expect(
      validator.validate({ url: "http://127.0.0.1:4173/" }),
    ).resolves.toMatchObject({
      interactable: false,
      logs: [
        "Failed to load http://127.0.0.1:4173/: net::ERR_CONNECTION_REFUSED",
      ],
      screenshotArtifactId: "",
    });
  });

  it("reports browser requests that leave the local runtime boundary", async () => {
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          requestedUrls: [
            "http://localhost:3000/assets/app.js",
            "https://api.realworld.io/articles",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.realworld.io",
          phase: "runtime",
        },
      ],
      interactable: true,
    });
  });
});

function fakePage(input: {
  bodyText: string;
  gotoError?: Error;
  requestedUrls?: string[];
}) {
  return {
    async close() {},
    async goto() {
      if (input.gotoError !== undefined) {
        throw input.gotoError;
      }
    },
    async requestedUrls() {
      return input.requestedUrls ?? [];
    },
    async screenshot() {
      return "artifact_screenshot";
    },
    async textContent() {
      return input.bodyText;
    },
  };
}

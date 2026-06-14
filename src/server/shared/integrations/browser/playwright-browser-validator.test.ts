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
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "api.realworld.io",
          phase: "runtime",
        },
      ],
      interactable: false,
      logs: ["Blocked forbidden browser request to api.realworld.io"],
      screenshotArtifactId: "",
    });
  });

  it("aborts forbidden browser requests during page navigation", async () => {
    const abortedUrls: string[] = [];
    const continuedUrls: string[] = [];
    const validator = new PlaywrightBrowserValidator({
      pageFactory: async () =>
        fakePage({
          bodyText: "Demo app loaded",
          onAbort: (url) => abortedUrls.push(url),
          onContinue: (url) => continuedUrls.push(url),
          requestedUrls: [
            "http://localhost:3000/assets/app.js",
            "https://fonts.googleapis.com/css?family=Inter",
            "https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css",
          ],
        }),
    });

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).resolves.toEqual({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          host: "fonts.googleapis.com",
          phase: "runtime",
        },
        {
          direction: "outbound",
          host: "code.ionicframework.com",
          phase: "runtime",
        },
      ],
      interactable: false,
      logs: [
        "Blocked forbidden browser request to fonts.googleapis.com",
        "Blocked forbidden browser request to code.ionicframework.com",
      ],
      screenshotArtifactId: "",
    });
    expect(continuedUrls).toEqual(["http://localhost:3000/assets/app.js"]);
    expect(abortedUrls).toEqual([
      "https://fonts.googleapis.com/css?family=Inter",
      "https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css",
    ]);
  });
});

function fakePage(input: {
  bodyText: string;
  gotoError?: Error;
  onAbort?: (url: string) => void;
  onContinue?: (url: string) => void;
  requestedUrls?: string[];
}) {
  let routeHandler:
    | ((route: {
        abort: () => Promise<void>;
        continue: () => Promise<void>;
        request: () => { url: () => string };
      }) => Promise<void>)
    | undefined;

  return {
    async close() {},
    async goto() {
      if (input.gotoError !== undefined) {
        throw input.gotoError;
      }
      for (const url of input.requestedUrls ?? []) {
        await routeHandler?.({
          async abort() {
            input.onAbort?.(url);
          },
          async continue() {
            input.onContinue?.(url);
          },
          request() {
            return { url: () => url };
          },
        });
      }
    },
    async requestedUrls() {
      return input.requestedUrls ?? [];
    },
    async screenshot() {
      return "artifact_screenshot";
    },
    async route(_pattern: string, handler: NonNullable<typeof routeHandler>) {
      routeHandler = handler;
    },
    async textContent() {
      return input.bodyText;
    },
  };
}

import { chromium } from "@playwright/test";

import type {
  BrowserValidationInput,
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/04-project-validation/browser-validator.interface";
import type { NetworkAttempt } from "../../../pipeline/04-project-validation/network-isolation-policy";

type BrowserValidationPage = {
  close(): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  screenshot(): Promise<string>;
  route?(
    pattern: string,
    handler: (route: BrowserValidationRoute) => Promise<void>,
  ): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  requestedUrls?(): Promise<string[]>;
};

type BrowserValidationRoute = {
  abort(errorCode?: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string };
};

type BrowserValidationPageFactory = () => Promise<BrowserValidationPage>;

export type PlaywrightBrowserValidatorOptions = {
  pageFactory?: BrowserValidationPageFactory;
};

export class PlaywrightBrowserValidator implements BrowserValidator {
  private readonly pageFactory: BrowserValidationPageFactory;

  constructor(options: PlaywrightBrowserValidatorOptions = {}) {
    this.pageFactory = options.pageFactory ?? createPlaywrightPage;
  }

  async validate(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    const page = await this.pageFactory();

    try {
      const localHost = new URL(input.url).hostname;
      const blockedRequests: NetworkAttempt[] = [];
      await page.route?.("**/*", async (route) => {
        const blockedRequest = readForbiddenBrowserRequest(
          route.request().url(),
          localHost,
        );
        if (blockedRequest !== undefined) {
          blockedRequests.push(blockedRequest);
          await route.abort("blockedbyclient");
          return;
        }

        await route.continue();
      });

      try {
        await page.goto(input.url, {
          timeout: 15_000,
          waitUntil: "domcontentloaded",
        });
      } catch (error) {
        return {
          interactable: false,
          logs: [`Failed to load ${input.url}: ${formatError(error)}`],
          screenshotArtifactId: "",
        };
      }
      if (blockedRequests.length > 0) {
        return {
          blockedNetworkAttempts: dedupeNetworkAttempts(blockedRequests),
          interactable: false,
          logs: dedupeNetworkAttempts(blockedRequests).map(
            (request) => `Blocked forbidden browser request to ${request.host}`,
          ),
          screenshotArtifactId: "",
        };
      }
      const bodyText = (await page.textContent("body")) ?? "";
      const screenshotArtifactId = await page.screenshot();
      const interactable =
        bodyText.trim().length > 0 && !looksLikeRuntimeError(bodyText);
      const blockedNetworkAttempts = findBlockedBrowserRequests(
        input.url,
        page.requestedUrls === undefined ? [] : await page.requestedUrls(),
      );

      return {
        ...(blockedNetworkAttempts.length === 0
          ? {}
          : { blockedNetworkAttempts }),
        interactable,
        logs: [
          `Loaded ${input.url}`,
          `Captured screenshot ${screenshotArtifactId}`,
        ],
        screenshotArtifactId,
      };
    } finally {
      await page.close();
    }
  }
}

async function createPlaywrightPage(): Promise<BrowserValidationPage> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  return {
    async close() {
      await browser.close();
    },
    async goto(url, options) {
      return page.goto(url, options);
    },
    async screenshot() {
      const screenshot = await page.screenshot({ type: "png" });
      return `screenshot:${screenshot.toString("base64")}`;
    },
    async requestedUrls() {
      return requestedUrls;
    },
    async route(pattern, handler) {
      await page.route(pattern, async (route) => {
        await handler({
          abort: (errorCode) => route.abort(errorCode),
          continue: () => route.continue(),
          request: () => ({ url: () => route.request().url() }),
        });
      });
    },
    async textContent(selector) {
      return page.textContent(selector);
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findBlockedBrowserRequests(
  localUrl: string,
  requestedUrls: string[],
): NetworkAttempt[] {
  const localHost = new URL(localUrl).hostname;

  return requestedUrls.flatMap((requestedUrl) => {
    const request = readForbiddenBrowserRequest(requestedUrl, localHost);
    return request === undefined ? [] : [request];
  });
}

function readForbiddenBrowserRequest(
  requestedUrl: string,
  localHost: string,
): NetworkAttempt | undefined {
  try {
    const url = new URL(requestedUrl);
    if (isAllowedRuntimeHost(url.hostname, localHost)) {
      return undefined;
    }

    return {
      direction: "outbound",
      host: url.hostname,
      phase: "runtime",
    };
  } catch {
    return undefined;
  }
}

function dedupeNetworkAttempts(attempts: NetworkAttempt[]): NetworkAttempt[] {
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = `${attempt.direction}:${attempt.phase}:${attempt.host}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isAllowedRuntimeHost(host: string, localHost: string): boolean {
  return (
    host.length === 0 ||
    [localHost, "127.0.0.1", "localhost", "0.0.0.0"].includes(host)
  );
}

function looksLikeRuntimeError(text: string): boolean {
  return /Unhandled Runtime Error|Application error|Internal Server Error|Vite Error/i.test(
    text,
  );
}
